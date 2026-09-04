import type { PluginClientContext } from "@getpaseo/plugin";
import { PiTasksPill } from "./pi-tasks";
import { openPiTasksPopup } from "./pi-tasks-popup";
import {
  getPiTaskSnapshot,
  hasActiveSnapshot,
  subscribePiTaskSnapshot,
  updatePiTaskAgentStatus,
  watchPiTasks,
} from "./pi-tasks-state";

const AGENT_PAGE_SIZE = 200;
const AGENT_SUBSCRIPTION_ID = "pi-tasks-agents";

type AgentRegistration = {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
  status?: "initializing" | "idle" | "running" | "error" | "closed";
};

export function contributeClient(client: PluginClientContext) {
  const pillRemovers = new Map<string, () => void>();
  const trackerCleanups = new Map<string, () => void>();
  const workspaceIds = new Map<string, string>();
  let stopped = false;

  const remove = (agentId: string) => {
    pillRemovers.get(agentId)?.();
    pillRemovers.delete(agentId);
    trackerCleanups.get(agentId)?.();
    trackerCleanups.delete(agentId);
    workspaceIds.delete(agentId);
  };

  const register = (agent: AgentRegistration) => {
    if (stopped || !agent.workspaceId || agent.archivedAt) {
      remove(agent.id);
      return;
    }
    const workspaceId = agent.workspaceId;
    if (workspaceIds.get(agent.id) === workspaceId) {
      updatePiTaskAgentStatus(agent.id, agent.status ?? "idle");
      return;
    }
    remove(agent.id);
    workspaceIds.set(agent.id, workspaceId);

    const stopWatching = watchPiTasks(client.paseo, agent.id, agent.status ?? "idle");
    const unsubscribe = subscribePiTaskSnapshot(agent.id, () => {
      if (stopped || !hasActiveSnapshot(getPiTaskSnapshot(agent.id))) {
        pillRemovers.get(agent.id)?.();
        pillRemovers.delete(agent.id);
        return;
      }
      if (pillRemovers.has(agent.id)) return;
      const removePill = client.addComposerPill({
        id: "pi-tasks",
        title: "Open active Pi tasks",
        workspaceId,
        agentId: agent.id,
        Component: PiTasksPill,
        onPress() {
          openPiTasksPopup({
            agentId: agent.id,
            openPanel: () => client.openPanel("pi-tasks", { workspaceId, agentId: agent.id }),
          });
        },
      });
      pillRemovers.set(agent.id, removePill);
    });
    trackerCleanups.set(agent.id, () => {
      unsubscribe();
      stopWatching();
    });
    if (hasActiveSnapshot(getPiTaskSnapshot(agent.id))) {
      unsubscribe();
      const removePill = client.addComposerPill({
        id: "pi-tasks",
        title: "Open active Pi tasks",
        workspaceId,
        agentId: agent.id,
        Component: PiTasksPill,
        onPress() {
          openPiTasksPopup({
            agentId: agent.id,
            openPanel: () => client.openPanel("pi-tasks", { workspaceId, agentId: agent.id }),
          });
        },
      });
      pillRemovers.set(agent.id, removePill);
    }
  };

  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") remove(update.agentId);
    else register(update.agent);
  });

  void listAgents(client)
    .then((agents) => {
      if (stopped) return;
      for (const agent of agents) register(agent);
    })
    .catch(() => undefined);

  return () => {
    stopped = true;
    unsubscribeAgents();
    for (const agentId of new Set([...pillRemovers.keys(), ...trackerCleanups.keys()])) {
      remove(agentId);
    }
  };
}

async function listAgents(client: PluginClientContext): Promise<AgentRegistration[]> {
  const agents: AgentRegistration[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.paseo.agents.list({
      filter: { includeArchived: false },
      page: { limit: AGENT_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      ...(cursor ? {} : { subscribe: { subscriptionId: AGENT_SUBSCRIPTION_ID } }),
    });
    agents.push(...response.entries.map(({ agent }) => agent));
    cursor = response.pageInfo.hasMore ? (response.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return agents;
}
