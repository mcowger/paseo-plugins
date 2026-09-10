import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { PiTasksPopover } from "./pi-tasks";
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

function taskPillLabel(agentId: string): string {
  const tasks = getPiTaskSnapshot(agentId).tasks?.filter((task) => task.status !== "completed");
  const current = tasks?.find((task) => task.status === "in_progress") ?? tasks?.[0];
  return current ? `${tasks?.length ?? 0} active · ${current.text}` : "Pi tasks";
}

function addTaskPill(
  client: PluginClientContext,
  workspaceId: string,
  agentId: string,
): PluginButtonRegistration {
  return client.addComposerPill({
    id: "pi-tasks",
    workspaceId,
    agentId,
    button: {
      title: "Open active Pi tasks",
      icon: "ListChecks",
      label: taskPillLabel(agentId),
      behavior: { kind: "popover", Content: PiTasksPopover },
    },
  });
}

export function contributeClient(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  const trackerCleanups = new Map<string, () => void>();
  const workspaceIds = new Map<string, string>();
  let stopped = false;

  const remove = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
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
      const snapshot = getPiTaskSnapshot(agent.id);
      if (stopped || !hasActiveSnapshot(snapshot)) {
        pills.get(agent.id)?.remove();
        pills.delete(agent.id);
        return;
      }
      const existing = pills.get(agent.id);
      if (existing) {
        existing.update({ label: taskPillLabel(agent.id) });
        return;
      }
      pills.set(agent.id, addTaskPill(client, workspaceId, agent.id));
    });
    trackerCleanups.set(agent.id, () => {
      unsubscribe();
      stopWatching();
    });
    if (hasActiveSnapshot(getPiTaskSnapshot(agent.id))) {
      pills.set(agent.id, addTaskPill(client, workspaceId, agent.id));
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
    for (const agentId of new Set([...pills.keys(), ...trackerCleanups.keys()])) {
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
