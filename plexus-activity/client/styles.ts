import type { PluginTheme } from "@getpaseo/plugin";
import { Platform, type TextStyle, type ViewStyle } from "react-native";

/**
 * Every colour comes from the 11 host theme tokens, so the panel follows the active Paseo theme on
 * web and on iOS/Android. Plexus's cyan/emerald/fuchsia accents have no equivalent here and are not
 * reproduced; status colours are reserved for the connection pill and error states.
 */
export interface ActivityStyles {
  readonly root: ViewStyle;
  readonly header: ViewStyle;
  readonly scopeButton: ViewStyle;
  readonly scopeLabel: TextStyle;
  readonly scopeChevron: ViewStyle;
  readonly pill: ViewStyle;
  readonly dot: ViewStyle;
  readonly pillLabel: TextStyle;
  readonly iconButton: ViewStyle;
  readonly listContent: ViewStyle;
  readonly card: ViewStyle;
  readonly line: ViewStyle;
  readonly primaryText: TextStyle;
  readonly secondaryText: TextStyle;
  readonly monoText: TextStyle;
  readonly centerState: ViewStyle;
  readonly stateTitle: TextStyle;
  readonly stateBody: TextStyle;
  readonly actionButton: ViewStyle;
  readonly actionLabel: TextStyle;
  readonly optionRow: ViewStyle;
  readonly optionRowSelected: ViewStyle;
  readonly optionLabel: TextStyle;
  readonly optionMeta: TextStyle;
  readonly separator: ViewStyle;
  readonly perfText: TextStyle;
}

const MONOSPACE_FONT = Platform.select({ ios: "Menlo", default: "monospace" });

export function createActivityStyles(theme: PluginTheme, compact: boolean): ActivityStyles {
  const small = compact ? 10 : 11;
  const base = compact ? 11 : 12;

  return {
    root: { flex: 1, backgroundColor: theme.colors.surface0 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    scopeButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
      flexShrink: 1,
    },
    scopeLabel: {
      color: theme.colors.foreground,
      fontSize: small,
      fontWeight: "600",
      flexShrink: 1,
    },
    scopeChevron: { opacity: 0.7 },
    pill: { flexDirection: "row", alignItems: "center", gap: 4, marginLeft: "auto" },
    dot: { width: 6, height: 6, borderRadius: 3 },
    pillLabel: { color: theme.colors.foregroundMuted, fontSize: small },
    iconButton: { padding: 4, borderRadius: 4 },
    // Also used by the full-screen surface, where a centred column reads better than full-bleed rows.
    listContent: {
      padding: 8,
      gap: 6,
      paddingBottom: 24,
      width: "100%",
      maxWidth: 760,
      alignSelf: "center",
    },
    card: {
      backgroundColor: theme.colors.surface1,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      paddingVertical: 7,
      paddingHorizontal: 9,
      gap: 2,
    },
    line: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 4 },
    primaryText: { color: theme.colors.foreground, fontSize: base, fontWeight: "500" },
    secondaryText: { color: theme.colors.foregroundMuted, fontSize: small },
    monoText: {
      color: theme.colors.foreground,
      fontSize: small,
      fontFamily: MONOSPACE_FONT,
    },
    perfText: { color: theme.colors.foregroundMuted, fontSize: small, fontFamily: MONOSPACE_FONT },
    centerState: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 20,
      paddingVertical: 32,
      gap: 8,
    },
    stateTitle: {
      color: theme.colors.foreground,
      fontSize: base + 1,
      fontWeight: "600",
      textAlign: "center",
    },
    stateBody: {
      color: theme.colors.foregroundMuted,
      fontSize: small,
      lineHeight: small + 5,
      textAlign: "center",
    },
    actionButton: {
      marginTop: 4,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    actionLabel: { color: theme.colors.foreground, fontSize: small, fontWeight: "600" },
    optionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: 6,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    optionRowSelected: { backgroundColor: theme.colors.surface2 },
    optionLabel: { color: theme.colors.foreground, fontSize: base, flexShrink: 1 },
    optionMeta: { color: theme.colors.foregroundMuted, fontSize: small },
    separator: { height: 1, backgroundColor: theme.colors.border },
  };
}
