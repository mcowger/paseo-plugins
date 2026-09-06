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
  formatTokenCount,
  type SessionStats,
  type SessionSummary,
  type SummaryTaskStatus,
  type ToolFrequency,
} from "../shared/summary";
import { MarkdownContent, MarkdownPreview, useMarkdownStyles } from "./markdown";
import { useSummaryData } from "./use-summary-data";

const THOUGHT_BLOCK_MAX_HEIGHT = 320;
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
        flexGrow: 1,
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
      grid: {
        flex: compact ? undefined : 1,
        flexDirection: compact ? "column" as const : "row" as const,
        gap: compact ? 10 : 14,
        minHeight: compact ? undefined : 0,
      },
      compactOverview: { flex: 1, gap: 10, minHeight: 0 },
      toolsColumn: { flex: compact ? undefined : 1, gap: compact ? 10 : 14, minHeight: compact ? undefined : 0 },
      card: {
        gap: compact ? 8 : 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: compact ? 10 : 14,
        backgroundColor: theme.colors.surface1,
      },
      toolsCard: { flex: compact ? undefined : 1 },
      thoughtCard: { flex: compact ? undefined : 2, minHeight: compact ? undefined : 0 },
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
      statsCard: { paddingVertical: compact ? 8 : 10 },
      statsSingleLine: { alignItems: "center" as const, flexDirection: "row" as const, gap: 8 },
      statsValues: { flex: 1, flexDirection: "row" as const, gap: 10, justifyContent: "flex-end" as const, minWidth: 0 },
      statsValue: { color: theme.colors.foregroundMuted, flexShrink: 1, fontFamily: "monospace", fontSize: compact ? 11 : 12 },
      compactThought: { gap: 5 },
      compactThoughtCard: { flex: 1, minHeight: 110 },
      compactThoughtText: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: compact ? 12 : 13, lineHeight: compact ? 17 : 19 },
      compactToolList: { gap: 5 },
      compactToolRow: { alignItems: "center" as const, flexDirection: "row" as const, gap: 7 },
      compactToolName: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12, width: 58 },
      compactToolSummary: { color: theme.colors.foregroundMuted, flex: 1, fontFamily: "monospace", fontSize: 12 },
      thoughtLog: {
        flex: compact ? undefined : 1,
        maxHeight: compact ? THOUGHT_BLOCK_MAX_HEIGHT : undefined,
        minHeight: 0,
      },
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
        maxHeight: THOUGHT_BLOCK_MAX_HEIGHT,
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
      detailsSection: { gap: compact ? 10 : 14 },
      detailsToggle: {
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        borderWidth: 1,
        flexDirection: "row" as const,
        gap: 8,
        justifyContent: "space-between" as const,
        padding: compact ? 10 : 14,
      },
      detailsToggleStart: { alignItems: "center" as const, flexDirection: "row" as const, gap: 7 },
      detailsContent: { gap: compact ? 10 : 14 },
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

function SessionStatsCard({ stats, styles }: { stats: SessionStats; styles: ReturnType<typeof useStyles> }) {
  const contextUsage = stats.totalUsage?.contextWindowUsedTokens ?? stats.lastTurnUsage?.contextWindowUsedTokens;
  const contextLimit = stats.totalUsage?.contextWindowMaxTokens ?? stats.lastTurnUsage?.contextWindowMaxTokens;
  const lastTurnUsage = stats.lastTurnUsage ?? stats.totalUsage;
  const contextLabel = contextLimit === undefined
    ? formatTokenCount(contextUsage)
    : `${formatTokenCount(contextUsage)} / ${formatTokenCount(contextLimit)}`;

  return (
    <View style={[styles.card, styles.statsCard]}>
      <View style={styles.statsSingleLine}>
        <Icon name="Activity" size={16} color={styles.active.color} />
        <Text style={styles.heading}>Session Statistics</Text>
        <View style={styles.statsValues}>
          <Text numberOfLines={1} style={styles.statsValue}>Context {contextLabel}</Text>
          <Text numberOfLines={1} style={styles.statsValue}>
            Last ↑{formatTokenCount(lastTurnUsage?.inputTokens)} ↓{formatTokenCount(lastTurnUsage?.outputTokens)} C{formatTokenCount(lastTurnUsage?.cachedInputTokens)}
          </Text>
        </View>
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

function ToolsSummaryCard({ summary, styles }: { summary: SessionSummary; styles: ReturnType<typeof useStyles> }) {
  return (
    <View style={styles.card}>
      <View style={styles.headingRow}>
        <View style={styles.headingStart}>
          <Icon name="Wrench" size={16} color={styles.warning.color} />
          <Text style={styles.heading}>Tools</Text>
        </View>
        <Text style={styles.pill}>{summary.totalToolCalls} {summary.totalToolCalls === 1 ? "call" : "calls"}</Text>
      </View>
      {summary.recentToolCalls.length > 0 ? (
        <View style={styles.compactToolList}>
          {summary.recentToolCalls.slice(0, 2).map((call) => {
            const appearance = toolAppearance({ name: call.name, count: 1 });
            return (
              <View key={call.id} style={styles.compactToolRow}>
                <Icon name={appearance.icon} size={13} color={toolColor(appearance, styles)} />
                <Text numberOfLines={1} style={styles.compactToolName}>{call.name}</Text>
                <Text numberOfLines={1} style={styles.compactToolSummary}>{call.summary}</Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function ThoughtPreviewCard({ summary, styles, markdownStyles }: {
  summary: SessionSummary;
  styles: ReturnType<typeof useStyles>;
  markdownStyles: ReturnType<typeof useMarkdownStyles>;
}) {
  const latestThought = summary.thoughts.at(-1);
  return (
    <View style={[styles.card, styles.compactThoughtCard]}>
      <View style={styles.headingStart}>
        <Icon name="Brain" size={16} color={styles.active.color} />
        <Text style={styles.heading}>Thought Log</Text>
      </View>
      {latestThought ? (
        <View style={styles.compactThought}>
          <MarkdownPreview text={latestThought.text} styles={markdownStyles} numberOfLines={4} />
        </View>
      ) : <Text style={styles.muted}>No reasoning entries yet.</Text>}
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

function OutcomeCard({ summary, styles, markdownStyles }: {
  summary: SessionSummary;
  styles: ReturnType<typeof useStyles>;
  markdownStyles: ReturnType<typeof useMarkdownStyles>;
}) {
  return (
    <View style={styles.outcome}>
      <View style={styles.headingStart}>
        <Icon name="Sparkles" size={16} color={styles.success.color} />
        <Text style={styles.heading}>Outcome / Summary of Changes</Text>
      </View>
      {summary.outcome ? <MarkdownContent text={summary.outcome} styles={markdownStyles} /> : <Text style={styles.muted}>The agent has not produced a final response yet.</Text>}
    </View>
  );
}

function DetailsSection({ summary, styles, markdownStyles }: {
  summary: SessionSummary;
  styles: ReturnType<typeof useStyles>;
  markdownStyles: ReturnType<typeof useMarkdownStyles>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.detailsSection}>
      <Pressable
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} session details`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
        style={styles.detailsToggle}
      >
        <View style={styles.detailsToggleStart}>
          <Icon name="List" size={16} color={styles.active.color} />
          <Text style={styles.heading}>Details</Text>
        </View>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={16} color={styles.muted.color} />
      </Pressable>
      {expanded ? (
        <View style={styles.detailsContent}>
          <ToolsCard summary={summary} styles={styles} />
          <ThoughtLogCard summary={summary} styles={styles} markdownStyles={markdownStyles} />
          <OutcomeCard summary={summary} styles={styles} markdownStyles={markdownStyles} />
        </View>
      ) : null}
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
      {layout.compact ? (
        <View style={styles.compactOverview}>
          <SessionStatsCard stats={data.stats} styles={styles} />
          <TasksCard summary={summary} styles={styles} />
          <ThoughtPreviewCard summary={summary} styles={styles} markdownStyles={thoughtMarkdownStyles} />
          <ToolsSummaryCard summary={summary} styles={styles} />
          <DetailsSection summary={summary} styles={styles} markdownStyles={thoughtMarkdownStyles} />
        </View>
      ) : (
        <>
          <View style={styles.grid}>
            <View style={styles.toolsColumn}>
              <SessionStatsCard stats={data.stats} styles={styles} />
              <TasksCard summary={summary} styles={styles} />
              <ToolsCard summary={summary} styles={styles} />
            </View>
            <ThoughtLogCard summary={summary} styles={styles} markdownStyles={thoughtMarkdownStyles} />
          </View>
          <OutcomeCard summary={summary} styles={styles} markdownStyles={bodyMarkdownStyles} />
        </>
      )}
    </ScrollView>
  );
}
