import { usePaseo } from "@getpaseo/plugin/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAgentStream } from "../timeline-events";
import { countTasks, extractLatestTodoSnapshot, type AgentTasksGroup } from "./model";

const AGENT_LIST_LIMIT = 200;
const TIMELINE_LIMIT = 200;
const DEBOUNCE_MS = 400;

export interface WorkspaceTaskGroupsResult {
  readonly groups: readonly AgentTasksGroup[];
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly error: string | null;
  refresh(): void;
}

function sortGroups(groups: AgentTasksGroup[]): AgentTasksGroup[] {
  return groups.sort((a, b) => {
    if (a.counts.inProgress !== b.counts.inProgress) {
      return b.counts.inProgress - a.counts.inProgress;
    }
    if (a.counts.pending !== b.counts.pending) {
      return b.counts.pending - a.counts.pending;
    }
    return Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "");
  });
}

/**
 * The most recently active workspace: the workspace owning the agent with the latest activity.
 * Sidebar items are host-wide and receive no workspace, so this is how a global item picks a
 * target. It follows `agents.subscribe` and refetches on a debounce.
 */
export function useMostRecentWorkspaceId(): string | null {
  const paseo = usePaseo();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const resolve = async () => {
      try {
        const result = await paseo.agents.list({
          filter: { includeArchived: false },
          page: { limit: AGENT_LIST_LIMIT },
        });
        let best: { id: string; at: number } | null = null;
        for (const { agent } of result.entries) {
          const ownerWorkspaceId = agent.workspaceId;
          if (!ownerWorkspaceId) continue;
          const at = Math.max(
            Date.parse(agent.lastUserMessageAt || "") || 0,
            Date.parse(agent.updatedAt || "") || 0,
          );
          if (!best || at > best.at) best = { id: ownerWorkspaceId, at };
        }
        if (!cancelled) setWorkspaceId(best?.id ?? null);
      } catch {
        if (!cancelled) setWorkspaceId(null);
      }
    };

    void resolve();
    const unsubscribe = paseo.agents.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!cancelled) void resolve();
      }, DEBOUNCE_MS);
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [paseo]);

  return workspaceId;
}

/**
 * The current todo list of every agent in one workspace. Fetches on mount and on workspace change,
 * then keeps each agent's snapshot current through its timeline subscription.
 */
export function useWorkspaceTaskGroups(workspaceId: string | null): WorkspaceTaskGroupsResult {
  const paseo = usePaseo();
  const [groups, setGroups] = useState<readonly AgentTasksGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchGroups = useCallback(async () => {
    if (!workspaceId) {
      if (mountedRef.current) {
        setGroups([]);
        setError(null);
        setLoading(false);
        setRefreshing(false);
      }
      return;
    }
    try {
      setError(null);
      const result = await paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: AGENT_LIST_LIMIT },
      });
      const workspaceAgents = result.entries
        .map((entry) => entry.agent)
        .filter((agent) => agent.workspaceId === workspaceId);

      const resolved = await Promise.all(
        workspaceAgents.map(async (agent): Promise<AgentTasksGroup> => {
          let tasks = [] as ReturnType<typeof extractLatestTodoSnapshot>;
          try {
            const timeline = await paseo.agents.ref(agent.id).timeline.refetch({
              direction: "tail",
              limit: TIMELINE_LIMIT,
              projection: "projected",
            });
            tasks = extractLatestTodoSnapshot(
              timeline.entries.map((entry) => entry.item) as AgentTimelineItem[],
            );
          } catch {
            tasks = [];
          }
          return {
            agentId: agent.id,
            agentTitle: agent.title || `Agent ${agent.id.slice(0, 8)}`,
            isMain: !agent.labels["paseo.parent-agent-id"]?.trim(),
            provider: agent.provider,
            status: agent.status,
            updatedAt: agent.updatedAt,
            tasks,
            counts: countTasks(tasks),
          };
        }),
      );

      if (mountedRef.current) setGroups(sortGroups(resolved));
    } catch (err: unknown) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load workspace tasks.");
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [paseo, workspaceId]);

  useEffect(() => {
    setLoading(true);
    void fetchGroups();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = paseo.agents.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (mountedRef.current) void fetchGroups();
      }, DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [paseo, fetchGroups]);

  useEffect(() => {
    if (groups.length === 0) return;
    const unsubscribers = groups.map((group) =>
      paseo.agents.ref(group.agentId).timeline.subscribe((stream) => {
        if (!isAgentStream(stream)) {
          void fetchGroups();
          return;
        }
        if (stream.event.type !== "timeline" || stream.event.item.type !== "todo") return;
        const tasks = extractLatestTodoSnapshot([stream.event.item]);
        setGroups((current) =>
          current.map((candidate) =>
            candidate.agentId === group.agentId
              ? { ...candidate, tasks, counts: countTasks(tasks), updatedAt: stream.timestamp }
              : candidate,
          ),
        );
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [groups, fetchGroups, paseo]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void fetchGroups();
  }, [fetchGroups]);

  return { groups, loading, refreshing, error, refresh };
}
