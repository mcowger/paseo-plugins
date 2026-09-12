import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  cleanupScratchChat,
  createScratchChat,
  discardScratchChat,
  createScratchChatResources,
} from "./server/create-scratch-chat.js";
import { createScratchChatRpc } from "./shared/create-scratch-chat.js";
import { discardScratchChatRpc } from "./shared/discard-scratch-chat.js";

export default function contribute(server: PluginServerContext) {
  const resources = createScratchChatResources();
  let paseo: PluginHandlerContext["paseo"] | null = null;
  server.handle(createScratchChatRpc, (input, context) => {
    paseo = context.paseo;
    return createScratchChat(input, context, resources);
  });
  server.handle(discardScratchChatRpc, (input, context) =>
    discardScratchChat(input.agentId, context, resources),
  );

  const removeAgentArchive = server.on("agent.archived", async (event, context) => {
    const resource = resources.getAgent(event.agent.id);
    if (resource && !resource.cleanupPromise) {
      await cleanupScratchChat(resource, context.paseo, resources, { skipAgent: true });
    }
  });
  const removeWorkspaceArchive = server.on("workspace.archived", async (event, context) => {
    for (const resource of resources.values()) {
      if (resource.workspaceId !== event.workspace.id) continue;
      if (!resource.cleanupPromise) {
        await cleanupScratchChat(resource, context.paseo, resources, { skipWorkspace: true });
      }
    }
  });

  return async () => {
    removeAgentArchive();
    removeWorkspaceArchive();
    for (const resource of resources.values()) {
      if (paseo) await cleanupScratchChat(resource, paseo, resources);
    }
  };
}
