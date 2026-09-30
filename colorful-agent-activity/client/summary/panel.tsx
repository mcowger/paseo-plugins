import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { summarizeAgentActivity, summaryFileLabels, type SummarySourceEntry } from "../../shared/summary";
import { useActivityStyles, usePalette } from "../activity";

const TIMELINE_LIMIT = 400;
const STREAM_DEBOUNCE_MS = 600;
const ACTIVE_POLL_MS = 5_000;

type TimelineState =
  | { status: "loading" }
  | { status: "ready"; entries: SummarySourceEntry[]; fetchedAt: number }
  | { status: "error"; error: string };

/**
 * The timeline transformer/renderer API is strictly per item, so whole-agent
 * aggregation reads canonical rows through the agent handle instead. History
 * is refetched (debounced) on live events, with a poll backstop while the
 * agent is running.
 */
function useAgentTimeline(agentId: string, poll: boolean): TimelineState {
  const paseo = usePaseo();
  const [state, setState] = useState<TimelineState>({ status: "loading" });

  useEffect(() => {
    const handle = paseo.agents.ref(agentId);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const result = await handle.timeline.refetch({
          projection: "canonical",
          direction: "tail",
          limit: TIMELINE_LIMIT,
        });
        if (cancelled) return;
        if (result.error) {
          setState({ status: "error", error: result.error });
          return;
        }
        setState({
          status: "ready",
          fetchedAt: Date.now(),
          entries: result.entries.map((entry) => ({
            item: entry.item,
            timestamp: new Date(entry.timestamp),
          })),
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void load();
    const subscription = handle.timeline.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), STREAM_DEBOUNCE_MS);
    });
    const interval = poll ? setInterval(() => void load(), ACTIVE_POLL_MS) : null;

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      void subscription.release();
    };
  }, [paseo, agentId, poll]);

  return state;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

const STATUS_LABELS: Record<string, string> = {
  initializing: "Starting",
  idle: "Idle",
  running: "Running",
  error: "Error",
  closed: "Closed",
};

function Section({
  title,
  meta,
  expanded,
  onToggle,
  icon,
  styles,
  children,
}: {
  title: string;
  meta: string;
  expanded: boolean;
  onToggle: () => void;
  icon: string;
  styles: ReturnType<typeof useActivityStyles>;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${title}, ${meta}`}
        onPress={onToggle}
        style={styles.headerButton}
      >
        <View style={styles.iconBadge}>
          <Icon name={icon} size={12} color={styles.summary.color as string} />
        </View>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.summary} numberOfLines={1}>
          {meta}
        </Text>
        <View style={styles.iconBadge}>
          <Icon
            name={expanded ? "ChevronDown" : "ChevronRight"}
            size={12}
            color={styles.summary.color as string}
          />
        </View>
      </Pressable>
      {expanded ? <View style={styles.details}>{children}</View> : null}
    </View>
  );
}

export function AgentSummaryPanel({ agentId, theme, layout }: PluginAgentPanelProps) {
  const palette = usePalette(theme);
  const styles = useActivityStyles(theme, palette);
  const agent = useAgent(agentId, (snapshot) => ({
    status: snapshot.status,
    title: snapshot.title,
  }));
  const isRunning = agent?.status === "running";
  const timeline = useAgentTimeline(agentId, isRunning);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);

  const summary = useMemo(
    () =>
      timeline.status === "ready"
        ? summarizeAgentActivity(timeline.entries, { now: timeline.fetchedAt })
        : null,
    [timeline],
  );

  const panelStyles = useMemo(
    () =>
      ({
        scroll: { flex: 1 } satisfies ViewStyle,
        content: {
          paddingHorizontal: 8,
          paddingVertical: 6,
          gap: 1,
        } satisfies ViewStyle,
        toolRow: {
          alignItems: "center",
          flexDirection: "row",
          gap: 5,
          minHeight: 20,
          paddingHorizontal: 5,
          paddingVertical: 2,
        } satisfies ViewStyle,
        toolLabel: {
          color: theme.colors.foreground,
          fontFamily: "monospace",
          fontSize: 12,
          fontWeight: "600",
          lineHeight: 17,
        } satisfies TextStyle,
        toolCount: {
          color: theme.colors.foregroundMuted,
          fontFamily: "monospace",
          fontSize: 12,
          lineHeight: 17,
        } satisfies TextStyle,
        toolFiles: {
          color: theme.colors.foregroundMuted,
          flex: 1,
          fontFamily: "monospace",
          fontSize: 11,
          lineHeight: 17,
        } satisfies TextStyle,
        body: {
          color: theme.colors.foreground,
          fontFamily: "monospace",
          fontSize: 12,
          lineHeight: 17,
        } satisfies TextStyle,
        item: {
          paddingHorizontal: 5,
          paddingVertical: 3,
        } satisfies ViewStyle,
        statusLine: {
          alignItems: "center",
          flexDirection: "row",
          gap: 6,
          paddingHorizontal: 5,
          paddingVertical: 3,
        } satisfies ViewStyle,
        statusText: {
          color: theme.colors.foreground,
          fontFamily: "monospace",
          fontSize: 12,
          lineHeight: 17,
        } satisfies TextStyle,
        placeholder: {
          color: theme.colors.foregroundMuted,
          fontFamily: "monospace",
          fontSize: 12,
          lineHeight: 17,
          paddingHorizontal: 5,
          paddingVertical: 8,
        } satisfies TextStyle,
      }) as const,
    [theme.colors.foreground, theme.colors.foregroundMuted],
  );

  const statusColor = (status: keyof typeof palette.statusColors) => palette.statusColors[status];

  return (
    <ScrollView style={panelStyles.scroll} contentContainerStyle={panelStyles.content}>
      {timeline.status === "loading" ? (
        <Text style={panelStyles.placeholder}>Loading agent activity…</Text>
      ) : null}
      {timeline.status === "error" ? (
        <Text style={panelStyles.placeholder}>Could not load activity: {timeline.error}</Text>
      ) : null}
      {summary && summary.toolCallCount === 0 && summary.thinkingCount === 0 && summary.outputCount === 0 ? (
        <Text style={panelStyles.placeholder}>No activity on this agent yet.</Text>
      ) : null}

      {summary && summary.toolGroups.length > 0 ? (
        <View>
          {summary.toolGroups.map((group) => (
            <View key={group.key} style={panelStyles.toolRow}>
              <Icon
                name={group.icon}
                size={12}
                color={group.status === "completed" ? theme.colors.foregroundMuted : statusColor(group.status)}
              />
              <Text style={panelStyles.toolLabel}>
                {group.label} ({group.count}×)
              </Text>
              {group.files.length > 0 ? (
                <Text style={panelStyles.toolFiles} numberOfLines={1}>
                  {summaryFileLabels(group.files).join(", ")}
                </Text>
              ) : null}
              {group.status !== "completed" ? (
                <Icon name="CircleAlert" size={11} color={statusColor(group.status)} />
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {summary ? (
        <Section
          title="Thinking"
          meta={`${summary.thinkingCount} ${summary.thinkingCount === 1 ? "step" : "steps"}`}
          icon="Brain"
          expanded={thinkingExpanded}
          onToggle={() => setThinkingExpanded((value) => !value)}
          styles={styles}
        >
          {summary.thinking.length === 0 ? (
            <Text style={panelStyles.placeholder}>No reasoning recorded.</Text>
          ) : (
            summary.thinking.map((entry, index) => (
              <View key={`thinking-${index}-${entry.timestamp.getTime()}`} style={panelStyles.item}>
                <Text style={panelStyles.body}>{entry.text}</Text>
              </View>
            ))
          )}
        </Section>
      ) : null}

      {summary ? (
        <Section
          title="Output"
          meta={`${summary.outputCount} ${summary.outputCount === 1 ? "message" : "messages"}`}
          icon="MessageSquare"
          expanded={outputExpanded}
          onToggle={() => setOutputExpanded((value) => !value)}
          styles={styles}
        >
          {summary.output.length === 0 ? (
            <Text style={panelStyles.placeholder}>No output yet.</Text>
          ) : (
            summary.output.map((entry, index) => (
              <View key={`output-${index}-${entry.timestamp.getTime()}`} style={panelStyles.item}>
                <Text style={panelStyles.body}>{entry.text}</Text>
              </View>
            ))
          )}
        </Section>
      ) : null}

      <View style={styles.section}>
        <View style={styles.headerButton}>
          <View style={styles.iconBadge}>
            <Icon
              name={isRunning ? "LoaderCircle" : "Activity"}
              size={12}
              color={isRunning ? statusColor("running") : theme.colors.foregroundMuted}
            />
          </View>
          <Text style={styles.title}>Status</Text>
          <Text style={styles.summary} numberOfLines={1}>
            {STATUS_LABELS[agent?.status ?? "idle"] ?? agent?.status ?? "Unknown"}
          </Text>
        </View>
        <View style={panelStyles.item}>
          <View style={panelStyles.statusLine}>
            <Text style={panelStyles.statusText}>{summary?.toolCallsPerMinute ?? 0} calls/min</Text>
          </View>
          <View style={panelStyles.statusLine}>
            <Text style={panelStyles.statusText}>
              {summary?.msSinceLastToolCall === null || summary?.msSinceLastToolCall === undefined
                ? "No tool calls yet"
                : `Last call ${formatDuration(summary.msSinceLastToolCall)} ago`}
            </Text>
          </View>
          {summary && summary.activeToolCalls > 0 ? (
            <View style={panelStyles.statusLine}>
              <Text style={[panelStyles.statusText, { color: statusColor("running") }]}>
                {summary.activeToolCalls} running
              </Text>
            </View>
          ) : null}
          {layout.compact ? null : (
            <View style={panelStyles.statusLine}>
              <Text style={panelStyles.statusText}>
                {summary?.toolCallCount ?? 0} tool calls · {summary?.thinkingCount ?? 0} thinking ·{" "}
                {summary?.outputCount ?? 0} output
              </Text>
            </View>
          )}
        </View>
      </View>
    </ScrollView>
  );
}
