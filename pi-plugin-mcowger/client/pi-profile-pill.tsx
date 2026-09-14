import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Text, View } from "react-native";

import {
  getPiActiveProfileRpc,
  PI_PROVIDER_ID,
  syncPiToolPolicyProfileMarkersRpc,
  type PiProfileSummary,
} from "../shared/tool-policy.js";
import { resolvePiProfile, type PiProfileResolution } from "./pi-profile-indicator.js";

const AGENT_PAGE_SIZE = 200;
const AGENT_SUBSCRIPTION_ID = "pi-profile-pill-agents";
const MAX_PILL_LABEL_LENGTH = 24;

type AgentRegistration = {
  id: string;
  provider: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
  status?: "initializing" | "idle" | "running" | "error" | "closed";
};

type ProfileState =
  | { status: "loading" }
  | { status: "ready"; profiles: readonly PiProfileSummary[] }
  | { status: "error" };

type ActiveProfileState =
  | { status: "loading" }
  | { status: "ready"; profileId: string | null }
  | { status: "error" };

let currentProfileState: ProfileState = { status: "loading" };
let currentActiveProfiles = new Map<string, ActiveProfileState>();

function resolutionFor(agentId: string): PiProfileResolution | null {
  if (currentProfileState.status !== "ready") return null;
  const activeProfile = currentActiveProfiles.get(agentId);
  if (!activeProfile || activeProfile.status !== "ready") return null;
  return resolvePiProfile(activeProfile.profileId, currentProfileState.profiles);
}

function shortenLabel(value: string): string {
  if (value.length <= MAX_PILL_LABEL_LENGTH) return value;
  return `${value.slice(0, MAX_PILL_LABEL_LENGTH - 1)}…`;
}

function profilePresentation(agentId: string): { label: string; title: string } {
  if (currentProfileState.status === "loading") {
    return { label: "NA", title: "Loading saved Pi profiles" };
  }
  if (currentProfileState.status === "error") {
    return { label: "NA", title: "Saved Pi profiles could not be loaded" };
  }

  const activeProfile = currentActiveProfiles.get(agentId);
  if (!activeProfile || activeProfile.status === "loading") {
    return { label: "NA", title: "Loading the active Pi profile" };
  }
  if (activeProfile.status === "error") {
    return { label: "NA", title: "The active Pi profile could not be loaded" };
  }

  const resolution = resolutionFor(agentId);
  if (!resolution) return { label: "NA", title: "The active Pi profile is unknown" };
  switch (resolution.kind) {
    case "matched":
      return {
        label: shortenLabel(resolution.profile.name),
        title: `Active Pi profile: ${resolution.profile.name}`,
      };
    case "not-identified":
      return {
        label: "NA",
        title: "Paseo did not provide an active Pi profile identity",
      };
    case "unknown":
      return {
        label: "NA",
        title: "The active Pi profile is no longer in the saved profile list",
      };
  }
}

function resolutionText(agentId: string): string {
  if (currentProfileState.status === "error") {
    return "Paseo could not load the saved Pi profile list.";
  }
  const activeProfile = currentActiveProfiles.get(agentId);
  if (!activeProfile || activeProfile.status === "loading") {
    return "Checking the exact profile identity for this agent.";
  }
  if (activeProfile.status === "error") {
    return "Paseo could not read the exact profile identity for this agent.";
  }

  const resolution = resolutionFor(agentId);
  if (!resolution) return "The exact profile identity is not available.";
  switch (resolution.kind) {
    case "matched":
      return `This session was opened with the ${resolution.profile.name} profile.`;
    case "not-identified":
      return "This session did not provide a saved profile identity. No profile was inferred from model settings.";
    case "unknown":
      return "The session provided a profile identity, but that profile is no longer in the saved profile list.";
  }
}

function ProfilePillPopover(props: PluginButtonContentProps) {
  const agentId = props.context === "agent" ? props.agentId : null;
  const resolution = agentId ? resolutionFor(agentId) : null;
  const title = resolution?.kind === "matched" ? resolution.profile.name : "Active Pi profile";
  return (
    <View style={{ padding: 12, minWidth: 240 }}>
      <Text style={{ color: props.theme.colors.foreground, fontWeight: "600", marginBottom: 6 }}>{title}</Text>
      <Text style={{ color: props.theme.colors.foregroundMuted }}>
        {agentId ? resolutionText(agentId) : "This pill is only available for an agent."}
      </Text>
    </View>
  );
}

function updatePill(
  pills: ReadonlyMap<string, PluginButtonRegistration>,
  agentId: string,
): void {
  const pill = pills.get(agentId);
  if (!pill) return;
  pill.update(profilePresentation(agentId));
}

function removeAgent(
  agentId: string,
  agents: Map<string, AgentRegistration>,
  pills: Map<string, PluginButtonRegistration>,
): void {
  pills.get(agentId)?.remove();
  pills.delete(agentId);
  agents.delete(agentId);
  currentActiveProfiles.delete(agentId);
}

export function contributePiProfilePill(client: PluginClientContext): () => void {
  const agents = new Map<string, AgentRegistration>();
  const pills = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  currentProfileState = { status: "loading" };
  currentActiveProfiles = new Map();

  const register = (agent: AgentRegistration) => {
    if (
      stopped ||
      agent.provider !== PI_PROVIDER_ID ||
      !agent.workspaceId ||
      agent.archivedAt ||
      agent.status === "closed"
    ) {
      removeAgent(agent.id, agents, pills);
      return;
    }

    const previous = agents.get(agent.id);
    agents.set(agent.id, agent);
    const existing = pills.get(agent.id);
    if (existing) {
      updatePill(pills, agent.id);
      const activeProfile = currentActiveProfiles.get(agent.id);
      if (
        previous?.status === "initializing" &&
        agent.status !== "initializing" &&
        (activeProfile?.status === "error" ||
          (activeProfile?.status === "ready" && activeProfile.profileId === null))
      ) {
        currentActiveProfiles.set(agent.id, { status: "loading" });
        updatePill(pills, agent.id);
        void loadActiveProfile(client, agent.id, agents, pills, () => stopped);
      }
      return;
    }

    currentActiveProfiles.set(agent.id, { status: "loading" });
    const workspaceId = agent.workspaceId;
    pills.set(agent.id, client.addComposerPill({
      id: "pi-profile",
      workspaceId,
      agentId: agent.id,
      button: {
        ...profilePresentation(agent.id),
        icon: "UserRound",
        behavior: { kind: "popover", Content: ProfilePillPopover },
      },
    }));
    void loadActiveProfile(client, agent.id, agents, pills, () => stopped);
  };

  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") removeAgent(update.agentId, agents, pills);
    else register(update.agent);
  });

  void listAgents(client)
    .then((listedAgents) => {
      if (!stopped) listedAgents.forEach(register);
    })
    .catch(() => undefined);

  void client.rpc(syncPiToolPolicyProfileMarkersRpc, {})
    .then(({ profiles }) => {
      if (stopped) return;
      currentProfileState = { status: "ready", profiles };
      for (const agent of agents.values()) updatePill(pills, agent.id);
    })
    .catch(() => {
      if (stopped) return;
      currentProfileState = { status: "error" };
      for (const agent of agents.values()) updatePill(pills, agent.id);
    });

  return () => {
    stopped = true;
    unsubscribeAgents();
    for (const pill of pills.values()) pill.remove();
    agents.clear();
    pills.clear();
    currentActiveProfiles = new Map();
    currentProfileState = { status: "loading" };
  };
}

async function loadActiveProfile(
  client: PluginClientContext,
  agentId: string,
  agents: ReadonlyMap<string, AgentRegistration>,
  pills: ReadonlyMap<string, PluginButtonRegistration>,
  isStopped: () => boolean,
): Promise<void> {
  try {
    const { profileId } = await client.rpc(getPiActiveProfileRpc, { agentId });
    if (isStopped() || !agents.has(agentId)) return;
    currentActiveProfiles.set(agentId, { status: "ready", profileId });
  } catch {
    if (isStopped() || !agents.has(agentId)) return;
    currentActiveProfiles.set(agentId, { status: "error" });
  }
  updatePill(pills, agentId);
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
