import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { z } from "zod";
import { formatActivityTime, type turnEndSchema } from "../shared/activity-time";

export function TurnEndTime({ item, theme }: PluginTimelineItemProps<z.output<typeof turnEndSchema>>) {
  const label = formatActivityTime(new Date(item.data.at));
  return (
    <View style={{ alignItems: "flex-end", paddingVertical: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Turn ended · {label}</Text>
    </View>
  );
}
