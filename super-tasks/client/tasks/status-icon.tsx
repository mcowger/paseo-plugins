import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactElement } from "react";

export function TaskStatusIcon({
  status,
  theme,
  size = 14,
}: {
  status: "pending" | "in_progress" | "completed";
  theme: PluginTheme;
  size?: number;
}): ReactElement {
  if (status === "completed") {
    return <Icon name="CheckCircle2" size={size} color={theme.colors.statusSuccess} />;
  }
  if (status === "in_progress") {
    return <Icon name="Clock" size={size} color={theme.colors.accent} />;
  }
  return <Icon name="Circle" size={size} color={theme.colors.foregroundMuted} />;
}
