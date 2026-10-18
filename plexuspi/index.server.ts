import os from "node:os";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { createPlexuspiProvider } from "./server/provider.js";
import { buildResumeCommand } from "./server/resume.js";
import { listPendingDialogsRpc, respondDialogRpc } from "./shared/dialogs.js";
import { resumeCommandRpc } from "./shared/resume.js";
import { plexuspiSettings, resolveModelNameStyle } from "./shared/settings.js";

export default function contribute(server: PluginServerContext): () => Promise<void> {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const paseoHome = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
  const command = process.env.PLEXUSPI_PI_COMMAND ?? "pi";
  const stateDirectory = path.join(paseoHome, "plugins", "plexuspi", "state");
  const settings = server.registerSettings(plexuspiSettings);
  const provider = createPlexuspiProvider({
    command,
    stateDirectory,
    getModelNameStyle: async () => {
      const state = await settings.read();
      return resolveModelNameStyle(
        state.status === "ready" ? state.values.modelNameStyle : undefined,
      );
    },
  });
  server.handle(resumeCommandRpc, async ({ agentId }, { paseo }) => {
    const result = await paseo.agents.ref(agentId).refresh();
    const agent = result?.agent;
    if (agent?.provider !== "plexuspi") throw new Error("Choose a PlexusPi session.");
    const handle = agent.persistence;
    if (!handle?.sessionId.startsWith("plugin:"))
      throw new Error("This session has no saved Pi transcript.");
    const persistence = z
      .object({ version: z.literal(1), data: z.object({ id: z.string().uuid() }).strict() })
      .strict()
      .parse(JSON.parse(handle.sessionId.slice("plugin:".length)));
    return {
      command: await buildResumeCommand({
        stateDirectory,
        cwd: agent.cwd,
        persistence,
        command,
        agentDirectory,
      }),
    };
  });
  server.registerProvider(provider.registration);
  server.handle(listPendingDialogsRpc, () => ({ dialogs: provider.dialogs.list() }));
  server.handle(respondDialogRpc, async (input) => {
    const dialog = provider.dialogs
      .list()
      .find(
        (view) =>
          view.sessionId === input.sessionId &&
          view.permissionId === input.permissionId &&
          view.generation === input.generation,
      );
    return {
      resolved: dialog
        ? await provider.dialogs.answer(input.sessionId, input.permissionId, input.answer)
        : false,
    };
  });
  return () => provider.close();
}
