import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createPiProvider } from "./server/provider.js";
import { getPiRuntimeSettingsRpc, updatePiRuntimeSettingRpc } from "./shared/runtime-settings.js";

export default function contribute(server: PluginServerContext) {
  const provider = createPiProvider();
  server.registerProvider(provider);
  server.handle(getPiRuntimeSettingsRpc, ({ agentId }) => ({ settings: provider.getRuntimeSettings(agentId) }));
  server.handle(updatePiRuntimeSettingRpc, async ({ agentId, id, value }) => ({
    settings: await provider.updateRuntimeSetting(agentId, id, value),
  }));
  return async () => {
    await provider.close();
  };
}
