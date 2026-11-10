import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { t } from "../shared/text";
import type { ActivityPalette } from "../shared/presentation";
import type { ActivityStyles } from "./activity";

/** A compact activity line reported inline by an OMP provider subagent. */
export interface ProviderSubagentActivity {
  /** Stable identifier for the event. */
  id: string;
  /** Short, human-readable action title. */
  title: string;
  /** Optional recent activity detail. */
  summary?: string | null;
  /** Optional relative-time or other compact metadata. */
  meta?: string | null;
  /** Optional icon name from the Paseo icon set. */
  icon?: string | null;
}

/** Provider-owned child summary; no child timeline subscription is performed here. */
export interface ProviderSubagentDescriptor {
  /** Stable identifier for this child. */
  id: string;
  title: string;
  /** Paseo child status (for example running, completed, or failed). */
  status: string;
  /** Most recent activity first; the component displays at most three rows. */
  activity?: readonly ProviderSubagentActivity[];
}

export function ProviderSubagentProgress({
  children,
  palette,
  styles,
}: {
  children: readonly ProviderSubagentDescriptor[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (children.length === 0) return null;

  return (
    <View style={styles.childTimelineSection}>
      {children.map((child) => (
        <View key={child.id} style={styles.childTimelineSection}>
          <View style={styles.childTimelineHeader}>
            <Icon name="Bot" color={styles.childTimelineItemMeta.color} size={12} />
            <Text numberOfLines={1} style={styles.childTimelineItemTitle}>{child.title}</Text>
            <Text numberOfLines={1} style={[styles.childTimelineItemMeta, { color: palette.statusColors[child.status as keyof typeof palette.statusColors] ?? palette.statusColors.running }]}>{child.status === "running" ? t("ui.running") : child.status === "completed" ? t("ui.completed") : child.status === "failed" ? t("ui.failed") : t("ui.canceled")}</Text>
          </View>
          {child.activity?.length ? (
            <View style={styles.childTimelineList}>
              {child.activity.slice(0, 3).map((entry) => (
                <View key={entry.id} style={styles.childTimelineItem}>
                  {entry.icon ? <Icon name={entry.icon} color={styles.childTimelineItemMeta.color} size={11} /> : null}
                  <Text numberOfLines={1} style={styles.childTimelineItemTitle}>{entry.title}</Text>
                  {entry.summary ? <Text numberOfLines={1} style={styles.childTimelineItemSummary}>{entry.summary}</Text> : null}
                  {entry.meta ? <Text numberOfLines={1} style={styles.childTimelineItemMeta}>{entry.meta}</Text> : null}
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.empty}>{t("ui.noSubagentActivityYet")}</Text>
          )}
        </View>
      ))}
    </View>
  );
}
