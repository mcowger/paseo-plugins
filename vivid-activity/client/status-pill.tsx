import { useI18n } from "./i18n-client";
import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import type { ActivityPalette } from "../shared/presentation";
import { statusLabel } from "../shared/vivid-model";
export function statusColor(
  status: string | undefined,
  palette: ActivityPalette
): string {
  switch (status?.toLowerCase()) {
    case "running":
    case "initializing":
      return palette.statusColors.running;
    case "completed":
    case "idle":
    case "active":
    case "succeeded":
    case "healthy":
    case "success":
      return palette.statusColors.completed;
    case "failed":
    case "error":
    case "unhealthy":
      return palette.statusColors.failed;
    case "canceled":
    case "paused":
    case "stopped":
    case "closed":
      return palette.statusColors.canceled;
    default:
      return palette.categoryColors.unknown;
  }
}

export function StatusPill({
  value,
  palette,
  styles,
}: {
  value: string;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  useI18n();
  const color = statusColor(value, palette);
  return (
    <View style={styles.paseoStatus}>
      <Text style={[styles.paseoStatusText, { color }]}>{statusLabel(value)}</Text>
    </View>
  );
}
