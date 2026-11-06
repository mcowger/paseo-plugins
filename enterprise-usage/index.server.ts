import type { PluginServerContext } from "@getpaseo/plugin/server";
import { usageRpc, codexUsageRpc } from "./shared/usage";
import { createUsageReader } from "./server/usage";
import { createCodexUsageReader } from "./server/codex-usage";
import { displayPreferences } from "./shared/preferences";
export default function contribute(server: PluginServerContext) {
  server.registerSettings(displayPreferences);
  const reader = createUsageReader();
  const codexReader = createCodexUsageReader();
  server.handle(usageRpc, ({ refresh }) => reader.read(refresh));
  server.handle(codexUsageRpc, ({ refresh }) => codexReader.read(refresh));
  return () => { reader.dispose(); codexReader.dispose(); };
}
