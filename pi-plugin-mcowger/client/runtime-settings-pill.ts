import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

import { PI_PROVIDER_ID } from "../shared/preset-settings.js";

const PAGE_SIZE = 200;
const SUBSCRIPTION_ID = "pi-runtime-settings-agents";

type RuntimeState = {
  autoCompaction: boolean;
  autoRetry: boolean;
};

function isPiAgent(agent: { provider?: string }): boolean {
  return agent.provider === PI_PROVIDER_ID;
}

function settingValue(agent: { features?: unknown }, id: string): boolean | undefined {
  const features = agent.features;
  if (!Array.isArray(features)) return undefined;
  const feature = features.find(
    (candidate): candidate is { id: string; value?: unknown } =>
      typeof candidate === "object" && candidate !== null &&
      (candidate as { id?: unknown }).id === id,
  );
  return typeof feature?.value === "boolean" ? feature.value : undefined;
}

function stateFromAgent(agent: { features?: unknown }, previous?: RuntimeState): RuntimeState {
  return {
    autoCompaction: settingValue(agent, "autoCompaction") ?? previous?.autoCompaction ?? true,
    autoRetry: settingValue(agent, "autoRetry") ?? previous?.autoRetry ?? true,
  };
}

function makeMenu(
  state: RuntimeState,
  send: (setting: keyof RuntimeState, value: boolean) => Promise<void>,
  update: () => void,
) {
  const toggle = (
    id: keyof RuntimeState,
    label: string,
    icon: string,
  ) => {
    const value = state[id];
    return {
      kind: "item" as const,
      id: `${id}-${value ? "on" : "off"}`,
      title: `${label}: ${value ? "On" : "Off"}`,
      icon,
      behavior: {
        kind: "action" as const,
        onPress: async () => {
          await send(id, !value);
          state[id] = !value;
          update();
        },
      },
    };
  };
  return [
    toggle("autoCompaction", "Auto-compaction", "Minimize2"),
    toggle("autoRetry", "Auto-retry", "RotateCw"),
  ];
}

export function contributeRuntimeSettingsPills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const states = new Map<string, RuntimeState>();
  const workspaceIds = new Map<string, string>();
  const agents = new Map<string, ReturnType<typeof client.paseo.agents.ref>>();
  let stopped = false;

  const remove = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    states.delete(agentId);
    agents.delete(agentId);
    workspaceIds.delete(agentId);
  };

  const update = (agentId: string) => {
    const pill = pills.get(agentId);
    const state = states.get(agentId);
    const handle = agents.get(agentId);
    if (!pill || !state || !handle) return;
    pill.update({
      behavior: {
        kind: "menu",
        items: makeMenu(
          state,
          (setting, value) => handle.send(`/settings ${setting === "autoCompaction" ? "auto-compaction" : "auto-retry"} ${value ? "on" : "off"}`),
          () => update(agentId),
        ),
      },
    });
  };

  const register = (agent: {
    id: string;
    workspaceId?: string | null;
    archivedAt?: string | null;
    provider?: string;
    features?: unknown;
  }) => {
    if (stopped || !agent.workspaceId || agent.archivedAt || !isPiAgent(agent)) {
      remove(agent.id);
      return;
    }
    if (workspaceIds.get(agent.id) === agent.workspaceId) {
      states.set(agent.id, stateFromAgent(agent, states.get(agent.id)));
      update(agent.id);
      return;
    }
    remove(agent.id);
    const handle = client.paseo.agents.ref(agent.id);
    workspaceIds.set(agent.id, agent.workspaceId);
    agents.set(agent.id, handle);
    states.set(agent.id, stateFromAgent(agent));
    pills.set(agent.id, client.addComposerPill({
      id: "pi-runtime-settings",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "Pi runtime settings",
        icon: "Settings2",
        label: "Pi settings",
        behavior: { kind: "menu", items: [] },
      },
    }));
    update(agent.id);
  };

  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") remove(update.agentId);
    else register(update.agent);
  });

  void (async () => {
    let cursor: string | undefined;
    do {
      const page = await client.paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
        ...(cursor ? {} : { subscribe: { subscriptionId: SUBSCRIPTION_ID } }),
      });
      page.entries.forEach(({ agent }) => register(agent));
      cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
    } while (cursor && !stopped);
  })().catch((error: unknown) => {
    console.warn(
      "[pi-plugin-mcowger] Failed to list agents for runtime settings pills:",
      error,
    );
  });

  return () => {
    stopped = true;
    unsubscribeAgents();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    states.clear();
    agents.clear();
    workspaceIds.clear();
  };
}
