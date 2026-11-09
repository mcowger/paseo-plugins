import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { View } from "react-native";
import { diffBlocks } from "../shared/diffstat";
import { hue, isDarkTheme, withAlpha } from "./kit";

/** An icon in a box of its own: web squeezes an svg next to long text otherwise. */
export function Glyph({ name, color, size = 12 }: { name: string; color: string; size?: number }) {
  return <View style={{ width: size, height: size, flexShrink: 0, alignItems: "center", justifyContent: "center" }}><Icon name={name} size={size} color={color} /></View>;
}

/** 0.8.0: the five-block diffstat strip (green added, red removed, gray for the rest), as on a pull request. */
export function DiffBlocks({ theme, added, removed, size = 7 }: { theme: PluginTheme; added: number; removed: number; size?: number }) {
  const blocks = useMemo(() => diffBlocks(added, removed), [added, removed]);
  const muted = theme.colors.foregroundMuted;
  const rest = withAlpha(muted.startsWith("#") ? muted : "#888888", isDarkTheme(theme) ? 0.32 : 0.26);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", gap: 1.5, flexShrink: 0 }}>
      {blocks.map((block, index) => (
        <View key={index} style={{ width: size, height: size, borderRadius: 1.5, backgroundColor: block === "add" ? hue(theme, "green") : block === "remove" ? hue(theme, "red") : rest }} />
      ))}
    </View>
  );
}
