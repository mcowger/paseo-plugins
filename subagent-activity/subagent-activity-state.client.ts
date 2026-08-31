import type {
  PaseoAgentHandle,
  PaseoAgentUpdate,
  PaseoApi,
} from "@getpaseo/client";
import { usePaseo } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import {
  MAX_RECENT_TOOL_CALLS,
  getDescendantTree,
  getLastActivityAt,
  getLatestTimelineTimestamp,
  getProviderSubagentActivities,
  getToolCallActivities,
  type AgentRecord,
  type ProviderSubagentActivity,
  type TimelineEntry,
  type ToolCallActivity,
} from "./subagent-activity.shared";

const AGENT_PAGE_SIZE = 200;
const TIMELINE_PAGE_SIZE = 100;
const AGENT_SUBSCRIPTION_ID = "subagent-activity-agents";
const REFRESH_INTERVAL_MS = 10_000;

export interface ManagedAgentActivity {
  readonly toolCalls: readonly ToolCallActivity[];
  readonly lastActivityAt: string;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface SubagentActivityState {
  readonly agents: readonly AgentRecord[];
  readonly activities: ReadonlyMap<string, ManagedAgentActivity>;
  readonly providerActivities: readonly ProviderSubagentActivity[];
  readonly loading: boolean;
  readonly providerLoading: boolean;
  readonly error: string | null;
  readonly providerError: string | null;
}

const EMPTY_STATE: SubagentActivityState = {
  agents: [],
  activities: new Map(),
  providerActivities: [],
  loading: false,
  providerLoading: false,
  error: null,
  providerError: null,
};

export function useSubagentActivity(
  parentId: string,
  includeArchivedDetails = false,
): SubagentActivityState {
  const paseo = usePaseo();
  const [state, setState] = useState<SubagentActivityState>(EMPTY_STATE);

  useEffect(() => {
    setState(EMPTY_STATE);
    const directory = new Map<string, AgentRecord>();
    const activities = new Map<string, ManagedAgentActivity>();
    const cleanups = new Map<string, () => void>();
    const agentRefreshVersions = new Map<string, number>();
    let disposed = false;
    let refreshingAgents = false;
    let refreshQueued = false;
    let providerRefreshing = false;
    let providerRefreshQueued = false;

    const publish = (partial: Partial<SubagentActivityState> = {}) => {
      if (disposed) return;
      setState((current) => ({
        ...current,
        agents: [...directory.values()],
        activities: new Map(activities),
        ...partial,
      }));
    };

    const getVisibleAgents = () =>
      getDescendantTree([...directory.values()], parentId)
        .map(({ agent }) => agent)
        .filter((agent) => includeArchivedDetails || !agent.archivedAt);

    const refreshAgent = async (agentId: string): Promise<void> => {
      const version = (agentRefreshVersions.get(agentId) ?? 0) + 1;
      agentRefreshVersions.set(agentId, version);
      const existing = activities.get(agentId);
      activities.set(agentId, {
        toolCalls: existing?.toolCalls ?? [],
        lastActivityAt: existing?.lastActivityAt ?? directory.get(agentId)?.updatedAt ?? "",
        loading: true,
        error: null,
      });
      publish();

      try {
        const handle = paseo.agents.ref(agentId);
        const refreshed = await handle.refresh();
        if (disposed || agentRefreshVersions.get(agentId) !== version) return;
        const agent = refreshed?.agent ?? handle.current() ?? directory.get(agentId);
        if (!agent) return;
        directory.set(agent.id, agent);
        const entries = await readRecentTimeline(handle);
        if (disposed || agentRefreshVersions.get(agentId) !== version) return;
        const toolCalls = getToolCallActivities(entries);
        const timelineTimestamp = getLatestTimelineTimestamp(entries);
        activities.set(agentId, {
          toolCalls,
          lastActivityAt: getLastActivityAt(agent, timelineTimestamp),
          loading: false,
          error: null,
        });
        publish();
      } catch (error) {
        if (disposed || agentRefreshVersions.get(agentId) !== version) return;
        const agent = directory.get(agentId);
        activities.set(agentId, {
          toolCalls: existing?.toolCalls ?? [],
          lastActivityAt: existing?.lastActivityAt ?? agent?.updatedAt ?? "",
          loading: false,
          error: errorMessage(error),
        });
        publish();
      }
    };

    const refreshVisibleAgents = async (): Promise<void> => {
      if (disposed) return;
      if (refreshingAgents) {
        refreshQueued = true;
        return;
      }
      refreshingAgents = true;
      for (const agent of getVisibleAgents()) await refreshAgent(agent.id);
      refreshingAgents = false;
      if (!disposed && refreshQueued) {
        refreshQueued = false;
        void refreshVisibleAgents();
      }
    };

    const subscribeToAgent = (agent: AgentRecord) => {
      if (cleanups.has(agent.id) || agent.archivedAt) return;
      const handle = paseo.agents.ref(agent.id);
      const unsubscribe = handle.timeline.subscribe((stream) => {
        if (stream.event.type !== "timeline") return;
        if (stream.event.item.type !== "tool_call") return;
        void refreshAgent(agent.id);
      });
      cleanups.set(agent.id, unsubscribe);
    };

    const syncAgentSubscriptions = () => {
      const visible = new Set(getVisibleAgents().map((agent) => agent.id));
      for (const [agentId, cleanup] of cleanups) {
        if (!visible.has(agentId)) {
          cleanup();
          cleanups.delete(agentId);
        }
      }
      for (const agent of getVisibleAgents()) subscribeToAgent(agent);
    };

    const refreshProviderActivities = async (): Promise<void> => {
      if (disposed) return;
      if (providerRefreshing) {
        providerRefreshQueued = true;
        return;
      }
      providerRefreshing = true;
      publish({ providerLoading: true, providerError: null });
      try {
        const parent = paseo.agents.ref(parentId);
        const entries = await readRecentTimeline(parent);
        if (disposed) return;
        const calls = getToolCallActivities(entries, MAX_RECENT_TOOL_CALLS);
        publish({
          providerActivities: getProviderSubagentActivities(calls),
          providerLoading: false,
          providerError: null,
        });
      } catch (error) {
        if (!disposed) {
          publish({ providerLoading: false, providerError: errorMessage(error) });
        }
      } finally {
        providerRefreshing = false;
        if (!disposed && providerRefreshQueued) {
          providerRefreshQueued = false;
          void refreshProviderActivities();
        }
      }
    };

    const onAgentUpdate = (update: PaseoAgentUpdate) => {
      if (update.kind === "remove") {
        directory.delete(update.agentId);
        activities.delete(update.agentId);
        agentRefreshVersions.delete(update.agentId);
        cleanups.get(update.agentId)?.();
        cleanups.delete(update.agentId);
      } else {
        directory.set(update.agent.id, update.agent);
      }
      syncAgentSubscriptions();
      publish();
      void refreshVisibleAgents();
    };

    const unsubscribeAgents = paseo.agents.subscribe(onAgentUpdate);
    const parentUnsubscribe = paseo.agents.ref(parentId).timeline.subscribe((stream) => {
      if (stream.event.type !== "timeline") return;
      if (stream.event.item.type !== "tool_call") return;
      void refreshProviderActivities();
    });
    const pollTimer = setInterval(() => {
      void refreshVisibleAgents();
      void refreshProviderActivities();
    }, REFRESH_INTERVAL_MS);

    publish({ loading: true, error: null });
    void listAgents(paseo)
      .then((agents) => {
        if (disposed) return;
        for (const agent of agents) directory.set(agent.id, agent);
        syncAgentSubscriptions();
        publish({ loading: false, error: null });
        void refreshVisibleAgents();
        void refreshProviderActivities();
      })
      .catch((error) => {
        if (!disposed) publish({ loading: false, error: errorMessage(error) });
      });

    return () => {
      disposed = true;
      unsubscribeAgents();
      parentUnsubscribe();
      clearInterval(pollTimer);
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
    };
  }, [includeArchivedDetails, paseo, parentId]);

  return state;
}

async function listAgents(paseo: PaseoApi): Promise<AgentRecord[]> {
  const agents: AgentRecord[] = [];
  let cursor: string | undefined;
  do {
    const response = await paseo.agents.list({
      filter: { includeArchived: true },
      page: { limit: AGENT_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      ...(cursor ? {} : { subscribe: { subscriptionId: AGENT_SUBSCRIPTION_ID } }),
    });
    agents.push(...response.entries.map(({ agent }) => agent));
    cursor = response.pageInfo.hasMore ? (response.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return agents;
}

async function readRecentTimeline(
  handle: PaseoAgentHandle,
): Promise<readonly TimelineEntry[]> {
  const response = await handle.timeline.refetch({
    direction: "tail",
    limit: TIMELINE_PAGE_SIZE,
    projection: "projected",
  });
  return response.entries.map(({ item, timestamp }) => ({ item, timestamp }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
