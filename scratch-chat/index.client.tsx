import type { PluginAgentCommandContext, PluginClientContext } from "@getpaseo/plugin/client";
import { ScratchChatSurface } from "./client/scratch-chat-surface.js";
import { setComposerPillRegistrar } from "./client/composer-pill.js";
import { discardScratchChatRpc } from "./shared/discard-scratch-chat.js";

export default function contribute(client: PluginClientContext) {
  setComposerPillRegistrar(client);
  const removeSurface = client.addSurface("scratch-chat", ScratchChatSurface);
  const removeSidebar = client.addSidebarItem({
    id: "scratch-chat",
    title: "Chat",
    icon: "MessageCircle",
    surface: "scratch-chat",
  });
  const removeNewChatCommand = client.addCommandCenterItem({
    id: "new-temporary-chat",
    title: "New temporary chat",
    icon: "MessageCirclePlus",
    keywords: ["scratch", "chat", "temporary"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("scratch-chat");
    },
  });
  const removeDiscardCommand = client.addCommandCenterItem({
    id: "discard-scratch-chat",
    title: "Discard scratch chat",
    icon: "Trash2",
    keywords: ["scratch", "chat", "archive", "delete"],
    context: "agent",
    onSelect(context) {
      return discardScratchChat(context);
    },
  });
  return () => {
    setComposerPillRegistrar(null);
    removeDiscardCommand();
    removeNewChatCommand();
    removeSidebar();
    removeSurface();
  };
}

export async function discardScratchChat(context: PluginAgentCommandContext): Promise<void> {
  if (context.agent.labels["scratch-chat"] !== "true") {
    throw new Error("This agent is not a Scratch Chat");
  }
  await context.rpc(discardScratchChatRpc, { agentId: context.agent.id });
}
