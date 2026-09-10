import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

import { PI_PROVIDER_ID } from "../shared/preset-settings.js";

const PAGE_SIZE = 200;
const SUBSCRIPTION_ID = "pi-runtime-settings-agents";

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

function makeMenu(
  agent: { features?: unknown },
  send: (text: string) => Promise<void>,
) {
  const toggle = (id: string, label: string, command: string, value: boolean | undefined) => ({
    kind: "item" as const,
    id: `${id}-${value === true ? "off" : "on"}`,
    title: `${value === true ? "Disable" : "Enable"} ${label}`,
    behavior: { kind: "action" as const, onPress: () => send(`/settings ${command} ${value === true ? "off" : "on"}`) },
  });
  return [
    toggle("auto-compaction", "auto-compaction", "auto-compaction", settingValue(agent, "autoCompaction")),
    toggle("auto-retry", "auto-retry", "auto-retry", settingValue(agent, "autoRetry")),
  ];
}

export function contributeRuntimeSettingsPills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const workspaceIds = new Map<string, string>();
  const agents = new Map<string, ReturnType<typeof client.paseo.agents.ref>>();
  let stopped = false;

  const remove = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    agents.delete(agentId);
    workspaceIds.delete(agentId);
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
      const handle = agents.get(agent.id);
      if (!handle) {
        remove(agent.id);
      } else {
        pills.get(agent.id)?.update({
          behavior: { kind: "menu", items: makeMenu(agent, (text) => handle.send(text)) },
        });
      }
      return;
    }
    remove(agent.id);
    const handle = client.paseo.agents.ref(agent.id);
    workspaceIds.set(agent.id, agent.workspaceId);
    agents.set(agent.id, handle);
    pills.set(agent.id, client.addComposerPill({
      id: "pi-runtime-settings",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "Pi runtime settings",
        icon: "Settings2",
        label: "Pi settings",
        behavior: { kind: "menu", items: makeMenu(agent, (text) => handle.send(text)) },
      },
    }));
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
    agents.clear();
    workspaceIds.clear();
  };
}
