import type { PluginServerContext } from "@getpaseo/plugin/server";
import os from "node:os";
import path from "node:path";
import { createSuperpiProvider } from "./server/provider.js";
import { listPendingDialogsRpc, respondDialogRpc } from "./shared/dialogs.js";
import { resumeCommandRpc } from "./shared/resume.js";
import { buildResumeCommand } from "./server/resume.js";
import { z } from "zod";

export default function contribute(server: PluginServerContext): () => Promise<void> {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const paseoHome = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
  const command = process.env.SUPERPI_PI_COMMAND ?? "pi";
  const companionPath = process.env.SUPERPI_COMPANION_PATH ?? path.join(agentDirectory, "extensions", "superpi", "index.ts");
  const stateDirectory = path.join(paseoHome, "plugins", "superpi", "state");
  const provider = createSuperpiProvider({
    command,
    companionPath,
    stateDirectory,
  });
  server.handle(resumeCommandRpc, async ({ agentId }, { paseo }) => {
    const result = await paseo.agents.ref(agentId).refresh();
    const agent = result?.agent;
    if (!agent || agent.provider !== "superpi") throw new Error("Choose a Superpi session.");
    const handle = agent.persistence;
    if (!handle?.sessionId.startsWith("plugin:")) throw new Error("This session has no saved Pi transcript.");
    const persistence = z.object({ version: z.literal(1), data: z.object({ id: z.string().uuid() }).strict() }).strict()
      .parse(JSON.parse(handle.sessionId.slice("plugin:".length)));
    return { command: await buildResumeCommand({ stateDirectory, cwd: agent.cwd, persistence, command, companionPath, agentDirectory }) };
  });
  server.registerProvider(provider.registration);
  server.handle(listPendingDialogsRpc, () => ({ dialogs: provider.dialogs.list() }));
  server.handle(respondDialogRpc, async (input) => {
    const dialog = provider.dialogs.list().find((view) => view.sessionId === input.sessionId
      && view.permissionId === input.permissionId && view.generation === input.generation);
    return { resolved: dialog ? await provider.dialogs.answer(input.sessionId, input.permissionId, input.answer) : false };
  });
  return () => provider.close();
}
