import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

let addComposerPill: PluginClientContext["addComposerPill"] | null = null;
const registrations = new Set<PluginButtonRegistration>();

export function setComposerPillRegistrar(client: PluginClientContext | null): void {
  addComposerPill = client?.addComposerPill.bind(client) ?? null;
  if (!client) {
    for (const registration of registrations) registration.remove();
    registrations.clear();
  }
}

export function addDiscardComposerPill(
  workspaceId: string,
  agentId: string,
  onDiscard: () => void | Promise<void>,
): PluginButtonRegistration | null {
  if (!addComposerPill) return null;
  const registration = addComposerPill({
    id: `scratch-chat-discard-${agentId}`,
    workspaceId,
    agentId,
    button: {
      title: "Discard scratch chat",
      label: "Discard",
      icon: "Trash2",
      behavior: { kind: "action", onPress: onDiscard },
    },
  });
  registrations.add(registration);
  const remove = registration.remove.bind(registration);
  registration.remove = () => {
    registrations.delete(registration);
    remove();
  };
  return registration;
}
