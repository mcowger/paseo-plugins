import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useRevealedText } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  Text,
  View,
  type ScrollView as NativeScrollView,
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

const ACTIVITY_SECTION_MAX_HEIGHT = 320;
const ACTIVITY_LIST_MAX_HEIGHT = 280;
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
        gap: compact ? 7 : 10,
        padding: compact ? 8 : 12,
        backgroundColor: theme.colors.surface0,
      },
      promptCard: { gap: 3 },
      promptHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 5,
        paddingVertical: 2,
      },
      promptHeading: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5 },
      promptPreview: { paddingLeft: 17, paddingTop: 1 },
      promptBody: {
        borderLeftColor: theme.colors.border,
        borderLeftWidth: 1,
        marginLeft: 5,
        paddingLeft: 11,
        paddingVertical: 3,
      },
      grid: {
        alignItems: compact ? "stretch" as const : "flex-start" as const,
        flexDirection: compact ? "column" as const : "row" as const,
        gap: compact ? 7 : 10,
        minHeight: compact ? undefined : 0,
      },
      compactOverview: { flex: 1, gap: 7, minHeight: 0 },
      toolsColumn: { flex: compact ? undefined : 1, gap: compact ? 7 : 10, minHeight: compact ? undefined : 0 },
      card: { gap: compact ? 4 : 6 },

      toolsCard: { maxHeight: ACTIVITY_SECTION_MAX_HEIGHT },
      toolsList: { maxHeight: ACTIVITY_LIST_MAX_HEIGHT },
      thoughtCard: { flex: compact ? undefined : 2, maxHeight: ACTIVITY_SECTION_MAX_HEIGHT, minHeight: compact ? undefined : 0 },
      headingRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 5 },
      headingStart: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5, flexShrink: 1 },
      title: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12, fontWeight: "600" as const, lineHeight: 17 },
      heading: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12, fontWeight: "600" as const, lineHeight: 17 },
      muted: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 12, lineHeight: 17 },
      pill: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10, lineHeight: 14 },
      divider: { height: 1, backgroundColor: theme.colors.border, marginVertical: 1 },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, gap: 5, minHeight: 17 },
      toolRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5 },
      taskToggle: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5, minHeight: 17 },
      task: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 5, paddingLeft: 5 },
      taskText: { color: theme.colors.foreground, flex: 1, fontFamily: "monospace", fontSize: 12, lineHeight: 17 },
      completedTaskText: { color: theme.colors.foregroundMuted, flex: 1, fontFamily: "monospace", fontSize: 12, lineHeight: 17 },
      toolName: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12, lineHeight: 17, flex: 1 },
      toolCount: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 11, fontWeight: "600" as const, lineHeight: 16 },
      statsCard: { gap: 3 },
      statsValue: { color: theme.colors.foreground, flexShrink: 1, fontFamily: "monospace", fontSize: 11, lineHeight: 15 },
      compactThought: { gap: 3, paddingLeft: 17 },
      compactThoughtCard: { flex: 1, minHeight: 0 },
      compactThoughtText: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12, lineHeight: 17 },
      compactToolList: { gap: 2, paddingLeft: 17 },
      compactToolRow: { alignItems: "center" as const, flexDirection: "row" as const, gap: 5, minHeight: 17 },
      compactToolName: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12, lineHeight: 17, width: 58 },
      compactToolSummary: { color: theme.colors.foregroundMuted, flex: 1, fontFamily: "monospace", fontSize: 12, lineHeight: 17 },
      thoughtLog: {
        flex: compact ? undefined : 1,
        maxHeight: ACTIVITY_LIST_MAX_HEIGHT,
        minHeight: 0,
      },
      thoughtBlock: { marginVertical: 1 },
      thoughtHeader: {
        alignItems: "center" as const,
        flexDirection: "row" as const,
        gap: 5,
        minHeight: 21,
        paddingVertical: 2,
      },
      thoughtHeaderExpanded: {},
      thoughtBody: {
        borderLeftColor: theme.colors.border,
        borderLeftWidth: 1,
        marginLeft: 5,
        maxHeight: ACTIVITY_SECTION_MAX_HEIGHT,
        paddingLeft: 11,
        paddingVertical: 3,
      },
      thoughtLabel: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 12, lineHeight: 17, flex: 1 },
      thoughtLabelExpanded: { color: theme.colors.foreground },
      outcome: {
        borderLeftColor: theme.colors.border,
        borderLeftWidth: 1,
        gap: 3,
        marginLeft: 5,
        paddingLeft: 11,
        paddingVertical: 2,
      },
      detailsSection: { gap: 3 },
      detailsToggle: {
        alignItems: "center" as const,
        flexDirection: "row" as const,
        gap: 5,
        justifyContent: "space-between" as const,
        minHeight: 21,
        paddingVertical: 2,
      },
      detailsToggleStart: { alignItems: "center" as const, flexDirection: "row" as const, gap: 5 },
      detailsContent: {
        borderLeftColor: theme.colors.border,
        borderLeftWidth: 1,
        gap: compact ? 7 : 10,
        marginLeft: 5,
        paddingLeft: 11,
        paddingVertical: 3,
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

function SessionStatsCard({ stats, styles }: { stats: SessionStats; styles: ReturnType<typeof useStyles> }) {
  const contextUsage = stats.totalUsage?.contextWindowUsedTokens ?? stats.lastTurnUsage?.contextWindowUsedTokens;
  const contextLimit = stats.totalUsage?.contextWindowMaxTokens ?? stats.lastTurnUsage?.contextWindowMaxTokens;
  const lastTurnUsage = stats.lastTurnUsage ?? stats.totalUsage;
  const contextLabel = contextLimit === undefined
    ? formatTokenCount(contextUsage)
    : `${formatTokenCount(contextUsage)} / ${formatTokenCount(contextLimit)}`;

  return (
    <View style={[styles.card, styles.statsCard]}>
      <View style={styles.headingRow}>
        <View style={styles.headingStart}>
          <Icon name="Activity" size={12} color={styles.active.color} />
          <Text style={styles.heading}>Tokens</Text>
        </View>
      </View>
      <View style={styles.divider} />
      <View style={styles.row}>
        <Text style={styles.muted}>Context</Text>
        <Text numberOfLines={1} style={styles.statsValue}>{contextLabel}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.muted}>Last turn</Text>
        <Text numberOfLines={1} style={styles.statsValue}>
          ↑{formatTokenCount(lastTurnUsage?.inputTokens)} ↓{formatTokenCount(lastTurnUsage?.outputTokens)} C{formatTokenCount(lastTurnUsage?.cachedInputTokens)}
        </Text>
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
            <Icon name="UserRound" size={12} color={styles.muted.color} />
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
            <Icon name="UserRound" size={12} color={styles.active.color} />
            <Text style={styles.heading}>You</Text>
          </View>
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={12} color={styles.muted.color} />
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
          <Icon name="ListTodo" size={12} color={styles.active.color} />
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
            <Icon name="ClipboardList" size={12} color={styles.active.color} />
            <Text style={styles.muted}>{summary.completedTaskCount === summary.tasks.length ? "All tasks complete" : "Show task details"}</Text>
            <Icon name={tasksExpanded ? "ChevronDown" : "ChevronRight"} size={12} color={styles.muted.color} />
          </Pressable>
          {tasksExpanded ? summary.tasks.map((task) => (
            <View key={task.id} style={styles.task}>
              <Icon name={taskStatusIcon(task.status)} size={12} color={taskStatusColor(task.status, styles)} />
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
          <Icon name="Wrench" size={12} color={styles.warning.color} />
          <Text style={styles.heading}>Tools</Text>
        </View>
        <Text style={styles.pill}>{summary.totalToolCalls} {summary.totalToolCalls === 1 ? "call" : "calls"}</Text>
      </View>
      <View style={styles.divider} />
      {summary.tools.length > 0 ? (
        <ScrollView nestedScrollEnabled showsVerticalScrollIndicator style={styles.toolsList}>
          {summary.tools.map((tool) => {
            const appearance = toolAppearance(tool);
            return (
              <View key={tool.name} style={styles.row}>
                <View style={styles.toolRow}>
                  <Icon name={appearance.icon} size={12} color={toolColor(appearance, styles)} />
                  <Text style={styles.toolName}>{tool.name}:</Text>
                </View>
                <Text style={styles.toolCount}>{tool.count}x</Text>
              </View>
            );
          })}
        </ScrollView>
      ) : <Text style={styles.muted}>No tool calls yet.</Text>}
    </View>
  );
}

function ToolsSummaryCard({ summary, styles }: { summary: SessionSummary; styles: ReturnType<typeof useStyles> }) {
  return (
    <View style={styles.card}>
      <View style={styles.headingRow}>
        <View style={styles.headingStart}>
          <Icon name="Wrench" size={12} color={styles.warning.color} />
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
                <Icon name={appearance.icon} size={11} color={toolColor(appearance, styles)} />
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
        <Icon name={expanded ? "ChevronDown" : "Brain"} size={12} color={expanded ? styles.active.color : styles.muted.color} />
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
  const thoughtLogRef = useRef<NativeScrollView | null>(null);
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
        <Icon name="Brain" size={12} color={styles.active.color} />
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
        <Icon name="Sparkles" size={12} color={styles.success.color} />
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
          <Icon name="List" size={12} color={styles.active.color} />
          <Text style={styles.heading}>Details</Text>
        </View>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={12} color={styles.muted.color} />
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
