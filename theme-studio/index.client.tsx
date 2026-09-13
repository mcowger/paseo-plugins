import type { PluginClientContext } from "@getpaseo/plugin/client";

import { StudioSurface } from "./client/studio-surface.js";
import { liveTheme } from "./client/live-theme.js";
import { BUILTIN_PRESETS } from "./shared/presets.js";

export default function contribute(client: PluginClientContext) {
  const detachLiveTheme = liveTheme.attach(client);
  liveTheme.update({
    id: "theme-studio-live",
    name: "Theme Studio (Live)",
    appearance: BUILTIN_PRESETS[0].appearance,
    colors: BUILTIN_PRESETS[0].tokens,
  });
  const removeSurface = client.addSurface("theme-studio", StudioSurface);
  const removeSidebar = client.addSidebarItem({
    id: "theme-studio",
    title: "Theme Studio",
    icon: "Palette",
    surface: "theme-studio",
  });
  const removeCommand = client.addCommandCenterItem({
    id: "open-theme-studio",
    title: "Open Theme Studio",
    icon: "Palette",
    keywords: ["theme", "palette", "colors"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("theme-studio");
    },
  });
  const removeSettings = client.addSettingsScreen({
    id: "theme-studio",
    title: "Theme Studio",
    icon: "Palette",
    Component: StudioSurface,
  });
  const removeThemes = BUILTIN_PRESETS.map((preset) =>
    client.addTheme({
      id: preset.id,
      name: preset.name,
      appearance: preset.appearance,
      colors: preset.tokens,
    }),
  );
  return () => {
    removeCommand();
    removeSidebar();
    removeSurface();
    removeSettings();
    for (const removeTheme of removeThemes) removeTheme();
    detachLiveTheme();
  };
}
