import type { PluginServerContext } from "@getpaseo/plugin/server";
import os from "node:os";
import path from "node:path";
import { createSuperpiProvider } from "./server/provider.js";
import { listPendingDialogsRpc, respondDialogRpc } from "./shared/dialogs.js";

export default function contribute(server: PluginServerContext): () => Promise<void> {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const paseoHome = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
  const provider = createSuperpiProvider({
    command: process.env.SUPERPI_PI_COMMAND ?? "pi",
    companionPath: process.env.SUPERPI_COMPANION_PATH ?? path.join(agentDirectory, "extensions", "superpi", "index.ts"),
    stateDirectory: path.join(paseoHome, "plugins", "superpi", "state"),
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
