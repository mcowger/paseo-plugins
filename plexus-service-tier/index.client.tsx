import type {
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { ServiceTierContent } from "./client/service-tier";
import { agentTierState } from "./client/store";
import {
  isServiceTierAgent,
  serviceTierLabel,
  type ServiceTier,
} from "./shared/service-tier";

interface AgentSnapshotLike {
  id: string;
  workspaceId?: string | null;
  provider: string;
  model: string | null;
}

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  let stopped = false;

  const register = (agent: AgentSnapshotLike) => {
    if (stopped || !agent.workspaceId) return;
    const workspaceId = agent.workspaceId;
    const existing = agentTierState.get(agent.id);
    if (existing) {
      if (existing.provider !== agent.provider || existing.model !== agent.model) {
        existing.provider = agent.provider;
        existing.model = agent.model;
        existing.registration.update({
          visible: isServiceTierAgent(agent.provider, agent.model),
        });
      }
      return;
    }

    const state: {
      tier: ServiceTier;
      provider: string;
      model: string | null;
      registration: PluginButtonRegistration;
    } = {
      tier: "default",
      provider: agent.provider,
      model: agent.model,
      registration: undefined as unknown as PluginButtonRegistration,
    };

    state.registration = client.addComposerPill({
      id: "plexus-service-tier",
      workspaceId,
      agentId: agent.id,
      button: {
        title: "Plexus service tier",
        icon: "Zap",
        label: serviceTierLabel(state.tier),
        visible: isServiceTierAgent(state.provider, state.model),
        behavior: { kind: "popover", Content: ServiceTierContent },
      },
    });
    agentTierState.set(agent.id, state);
  };

  const remove = (agentId: string) => {
    agentTierState.get(agentId)?.registration.remove();
    agentTierState.delete(agentId);
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const agentId of agentTierState.keys()) remove(agentId);
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else register(update.agent);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("Plexus service tier agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    for (const agentId of agentTierState.keys()) remove(agentId);
  };
}
