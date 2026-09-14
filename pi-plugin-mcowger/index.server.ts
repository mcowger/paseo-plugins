import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createPiProvider } from "./server/provider.js";
import { getPiRuntimeSettingsRpc, updatePiRuntimeSettingRpc } from "./shared/runtime-settings.js";

export default function contribute(server: PluginServerContext) {
  const provider = createPiProvider();
  server.registerProvider(provider);
  server.handle(getPiRuntimeSettingsRpc, async ({ agentId }, { paseo }) => ({
    settings: await provider.getRuntimeSettings(agentId, paseo),
  }));
  server.handle(updatePiRuntimeSettingRpc, async ({ agentId, id, value }, { paseo }) => ({
    settings: await provider.updateRuntimeSetting(agentId, id, value, paseo),
  }));
  return async () => {
    await provider.close();
  };
}
