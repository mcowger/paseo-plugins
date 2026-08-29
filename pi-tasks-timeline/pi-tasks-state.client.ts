import type { PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { useSyncExternalStore } from "react";
import type { PiTask } from "./pi-tasks";
import { hasActivePiTasks, parsePiTodoToolCall } from "./pi-tasks";

const TIMELINE_PAGE_SIZE = 200;
const TASK_REFRESH_INTERVAL_MS = 10_000;

export interface PiTaskSnapshot {
  readonly tasks: readonly PiTask[] | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_SNAPSHOT: PiTaskSnapshot = {
  tasks: null,
  loading: false,
  error: null,
};

const snapshots = new Map<string, PiTaskSnapshot>();
const listeners = new Map<string, Set<() => void>>();

function publish(agentId: string): void {
  for (const listener of listeners.get(agentId) ?? []) listener();
}

function setSnapshot(agentId: string, snapshot: PiTaskSnapshot): void {
  snapshots.set(agentId, snapshot);
  publish(agentId);
}

export function getPiTaskSnapshot(agentId: string): PiTaskSnapshot {
  return snapshots.get(agentId) ?? EMPTY_SNAPSHOT;
}

export function subscribePiTaskSnapshot(agentId: string, listener: () => void): () => void {
  const agentListeners = listeners.get(agentId) ?? new Set<() => void>();
  agentListeners.add(listener);
  listeners.set(agentId, agentListeners);
  return () => {
    agentListeners.delete(listener);
    if (agentListeners.size === 0) listeners.delete(agentId);
  };
}

export function usePiTaskSnapshot(agentId: string): PiTaskSnapshot {
  return useSyncExternalStore(
    (listener) => subscribePiTaskSnapshot(agentId, listener),
    () => getPiTaskSnapshot(agentId),
    () => EMPTY_SNAPSHOT,
  );
}

function latestTasks(entries: readonly { item: AgentTimelineItem }[]): PiTask[] | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index]?.item;
    if (item?.type !== "tool_call") continue;
    const tasks = parsePiTodoToolCall(item);
    if (tasks !== undefined) return tasks;
  }
}

async function readLatestTasks(paseo: PaseoApi, agentId: string): Promise<PiTask[] | null> {
  const timeline = paseo.agents.ref(agentId).timeline;
  const visitedCursors = new Set<string>();
  let response = await timeline.refetch({
    direction: "tail",
    limit: TIMELINE_PAGE_SIZE,
    projection: "projected",
  });

  while (true) {
    const tasks = latestTasks(response.entries);
    if (tasks !== undefined) return tasks;
    if (!response.hasOlder || !response.startCursor) return null;

    const cursorKey = `${response.startCursor.epoch}:${response.startCursor.seq}`;
    if (visitedCursors.has(cursorKey)) return null;
    visitedCursors.add(cursorKey);
    response = await timeline.refetch({
      direction: "before",
      cursor: response.startCursor,
      limit: TIMELINE_PAGE_SIZE,
      projection: "projected",
    });
  }
}

export type AgentStatus = "initializing" | "idle" | "running" | "error" | "closed";

interface AgentTaskTracker {
  stopped: boolean;
  refreshing: boolean;
  refreshQueued: boolean;
  pollTimer: ReturnType<typeof setInterval> | null;
  status: AgentStatus;
  refresh: () => void;
  setPolling: (polling: boolean) => void;
  unsubscribe: () => void;
}

const trackers = new Map<string, AgentTaskTracker>();

export function watchPiTasks(
  paseo: PaseoApi,
  agentId: string,
  status: AgentStatus = "idle",
): () => void {
  const existing = trackers.get(agentId);
  if (existing) return () => stopTracker(agentId, existing);

  const tracker: AgentTaskTracker = {
    stopped: false,
    refreshing: false,
    refreshQueued: false,
    pollTimer: null,
    status,
    refresh: () => {},
    setPolling: () => {},
    unsubscribe: () => {},
  };
  trackers.set(agentId, tracker);
  setSnapshot(agentId, { tasks: null, loading: true, error: null });

  const refresh = async (): Promise<void> => {
    if (tracker.stopped) return;
    if (tracker.refreshing) {
      tracker.refreshQueued = true;
      return;
    }
    tracker.refreshing = true;
    setSnapshot(agentId, { ...getPiTaskSnapshot(agentId), loading: true, error: null });
    try {
      const tasks = await readLatestTasks(paseo, agentId);
      if (!tracker.stopped) {
        setSnapshot(agentId, { tasks, loading: false, error: null });
        setPolling(tracker.status === "running" || (tasks !== null && hasActivePiTasks(tasks)));
      }
    } catch (error) {
      if (!tracker.stopped) {
        const message = error instanceof Error ? error.message : String(error);
        setSnapshot(agentId, {
          ...getPiTaskSnapshot(agentId),
          loading: false,
          error: message,
        });
      }
    } finally {
      tracker.refreshing = false;
      if (!tracker.stopped && tracker.refreshQueued) {
        tracker.refreshQueued = false;
        void refresh();
      }
    }
  };

  tracker.refresh = () => {
    void refresh();
  };
  const setPolling = (polling: boolean) => {
    if (polling && tracker.pollTimer === null) {
      tracker.pollTimer = setInterval(tracker.refresh, TASK_REFRESH_INTERVAL_MS);
    } else if (!polling && tracker.pollTimer !== null) {
      clearInterval(tracker.pollTimer);
      tracker.pollTimer = null;
    }
  };
  tracker.setPolling = setPolling;
  setPolling(status === "running");

  tracker.unsubscribe = paseo.agents.ref(agentId).timeline.subscribe((event) => {
    if (event.event.type !== "timeline" || event.event.item.type !== "tool_call") return;
    if (parsePiTodoToolCall(event.event.item) === undefined) return;
    void refresh();
  });
  void refresh();

  return () => stopTracker(agentId, tracker);
}

export function updatePiTaskAgentStatus(agentId: string, status: AgentStatus): void {
  const tracker = trackers.get(agentId);
  if (!tracker) return;
  tracker.status = status;
  const polling = status === "running" || hasActiveSnapshot(getPiTaskSnapshot(agentId));
  tracker.setPolling(polling);
  if (polling) tracker.refresh();
}

function stopTracker(agentId: string, tracker: AgentTaskTracker): void {
  if (tracker.stopped) return;
  tracker.stopped = true;
  tracker.unsubscribe();
  tracker.setPolling(false);
  tracker.refreshQueued = false;
  if (trackers.get(agentId) === tracker) trackers.delete(agentId);
  snapshots.delete(agentId);
  publish(agentId);
}

export function hasActiveSnapshot(snapshot: PiTaskSnapshot): boolean {
  return snapshot.tasks !== null && hasActivePiTasks(snapshot.tasks);
}

export function activeTasks(tasks: readonly PiTask[] | null): readonly PiTask[] {
  return tasks?.filter((task) => task.status !== "completed") ?? [];
}
