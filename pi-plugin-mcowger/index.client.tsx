import type { PluginClientContext } from "@getpaseo/plugin/client";

import { PiPresetSettings } from "./client/preset-settings.js";

export default function contribute(client: PluginClientContext) {
  const removePresets = client.addSettingsScreen({
    id: "presets",
    title: "Pi Presets",
    icon: "Bot",
    Component: PiPresetSettings,
  });
  return () => {
    removePresets();
  };
}
