import { useSettings } from "@getpaseo/plugin/client";
import { createContext, useContext, useEffect } from "react";
import { Platform } from "react-native";
import {
  activitySettings,
  DEFAULT_ACTIVITY_SETTINGS,
  type ActivitySettings,
  type CommandColor,
  type QuietStrength,
  type ReplyCode,
} from "../shared/settings";
import { installReplyCodeStyles, replyCodeStyleKey, type ReplyCodePalette } from "./web";

/**
 * Settings every activity renderer reads.
 *
 * The host's `useSettings` is the source of truth, but the dashboard previews
 * values that are not saved yet: it provides them here, so a tile or a segmented
 * control updates the preview on the same frame while the save is still in
 * flight. Renderers must go through `useActivityPrefs` rather than calling
 * `useSettings` themselves.
 */
export const PrefsOverride = createContext<ActivitySettings | undefined>(undefined);

export function useActivityPrefs(): ActivitySettings {
  const override = useContext(PrefsOverride);
  const settings = useSettings(activitySettings);
  if (override) return override;
  return settings.status === "ready" ? settings.values : DEFAULT_ACTIVITY_SETTINGS;
}

/** Row opacity per quiet strength; hovering, expanding, or running overrides it. */
export const QUIET_OPACITY: Record<QuietStrength, number> = {
  dim: 0.3,
  faded: 0.45,
  soft: 0.65,
  full: 1,
};

export function quietOpacity(strength: QuietStrength): number {
  return QUIET_OPACITY[strength] ?? 1;
}

/** Whether a command should be colored in `expanded` mode, `always`, or never. */
export function commandColorEnabled(mode: CommandColor, expanded: boolean): boolean {
  if (mode === "off") return false;
  return mode === "always" || expanded;
}

/** The host restyle only exists where there is a DOM to style. */
export function replyCodeEnabled(mode: ReplyCode, platform: string): boolean {
  return mode === "on" && platform === "web";
}

// The restyle is a document-wide side effect, so it is applied once per palette
// no matter how many rows ask for it; the last applied palette is remembered here.
let appliedKey: string | null = null;

/** Applies or removes the web reply restyle. No-op off web. */
export function syncReplyCodeStyles(
  enabled: boolean,
  palette: ReplyCodePalette | null,
): void {
  const key = enabled && palette ? replyCodeStyleKey(palette) : "";
  if (key === appliedKey) return;
  appliedKey = key;
  if (!enabled || !palette) installReplyCodeStyles(null);
  else installReplyCodeStyles(palette);
}

/**
 * Keeps the reply restyle in step with the setting and the host theme.
 *
 * Called from the activity renderers as well as the sidebar row: rows are mounted
 * whenever a chat is on screen, while the sidebar row can be hidden by the user.
 */
export function useReplyCodeStyles(theme: { colors: ReplyCodePalette }): void {
  const prefs = useActivityPrefs();
  const enabled = replyCodeEnabled(prefs.replyCode, Platform.OS);
  const palette = theme.colors;
  const key = enabled ? replyCodeStyleKey(palette) : "";
  useEffect(() => {
    syncReplyCodeStyles(enabled, enabled ? palette : null);
  }, [enabled, key]);
}
