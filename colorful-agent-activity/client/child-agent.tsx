import type { PaseoAgent, PaseoAgentHandle } from "@getpaseo/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import React, { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import {
  childTimelineEntryKey,
  recentChildTimelineEntries,
} from "../shared/child-agent";
import {
  formatReasoningText,
  resolveToolCallPresentation,
  type ActivityPalette,
} from "../shared/presentation";

const CHILD_TIMELINE_PAGE_SIZE = 100;
const MAX_VISIBLE_CHILD_ACTIVITY_ENTRIES = 3;

type TimelineEntry = Awaited<
  ReturnType<PaseoAgentHandle["timeline"]["refetch"]>
>["entries"][number];

interface ChildTimelineState {
  agent: PaseoAgent | null;
  entries: readonly TimelineEntry[];
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: ChildTimelineState = {
  agent: null,
  entries: [],
  loading: true,
  error: null,
};

export function ChildAgentTimeline({
  agentId,
  palette,
  styles,
}: {
  agentId: string;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const state = useChildTimeline(agentId);
  const entries = useMemo(
    () => recentChildTimelineEntries(state.entries).slice(-MAX_VISIBLE_CHILD_ACTIVITY_ENTRIES),
    [state.entries],
  );
  const statusColor = state.agent
    ? childStatusColor(state.agent.status, palette)
    : palette.categoryColors.agent;

  return (
    <View style={styles.childTimelineSection}>
      <View style={styles.childTimelineHeader}>
        <Text style={styles.detailLabel}>Live child activity</Text>
        {state.agent?.status ? (
          <Text style={[styles.paseoListItemMeta, { color: statusColor }]}>
            {state.agent.status}
          </Text>
        ) : null}
      </View>
      {state.error ? (
        <Text style={styles.empty}>Unable to load child activity: {state.error}</Text>
      ) : state.loading && entries.length === 0 ? (
        <Text style={styles.empty}>Loading child activity…</Text>
      ) : entries.length === 0 ? (
        <Text style={styles.empty}>No child activity yet.</Text>
      ) : (
        <View style={styles.childTimelineList}>
          {entries.map((entry) => (
            <ChildTimelineRow
              key={childTimelineEntryKey(entry)}
              item={entry.item}
              palette={palette}
              styles={styles}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function useChildTimeline(agentId: string): ChildTimelineState {
  const paseo = usePaseo();
  const [state, setState] = useState<ChildTimelineState>(EMPTY_STATE);

  useEffect(() => {
    const handle = paseo.agents.ref(agentId);
    let disposed = false;
    let refreshing = false;
    let refreshQueued = false;

    setState(EMPTY_STATE);

    const refresh = async (): Promise<void> => {
      if (disposed) return;
      if (refreshing) {
        refreshQueued = true;
        return;
      }
      refreshing = true;
      try {
        const response = await handle.timeline.refetch({
          direction: "tail",
          limit: CHILD_TIMELINE_PAGE_SIZE,
          projection: "projected",
        });
        if (disposed) return;
        setState({
          agent: response.agent ?? handle.current(),
          entries: response.entries,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (disposed) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        refreshing = false;
        if (!disposed && refreshQueued) {
          refreshQueued = false;
          void refresh();
        }
      }
    };

    const unsubscribeTimeline = handle.timeline.subscribe((event) => {
      if (event.event.type === "timeline" || event.event.type === "replacement") {
        void refresh();
      }
    });
    const unsubscribeAgent = handle.subscribe((update) => {
      if (disposed) return;
      setState((current) => ({
        ...current,
        agent: update.kind === "upsert" ? update.agent : null,
      }));
    });

    void refresh();

    return () => {
      disposed = true;
      unsubscribeTimeline();
      unsubscribeAgent();
    };
  }, [agentId, paseo]);

  return state;
}

function ChildTimelineRow({
  item,
  palette,
  styles,
}: {
  item: AgentTimelineItem;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const row = childTimelineRow(item, palette);
  return (
    <View style={styles.childTimelineItem}>
      <Icon name={row.icon} color={row.color} size={11} />
      <Text numberOfLines={1} style={styles.childTimelineItemTitle}>
        {row.title}
      </Text>
      {row.summary ? (
        <Text numberOfLines={1} style={styles.childTimelineItemSummary}>
          {row.summary}
        </Text>
      ) : null}
      {row.status ? (
        <Text style={[styles.childTimelineItemMeta, { color: row.statusColor }]}>
          {row.status}
        </Text>
      ) : null}
    </View>
  );
}

interface ChildTimelineRowModel {
  icon: string;
  title: string;
  summary?: string;
  color: string;
  status?: string;
  statusColor?: string;
}

function childTimelineRow(
  item: AgentTimelineItem,
  palette: ActivityPalette,
): ChildTimelineRowModel {
  switch (item.type) {
    case "reasoning":
      return {
        icon: "Brain",
        title: "Thinking",
        summary: compactText(formatReasoningText(item.text)),
        color: palette.categoryColors.reasoning,
      };
    case "tool_call": {
      const presentation = resolveToolCallPresentation(item);
      return {
        icon: presentation.icon,
        title: presentation.label,
        summary: presentation.summary,
        color: palette.categoryColors[presentation.category],
        status: item.status,
        statusColor: toolStatusColor(item.status, palette),
      };
    }
    case "assistant_message":
      return {
        icon: "MessageSquare",
        title: "Agent",
        summary: compactText(item.text),
        color: palette.categoryColors.communication,
      };
    case "user_message":
      return {
        icon: "MessageSquare",
        title: "Prompt",
        summary: compactText(item.text),
        color: palette.categoryColors.communication,
      };
    case "todo":
      return {
        icon: "ListChecks",
        title: "Plan",
        summary: `${item.items.filter((task) => task.completed).length}/${item.items.length} tasks complete`,
        color: palette.categoryColors.plan,
      };
    case "error":
      return {
        icon: "CircleX",
        title: "Error",
        summary: compactText(item.message),
        color: palette.statusColors.failed,
      };
    case "notification":
      return {
        icon: "Bell",
        title: item.level,
        summary: compactText(item.message),
        color: item.level === "error" ? palette.statusColors.failed : palette.categoryColors.communication,
      };
    case "compaction":
      return {
        icon: "Archive",
        title: "Context compacted",
        color: palette.categoryColors.plan,
        status: item.status,
        statusColor: palette.categoryColors.plan,
      };
    case "plugin":
      return {
        icon: "Puzzle",
        title: item.kind,
        color: palette.categoryColors.unknown,
      };
  }
}

function compactText(value: string): string | undefined {
  const text = value.replace(/\s+/g, " ").trim();
  return text || undefined;
}

function toolStatusColor(
  status: Extract<AgentTimelineItem, { type: "tool_call" }>["status"],
  palette: ActivityPalette,
): string {
  switch (status) {
    case "running":
      return palette.statusColors.running;
    case "completed":
      return palette.statusColors.completed;
    case "failed":
      return palette.statusColors.failed;
    case "canceled":
      return palette.statusColors.canceled;
  }
}

function childStatusColor(
  status: PaseoAgent["status"],
  palette: ActivityPalette,
): string {
  switch (status) {
    case "running":
    case "initializing":
      return palette.statusColors.running;
    case "idle":
      return palette.statusColors.completed;
    case "error":
      return palette.statusColors.failed;
    case "closed":
      return palette.statusColors.canceled;
  }
}
