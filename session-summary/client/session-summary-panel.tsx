import type { PluginAgentPanelProps, PluginTheme } from "@getpaseo/plugin";
import { Icon, useRevealedText } from "@getpaseo/plugin/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import {
  cacheHitRate,
  elapsedDuration,
  formatDuration,
  formatPercent,
  formatTokenCount,
  type SessionStats,
  type SessionSummary,
  type SummaryTaskStatus,
  type ToolFrequency,
} from "../shared/summary";
import { MarkdownContent, MarkdownPreview, useMarkdownStyles } from "./markdown";
import { useSummaryData } from "./use-summary-data";

const THOUGHT_LOG_MAX_HEIGHT = 320;
const PROMPT_PREVIEW_LINES = 2;

type ToolAppearance = {
  readonly icon: string;
  readonly color: "accent" | "success" | "warning" | "muted";
};

const TOOL_APPEARANCES: Readonly<Record<string, ToolAppearance>> = {
  bash: { icon: "Terminal", color: "warning" },
  edit: { icon: "PenLine", color: "accent" },
  glob: { icon: "FolderSearch", color: "success" },
  grep: { icon: "Search", color: "accent" },
  read: { icon: "FileText", color: "success" },
  task: { icon: "Bot", color: "accent" },
  write: { icon: "FilePenLine", color: "accent" },
};

function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(
    () => ({
      screen: {
        flex: 1,
        gap: compact ? 10 : 14,
        padding: compact ? 12 : 20,
        backgroundColor: theme.colors.surface0,
      },
      promptCard: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        overflow: "hidden" as const,
        backgroundColor: theme.colors.surface1,
      },
      promptHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
        paddingHorizontal: compact ? 10 : 14,
        paddingTop: compact ? 10 : 14,
      },
      promptHeading: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      promptPreview: { paddingHorizontal: compact ? 10 : 14, paddingBottom: compact ? 10 : 14, paddingTop: 8 },
      promptBody: { borderTopWidth: 1, borderTopColor: theme.colors.border, padding: compact ? 10 : 14 },
      grid: { flexDirection: compact ? "column" as const : "row" as const, gap: compact ? 10 : 14 },
      toolsColumn: { flex: compact ? undefined : 1, gap: compact ? 10 : 14 },
      card: {
        gap: compact ? 8 : 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: compact ? 10 : 14,
        backgroundColor: theme.colors.surface1,
      },
      toolsCard: { flex: compact ? undefined : 1 },
      thoughtCard: { flex: compact ? undefined : 2 },
      headingRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 8 },
      headingStart: { flexDirection: "row" as const, alignItems: "center" as const, gap: 7, flexShrink: 1 },
      title: { color: theme.colors.foreground, fontSize: compact ? 18 : 21, fontWeight: "600" as const },
      heading: { color: theme.colors.foreground, fontSize: compact ? 14 : 15, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, lineHeight: 19 },
      pill: { color: theme.colors.foregroundMuted, backgroundColor: theme.colors.surface2, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
      divider: { height: 1, backgroundColor: theme.colors.border },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, gap: 8 },
      toolRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      taskToggle: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      task: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8 },
      taskText: { color: theme.colors.foreground, flex: 1, lineHeight: 19 },
      completedTaskText: { color: theme.colors.foregroundMuted, flex: 1, lineHeight: 19 },
      toolName: { color: theme.colors.foreground, fontFamily: "monospace", flex: 1 },
      toolCount: { color: theme.colors.foreground, fontFamily: "monospace", fontWeight: "600" as const },
      statsCard: { gap: compact ? 8 : 10 },
      statsGrid: { flexDirection: "row" as const, flexWrap: "wrap" as const, rowGap: 9 },
      statsMetric: { width: "50%" as const, gap: 2, paddingRight: 6 },
      statsMetricHeading: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5 },
      statsMetricLabel: { color: theme.colors.foregroundMuted, fontSize: 11 },
      statsMetricValue: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 13 },
      statsSectionLabel: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      thoughtLog: { maxHeight: THOUGHT_LOG_MAX_HEIGHT },
      thoughtBlock: { marginVertical: 2 },
      thoughtHeader: {
        alignItems: "center" as const,
        borderColor: theme.colors.border,
        borderRadius: 8,
        borderWidth: 1,
        flexDirection: "row" as const,
        gap: 7,
        paddingHorizontal: 8,
        paddingVertical: 6,
      },
      thoughtHeaderExpanded: {
        backgroundColor: theme.colors.surface2,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
      },
      thoughtBody: {
        backgroundColor: theme.colors.surface0,
        borderBottomLeftRadius: 8,
        borderBottomRightRadius: 8,
        borderColor: theme.colors.border,
        borderTopWidth: 0,
        borderWidth: 1,
        maxHeight: THOUGHT_LOG_MAX_HEIGHT,
        padding: 10,
      },
      thoughtLabel: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 13, flex: 1 },
      thoughtLabelExpanded: { color: theme.colors.foreground },
      outcome: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: compact ? 10 : 14,
        gap: 8,
        backgroundColor: theme.colors.surface1,
      },
      success: { color: theme.colors.statusSuccess },
      active: { color: theme.colors.accent },
      warning: { color: theme.colors.statusWarning },
      error: { color: theme.colors.statusDanger },
    }),
    [compact, theme],
  );
}

function taskStatusIcon(status: SummaryTaskStatus): string {
  if (status === "completed") return "CircleCheck";
  if (status === "in_progress") return "CircleDotDashed";
  return "Circle";
}

function taskStatusColor(status: SummaryTaskStatus, styles: ReturnType<typeof useStyles>): string {
  if (status === "completed") return styles.success.color;
  if (status === "in_progress") return styles.active.color;
  return styles.muted.color;
}

function toolAppearance(tool: ToolFrequency): ToolAppearance {
  return TOOL_APPEARANCES[tool.name] ?? { icon: "Wrench", color: "muted" };
}

function toolColor(appearance: ToolAppearance, styles: ReturnType<typeof useStyles>): string {
  if (appearance.color === "success") return styles.success.color;
  if (appearance.color === "warning") return styles.warning.color;
  if (appearance.color === "accent") return styles.active.color;
  return styles.muted.color;
}

type StatsMetricProps = {
  readonly icon: string;
  readonly label: string;
  readonly value: string;
  readonly styles: ReturnType<typeof useStyles>;
};

function StatsMetric({ icon, label, value, styles }: StatsMetricProps) {
  return (
    <View style={styles.statsMetric}>
      <View style={styles.statsMetricHeading}>
        <Icon name={icon} size={13} color={styles.muted.color} />
        <Text style={styles.statsMetricLabel}>{label}</Text>
      </View>
      <Text style={styles.statsMetricValue}>{value}</Text>
    </View>
  );
}

function SessionStatsCard({ stats, styles }: { stats: SessionStats; styles: ReturnType<typeof useStyles> }) {
  const [now, setNow] = useState(() => Date.now());
  const hasCurrentTurn = stats.currentTurnStartedAt !== null;

  useEffect(() => {
    if (!hasCurrentTurn) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasCurrentTurn]);

  const totalUsage = stats.totalUsage;
  const lastTurnUsage = stats.lastTurnUsage;
  const currentDuration = elapsedDuration(stats.currentTurnStartedAt, now);

  return (
    <View style={[styles.card, styles.statsCard]}>
      <View style={styles.headingStart}>
        <Icon name="Activity" size={16} color={styles.active.color} />
        <Text style={styles.heading}>Session Statistics</Text>
      </View>
      <View style={styles.divider} />
      <Text style={styles.statsSectionLabel}>Total</Text>
      <View style={styles.statsGrid}>
        <StatsMetric icon="ArrowUp" label="Up" value={formatTokenCount(totalUsage?.inputTokens)} styles={styles} />
        <StatsMetric icon="ArrowDown" label="Down" value={formatTokenCount(totalUsage?.outputTokens)} styles={styles} />
        <StatsMetric icon="Database" label="Cache tokens" value={formatTokenCount(totalUsage?.cachedInputTokens)} styles={styles} />
        <StatsMetric icon="Gauge" label="Cache hit rate" value={formatPercent(cacheHitRate(totalUsage))} styles={styles} />
      </View>
      <Text style={styles.statsSectionLabel}>Last Turn</Text>
      <View style={styles.statsGrid}>
        <StatsMetric icon="ArrowUp" label="Up" value={formatTokenCount(lastTurnUsage?.inputTokens)} styles={styles} />
        <StatsMetric icon="ArrowDown" label="Down" value={formatTokenCount(lastTurnUsage?.outputTokens)} styles={styles} />
        <StatsMetric icon="Database" label="Cache tokens" value={formatTokenCount(lastTurnUsage?.cachedInputTokens)} styles={styles} />
        <StatsMetric icon="Gauge" label="Cache hit rate" value={formatPercent(cacheHitRate(lastTurnUsage))} styles={styles} />
      </View>
      <View style={styles.row}>
        <View style={styles.toolRow}>
          <Icon name="Clock" size={13} color={styles.muted.color} />
          <Text style={styles.statsMetricLabel}>Last Turn Duration</Text>
        </View>
        <Text style={styles.statsMetricValue}>{formatDuration(stats.lastTurnDurationMs)}</Text>
      </View>
      <View style={styles.row}>
        <View style={styles.toolRow}>
          <Icon name="Timer" size={13} color={hasCurrentTurn ? styles.active.color : styles.muted.color} />
          <Text style={styles.statsMetricLabel}>Current Turn Duration</Text>
        </View>
        <Text style={styles.statsMetricValue}>{hasCurrentTurn ? formatDuration(currentDuration) : "None"}</Text>
      </View>
    </View>
  );
}

function PromptCard({ prompt, styles, markdownStyles }: {
  prompt: string | null;
  styles: ReturnType<typeof useStyles>;
  markdownStyles: ReturnType<typeof useMarkdownStyles>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!prompt) {
    return (
      <View style={styles.promptCard}>
        <View style={styles.promptHeader}>
          <View style={styles.promptHeading}>
            <Icon name="UserRound" size={16} color={styles.muted.color} />
            <Text style={styles.heading}>You</Text>
          </View>
        </View>
        <Text style={[styles.muted, styles.promptPreview]}>No user prompt is available in the loaded timeline.</Text>
      </View>
    );
  }
  return (
    <View style={styles.promptCard}>
      <Pressable
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} user prompt`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
      >
        <View style={styles.promptHeader}>
          <View style={styles.promptHeading}>
            <Icon name="UserRound" size={16} color={styles.active.color} />
            <Text style={styles.heading}>You</Text>
          </View>
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={16} color={styles.muted.color} />
        </View>
        {!expanded ? <View style={styles.promptPreview}><MarkdownPreview text={prompt} styles={markdownStyles} numberOfLines={PROMPT_PREVIEW_LINES} /></View> : null}
      </Pressable>
      {expanded ? <View style={styles.promptBody}><MarkdownContent text={prompt} styles={markdownStyles} /></View> : null}
    </View>
  );
}

function TasksCard({ summary, styles }: { summary: SessionSummary; styles: ReturnType<typeof useStyles> }) {
  const [tasksExpanded, setTasksExpanded] = useState(false);
  return (
    <View style={styles.card}>
      <View style={styles.headingRow}>
        <View style={styles.headingStart}>
          <Icon name="ListTodo" size={16} color={styles.active.color} />
          <Text style={styles.heading}>Tasks &amp; Plan</Text>
        </View>
        <Text style={summary.completedTaskCount === summary.tasks.length && summary.tasks.length > 0 ? styles.success : styles.muted}>
          {summary.tasks.length > 0 ? `${summary.completedTaskCount}/${summary.tasks.length}` : "—"}
        </Text>
      </View>
      {summary.tasks.length > 0 ? (
        <>
          <View style={styles.divider} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${tasksExpanded ? "Collapse" : "Expand"} tasks and plan`}
            accessibilityState={{ expanded: tasksExpanded }}
            onPress={() => setTasksExpanded((expanded) => !expanded)}
            style={styles.taskToggle}
          >
            <Icon name="ClipboardList" size={15} color={styles.active.color} />
            <Text style={styles.muted}>{summary.completedTaskCount === summary.tasks.length ? "All tasks complete" : "Show task details"}</Text>
            <Icon name={tasksExpanded ? "ChevronDown" : "ChevronRight"} size={15} color={styles.muted.color} />
          </Pressable>
          {tasksExpanded ? summary.tasks.map((task) => (
            <View key={task.id} style={styles.task}>
              <Icon name={taskStatusIcon(task.status)} size={15} color={taskStatusColor(task.status, styles)} />
              <Text numberOfLines={2} style={task.status === "completed" ? styles.completedTaskText : styles.taskText}>{task.text}</Text>
            </View>
          )) : null}
        </>
      ) : <Text style={styles.muted}>No Todo or plan updates are available for this session.</Text>}
    </View>
  );
}

function ToolsCard({ summary, styles }: { summary: SessionSummary; styles: ReturnType<typeof useStyles> }) {
  return (
    <View style={[styles.card, styles.toolsCard]}>
      <View style={styles.headingRow}>
        <View style={styles.headingStart}>
          <Icon name="Wrench" size={16} color={styles.warning.color} />
          <Text style={styles.heading}>Tools</Text>
        </View>
        <Text style={styles.pill}>{summary.totalToolCalls} {summary.totalToolCalls === 1 ? "call" : "calls"}</Text>
      </View>
      <View style={styles.divider} />
      {summary.tools.length > 0 ? summary.tools.map((tool) => {
        const appearance = toolAppearance(tool);
        return (
          <View key={tool.name} style={styles.row}>
            <View style={styles.toolRow}>
              <Icon name={appearance.icon} size={15} color={toolColor(appearance, styles)} />
              <Text style={styles.toolName}>{tool.name}:</Text>
            </View>
            <Text style={styles.toolCount}>{tool.count}x</Text>
          </View>
        );
      }) : <Text style={styles.muted}>No tool calls yet.</Text>}
    </View>
  );
}

function ThinkingBlock({ label, text, expanded, onToggle, styles, markdownStyles }: {
  label: string;
  text: string;
  expanded: boolean;
  onToggle: () => void;
  styles: ReturnType<typeof useStyles>;
  markdownStyles: ReturnType<typeof useMarkdownStyles>;
}) {
  const revealedText = useRevealedText(text, "complete");
  return (
    <View style={styles.thoughtBlock}>
      <Pressable
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${label}`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={[styles.thoughtHeader, expanded && styles.thoughtHeaderExpanded]}
      >
        <Icon name={expanded ? "ChevronDown" : "Brain"} size={15} color={expanded ? styles.active.color : styles.muted.color} />
        <Text numberOfLines={1} style={[styles.thoughtLabel, expanded && styles.thoughtLabelExpanded]}>{label}</Text>
      </Pressable>
      {expanded ? (
        <ScrollView nestedScrollEnabled showsVerticalScrollIndicator style={styles.thoughtBody}>
          <MarkdownContent text={revealedText} styles={markdownStyles} />
        </ScrollView>
      ) : null}
    </View>
  );
}

function ThoughtLogCard({ summary, styles, markdownStyles }: {
  summary: SessionSummary;
  styles: ReturnType<typeof useStyles>;
  markdownStyles: ReturnType<typeof useMarkdownStyles>;
}) {
  const thoughtLogRef = useRef<ScrollView | null>(null);
  const shouldFollowTail = useRef(true);
  const latestThoughtId = summary.thoughts.at(-1)?.id ?? null;
  const [expandedThoughtId, setExpandedThoughtId] = useState<string | null>(latestThoughtId);

  useEffect(() => {
    setExpandedThoughtId(latestThoughtId);
  }, [latestThoughtId]);

  const scrollToTail = useCallback(() => {
    if (shouldFollowTail.current) thoughtLogRef.current?.scrollToEnd({ animated: false });
  }, []);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    shouldFollowTail.current = layoutMeasurement.height + contentOffset.y >= contentSize.height - 32;
  }, []);

  useEffect(() => {
    const timer = setTimeout(scrollToTail, 0);
    return () => clearTimeout(timer);
  }, [latestThoughtId, scrollToTail, summary.thoughts.length]);

  return (
    <View style={[styles.card, styles.thoughtCard]}>
      <View style={styles.headingStart}>
        <Icon name="Brain" size={16} color={styles.active.color} />
        <Text style={styles.heading}>Thought Log</Text>
      </View>
      <View style={styles.divider} />
      {summary.thoughts.length > 0 ? (
        <ScrollView
          ref={thoughtLogRef}
          nestedScrollEnabled
          onContentSizeChange={scrollToTail}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator
          style={styles.thoughtLog}
        >
          {summary.thoughts.map((thought) => (
            <ThinkingBlock
              key={thought.id}
              label={thought.title ?? "Thinking"}
              text={thought.text}
              expanded={expandedThoughtId === thought.id}
              onToggle={() => setExpandedThoughtId((current) => current === thought.id ? null : thought.id)}
              styles={styles}
              markdownStyles={markdownStyles}
            />
          ))}
        </ScrollView>
      ) : <Text style={styles.muted}>No reasoning entries are available for this session.</Text>}
    </View>
  );
}

export function SessionSummaryPanel({ theme, layout, agentId, host }: PluginAgentPanelProps) {
  const data = useSummaryData(agentId);
  const styles = useStyles(theme, layout.compact);
  const bodyMarkdownStyles = useMarkdownStyles(theme, "body");
  const thoughtMarkdownStyles = useMarkdownStyles(theme, "thought");

  if (data.loading && !data.summary) {
    return <View style={styles.screen}><Text style={styles.muted}>Loading session summary…</Text></View>;
  }
  if (!data.summary) {
    return <View style={styles.screen}><Text style={styles.error}>{data.error ?? "Session summary is unavailable."}</Text></View>;
  }

  const summary = data.summary;
  return (
    <ScrollView contentContainerStyle={styles.screen} accessibilityLabel={`${host.label} session summary`}>
      <PromptCard prompt={summary.initialPrompt} styles={styles} markdownStyles={bodyMarkdownStyles} />
      {data.historyTruncated ? <Text style={styles.muted}>Older timeline entries were capped to keep this dashboard responsive.</Text> : null}
      {data.error ? <Text style={styles.error}>Could not refresh: {data.error}</Text> : null}
      <View style={styles.grid}>
        <View style={styles.toolsColumn}>
          <SessionStatsCard stats={data.stats} styles={styles} />
          <TasksCard summary={summary} styles={styles} />
          <ToolsCard summary={summary} styles={styles} />
        </View>
        <ThoughtLogCard summary={summary} styles={styles} markdownStyles={thoughtMarkdownStyles} />
      </View>
      <View style={styles.outcome}>
        <View style={styles.headingStart}>
          <Icon name="Sparkles" size={16} color={styles.success.color} />
          <Text style={styles.heading}>Outcome / Summary of Changes</Text>
        </View>
        {summary.outcome ? <MarkdownContent text={summary.outcome} styles={bodyMarkdownStyles} /> : <Text style={styles.muted}>The agent has not produced a final response yet.</Text>}
      </View>
    </ScrollView>
  );
}
