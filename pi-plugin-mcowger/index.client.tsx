import type { PluginClientContext } from "@getpaseo/plugin/client";

import { PiPresetSettings } from "./client/preset-settings.js";
import { contributeRuntimeSettingsPills } from "./client/runtime-settings-pill.js";

export default function contribute(client: PluginClientContext) {
  const removeSettingsPills = contributeRuntimeSettingsPills(client);
  const removePresets = client.addSettingsScreen({
    id: "presets",
    title: "Pi Presets",
    icon: "Bot",
    Component: PiPresetSettings,
  });
  return () => {
    removeSettingsPills();
    removePresets();
  };
}
