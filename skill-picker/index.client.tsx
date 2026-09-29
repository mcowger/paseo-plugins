import type {
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { SkillPickerContent } from "./client/skill-picker";

export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  const lifetime = new AbortController();

  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (stopped || !agent.workspaceId) return;
    pills.get(agent.id)?.remove();
    const workspaceId = agent.workspaceId;
    const pill = client.addComposerPill({
      id: "skill-picker",
      workspaceId,
      agentId: agent.id,
      button: {
        title: "Skills",
        icon: "Sparkles",
        // Zero-width space: composer pills always render a text label
        // (label ?? title), and empty labels fail validation. This keeps
        // the pill visually icon-only while preserving the tooltip/a11y title.
        label: "​",
        behavior: { kind: "popover", Content: SkillPickerContent },
      },
    });
    pills.set(agent.id, pill);
  };

  const remove = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const pill of pills.values()) pill.remove();
          pills.clear();
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
      if (!stopped) console.error("Skill picker agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
