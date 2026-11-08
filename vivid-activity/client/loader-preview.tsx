import type { PluginTheme } from "@getpaseo/plugin";
import type { ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import { t } from "../shared/text";
import { LOADER_KINDS, type LoaderKind } from "../shared/settings";
import { aria, hue } from "./kit";
import { Spinner, statusColor } from "./vivid";

/** 0.8.0: names of the running animations (settings 「运行中动画」). */
export const loaderLabels: Record<LoaderKind, string> = {
  get spinner() { return t("settings.loaderSpinner"); },
  get sparkle() { return t("settings.loaderSparkle"); },
  get orb() { return t("settings.loaderOrb"); },
  get snake() { return t("settings.loaderSnake"); },
  get matrix() { return t("settings.loaderMatrix"); },
};

/**
 * 0.8.0: every running animation, moving, to pick from by tap (the same choice as the select above it). `Mark` is the
 * resident's running mark (it draws the fx chunk's animations once loaded); without it every chip shows the spinner.
 */
export function LoaderPreview({ theme, value, disabled, onChange, Mark }: { theme: PluginTheme; value: LoaderKind; disabled: boolean; onChange: (value: LoaderKind) => void; Mark?: ComponentType<{ kind: LoaderKind; size: number; color: string }> }) {
  const color = statusColor(theme, "running");
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 12, paddingVertical: 10, maxWidth: "100%" }}>
      {LOADER_KINDS.map((kind) => {
        const chosen = kind === value;
        return (
          <Pressable
            key={kind}
            accessibilityRole="button"
            accessibilityLabel={loaderLabels[kind]}
            {...aria({ pressed: chosen })}
            disabled={disabled}
            onPress={() => onChange(kind)}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14, borderWidth: 1, borderColor: chosen ? color : theme.colors.border, backgroundColor: chosen ? hue(theme, "blue", "soft") : "transparent" }}
          >
            {kind !== "spinner" && Mark ? <Mark kind={kind} size={16} color={color} /> : <Spinner size={16} color={color} />}
            <Text style={{ color: chosen ? hue(theme, "blue", "text") : theme.colors.foreground, fontSize: 12, fontWeight: chosen ? "700" : "500" }}>{loaderLabels[kind]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
