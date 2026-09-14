import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { useEffect, useState } from "react";

import {
  getPiRuntimeSettingsRpc,
  updatePiRuntimeSettingRpc,
  type PiRuntimeSetting,
} from "../shared/runtime-settings.js";
import { PI_PROVIDER_ID } from "../shared/tool-policy.js";

const AGENT_PAGE_SIZE = 200;
const AGENT_SUBSCRIPTION_ID = "pi-runtime-settings-pill-agents";

type AgentRegistration = {
  id: string;
  provider: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
  status?: "initializing" | "idle" | "running" | "error" | "closed";
};

type SettingsState =
  | { status: "loading" }
  | { status: "ready"; settings: readonly PiRuntimeSetting[] }
  | { status: "error" };

let settingsByAgent = new Map<string, SettingsState>();

function settingGlyph(setting: PiRuntimeSetting): string {
  if (!setting.value) return "○";
  return setting.id === "fastMode" ? "⚡" : "●";
}

function pillPresentation(agentId: string): { label: string; title: string } {
  const state = settingsByAgent.get(agentId);
  if (!state || state.status === "loading") return { label: "…", title: "Loading Pi runtime settings" };
  if (state.status === "error") return { label: "!", title: "Pi runtime settings are unavailable" };
  return {
    label: state.settings.map(settingGlyph).join(" "),
    title: `Pi settings: ${state.settings.map((setting) => `${setting.label} ${setting.value ? "on" : "off"}`).join(", ")}`,
  };
}

function RuntimeSettingsPopover(props: PluginButtonContentProps & {
  client: PluginClientContext;
  onSettingsChange(agentId: string): void;
}) {
  const toast = useToast();
  const agentId = props.context === "agent" ? props.agentId : null;
  const [state, setState] = useState<SettingsState>(agentId ? settingsByAgent.get(agentId) ?? { status: "loading" } : { status: "error" });

  useEffect(() => {
    if (!agentId) return;
    void loadSettings(props.client, agentId, setState);
  }, [agentId, props.client]);

  const update = async (setting: PiRuntimeSetting) => {
    if (!agentId) return;
    const previous = state;
    const settings = state.status === "ready"
      ? state.settings.map((item) => item.id === setting.id ? { ...item, value: !item.value } : item)
      : [];
    const optimistic: SettingsState = { status: "ready", settings };
    settingsByAgent.set(agentId, optimistic);
    setState(optimistic);
    props.onSettingsChange(agentId);
    try {
      const response = await props.client.rpc(updatePiRuntimeSettingRpc, {
        agentId,
        id: setting.id,
        value: !setting.value,
      });
      const ready: SettingsState = { status: "ready", settings: response.settings };
      settingsByAgent.set(agentId, ready);
      setState(ready);
      props.onSettingsChange(agentId);
    } catch {
      settingsByAgent.set(agentId, previous);
      setState(previous);
      props.onSettingsChange(agentId);
      toast.error(`Couldn't update ${setting.label}`);
    }
  };

  return (
    <View style={{ minWidth: 260, padding: 12 }}>
      <Text style={{ color: props.theme.colors.foreground, fontWeight: "600", marginBottom: 4 }}>Pi settings</Text>
      <Text style={{ color: props.theme.colors.foregroundMuted, marginBottom: 10 }}>Applies to this session only.</Text>
      {state.status === "loading" && <Text style={{ color: props.theme.colors.foregroundMuted }}>Loading settings…</Text>}
      {state.status === "error" && <Text style={{ color: props.theme.colors.foregroundMuted }}>Settings aren't available for this session.</Text>}
      {state.status === "ready" && state.settings.map((setting) => (
        <Pressable
          key={setting.id}
          accessibilityRole="switch"
          accessibilityLabel={setting.label}
          accessibilityState={{ checked: setting.value }}
          onPress={() => void update(setting)}
          style={{ alignItems: "center", flexDirection: "row", gap: 10, paddingVertical: 8 }}
        >
          <Icon name={setting.value ? "CircleCheck" : "Circle"} size={18} color={setting.value ? props.theme.colors.foreground : props.theme.colors.foregroundMuted} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: props.theme.colors.foreground }}>{setting.label}</Text>
            <Text style={{ color: props.theme.colors.foregroundMuted }}>{setting.description}</Text>
          </View>
          <Text style={{ color: props.theme.colors.foregroundMuted }}>{setting.value ? "On" : "Off"}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function contributePiRuntimeSettingsPill(client: PluginClientContext): () => void {
  const agents = new Map<string, AgentRegistration>();
  const pills = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  settingsByAgent = new Map();

  const remove = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    agents.delete(agentId);
    settingsByAgent.delete(agentId);
  };
  const update = (agentId: string) => pills.get(agentId)?.update(pillPresentation(agentId));
  const register = (agent: AgentRegistration) => {
    if (stopped || agent.provider !== PI_PROVIDER_ID || !agent.workspaceId || agent.archivedAt || agent.status === "closed") {
      remove(agent.id);
      return;
    }
    agents.set(agent.id, agent);
    if (!pills.has(agent.id)) {
      const Content = (props: PluginButtonContentProps) => (
        <RuntimeSettingsPopover {...props} client={client} onSettingsChange={update} />
      );
      settingsByAgent.set(agent.id, { status: "loading" });
      pills.set(agent.id, client.addComposerPill({
        id: "pi-runtime-settings",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          ...pillPresentation(agent.id),
          icon: "SlidersHorizontal",
          behavior: { kind: "popover", Content },
        },
      }));
      void loadSettings(client, agent.id, () => {
        if (!stopped && agents.has(agent.id)) update(agent.id);
      });
    } else update(agent.id);
  };

  const unsubscribe = client.paseo.agents.subscribe((event) => {
    if (event.kind === "remove") remove(event.agentId);
    else register(event.agent);
  });
  void listAgents(client).then((items) => { if (!stopped) items.forEach(register); }).catch(() => undefined);

  return () => {
    stopped = true;
    unsubscribe();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    agents.clear();
    settingsByAgent = new Map();
  };
}

async function loadSettings(
  client: PluginClientContext,
  agentId: string,
  onChange: (state: SettingsState) => void,
): Promise<void> {
  try {
    const response = await client.rpc(getPiRuntimeSettingsRpc, { agentId });
    const state: SettingsState = { status: "ready", settings: response.settings };
    settingsByAgent.set(agentId, state);
    onChange(state);
  } catch {
    const state: SettingsState = { status: "error" };
    settingsByAgent.set(agentId, state);
    onChange(state);
  }
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
    cursor = response.pageInfo.hasMore ? response.pageInfo.nextCursor ?? undefined : undefined;
  } while (cursor);
  return agents;
}
