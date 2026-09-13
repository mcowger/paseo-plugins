import { settingsRpc } from "@getpaseo/plugin";
import type { PluginThemeContribution } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";

import { clearStudioDraft } from "./client/studio-draft.js";

import { StudioSurface } from "./client/studio-surface.js";
import { liveTheme } from "./client/live-theme.js";
import { BUILTIN_PRESETS } from "./shared/presets.js";
import { themeStudioSettings, type ThemeStudioSettings } from "./shared/settings.js";

function contributionFromSettings(values: ThemeStudioSettings): PluginThemeContribution {
  const preset = [...BUILTIN_PRESETS, ...values.savedPresets].find((candidate) => candidate.id === values.activePresetId);
  return {
    id: "theme-studio-live",
    name: "Theme Studio (Live)",
    appearance: preset?.appearance ?? values.appearance,
    colors: preset?.tokens ?? values.tokens,
  };
}

async function restoreLiveTheme(client: PluginClientContext): Promise<void> {
  try {
    const result = await client.rpc(settingsRpc("theme-studio").read, {});
    if (result.status !== "ready") {
      liveTheme.update({
        id: "theme-studio-live",
        name: "Theme Studio (Live)",
        appearance: BUILTIN_PRESETS[0].appearance,
        colors: BUILTIN_PRESETS[0].tokens,
      });
      return;
    }
    const parsed = themeStudioSettings.schema.safeParse(result.values);
    liveTheme.update(parsed.success ? contributionFromSettings(parsed.data) : {
      id: "theme-studio-live",
      name: "Theme Studio (Live)",
      appearance: BUILTIN_PRESETS[0].appearance,
      colors: BUILTIN_PRESETS[0].tokens,
    });
  } catch {
    liveTheme.update({
      id: "theme-studio-live",
      name: "Theme Studio (Live)",
      appearance: BUILTIN_PRESETS[0].appearance,
      colors: BUILTIN_PRESETS[0].tokens,
    });
  }
}
export default function contribute(client: PluginClientContext) {
  const detachLiveTheme = liveTheme.attach(client);
  void restoreLiveTheme(client);
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
    clearStudioDraft();
    detachLiveTheme();
  };
}
