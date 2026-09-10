import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createPiPresetStore } from "./server/preset-store.js";
import { createPiProvider } from "./server/provider.js";
import { piPresetsSettings, syncPiPresetsRpc } from "./shared/preset-settings.js";

export default function contribute(server: PluginServerContext) {
  const presetStore = createPiPresetStore();
  server.registerSettings(piPresetsSettings);
  server.handle(syncPiPresetsRpc, ({ previousRevision, revision, values }) => {
    presetStore.update(values, revision, previousRevision);
    return { revision };
  });
  server.registerProvider(createPiProvider(presetStore));
  return () => {};
}
