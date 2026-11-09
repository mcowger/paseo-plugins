import { useI18n } from "./i18n-client";
import { t } from "../shared/text";
import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { ActivityStyles } from "./activity";
import type { ActivityPalette } from "../shared/presentation";
import { parsePiSubagentCall } from "../shared/pi-subagents";
import { StatusPill } from "./status-pill";
type DetailProps = { output: unknown; palette: ActivityPalette; styles: ActivityStyles; toolName: string; input: unknown; theme: PluginTimelineItemProps["theme"] };
export function PiSubagentLifecycleSummary({ output, palette, styles }: DetailProps) {
  useI18n();
  const parsed = parsePiSubagentCall(undefined, output);
  if (!parsed.lifecycle) return null;
  const usage = [
    parsed.toolUses !== undefined ? t("ui.toolCalls", { count: parsed.toolUses }) : undefined,
    parsed.tokens ? t("ui.tokens", { count: parsed.tokens }) : undefined,
    parsed.context ? t("ui.context", { value: parsed.context }) : undefined,
    parsed.duration,
  ].filter(Boolean).join(t("ui.metaSeparator"));
  return (
    <View style={styles.subAgentProgress}>
      <View style={styles.subAgentLine}>
        {parsed.status ? <StatusPill value={parsed.status} palette={palette} styles={styles} /> : null}
        {/* 0.6.0 (opus-F49): beside the pill on a phone the usage wraps instead of running off the row (native Text does not shrink). */}
        {usage ? <Text style={[styles.mutedText, { flexShrink: 1 }]}>{usage}</Text> : null}
      </View>
      {parsed.error ? <Text style={[styles.detailText, { color: palette.statusColors.failed }]}>{parsed.error}</Text> : null}
      {parsed.notice ? <Text style={styles.mutedText}>{parsed.notice}</Text> : null}
    </View>
  );
}
