import type { PaseoAgentSendOptions } from "@getpaseo/client";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  usePaseo,
  useRpc,
  type PluginHostProps,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type {
  AgentTaskItem,
  AgentTimelineItem,
  ToolCallTimelineItem,
} from "@getpaseo/protocol/agent-types";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Platform,
  RefreshControl,
  ScrollView,
  Text,
  View,
  type GestureResponderEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { TooltipPressable as Pressable } from "../ui/tooltip";
import { isAgentStream } from "../timeline-events";
import { openAgentInPaseoWorkspace } from "./navigation";
import {
  cancelWorkspaceAgent,
  getProviderSubagentTimeline,
  listWorkspaceProviderSubagents,
  type ProviderSubagentItem,
} from "../../shared/agents/control";
import {
  AgentActionBar,
  AgentStatusIndicator,
  SteerComposer,
  WorkingIndicator,
  statusDotColor,
} from "./controls";

const NOOP_HANDLER = (): void => {};
const NOOP_EVENT_HANDLER = (_event: GestureResponderEvent): void => {};
const NOOP_SUBMIT_HANDLER = async (_text: string): Promise<void> => {};
const TOOL_DETAIL_STACK_STYLE: ViewStyle = { gap: 2 };
const TOOL_ERROR_STACK_STYLE: ViewStyle = { gap: 2, marginTop: 4 };
const AGENT_TITLE_COLUMN_STYLE: ViewStyle = { flexShrink: 1 };
const SECTION_CONTAINER_STYLE: ViewStyle = { gap: 8 };
const TOUCH_HIT_SLOP = { top: 10, right: 10, bottom: 10, left: 10 } as const;
const MONOSPACE_FONT_FAMILY = Platform.select({ ios: "Menlo", default: "monospace" });

/** Nested-subagent counts shown on a parent card while its group is folded. */
export interface ChildSummary {
  readonly count: number;
  readonly running: number;
}

const EMPTY_CHILD_SUMMARY: ChildSummary = { count: 0, running: 0 };

export interface SubagentViewModel {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentAgentId: string | null;
  readonly isMain: boolean;
  readonly isProviderSubagent?: boolean;
  readonly title: string;
  readonly cwd: string;
  readonly provider: string;
  readonly model: string | null;
  readonly status: "initializing" | "idle" | "running" | "error" | "closed";
  readonly requiresAttention: boolean;
  readonly attentionReason: "finished" | "error" | "permission" | null;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
  /** Start of the active turn, used for the elapsed counter while running. */
  readonly turnStartedAt: string | null;
  readonly lastActivityAt: string;
  readonly recentActivitySummary: string | null;
}

export interface TimelineEntryItem {
  readonly id: string;
  readonly timestamp: string;
  readonly item: AgentTimelineItem;
}

export interface SubagentsPanelStyles {
  readonly screen: ViewStyle;
  readonly header: ViewStyle;
  readonly headerTitle: TextStyle;
  readonly headerActions: ViewStyle;
  readonly refreshButton: ViewStyle;
  readonly refreshButtonDisabled: ViewStyle;
  readonly scrollArea: ViewStyle;
  readonly scrollContent: ViewStyle;
  readonly sectionLabel: TextStyle;
  readonly nestedGroup: ViewStyle;
  readonly nestedEmptyText: TextStyle;
  readonly childSummaryRow: ViewStyle;
  readonly childSummaryText: TextStyle;
  readonly summaryStats: ViewStyle;
  readonly summaryStatItem: ViewStyle;
  readonly summaryStatItemSelected: ViewStyle;
  readonly summaryStatValue: TextStyle;
  readonly summaryStatLabel: TextStyle;
  readonly agentCard: ViewStyle;
  readonly agentCardHeader: ViewStyle;
  readonly agentIdentity: ViewStyle;
  readonly agentTitleText: TextStyle;
  readonly agentMetaText: TextStyle;
  readonly badgeRow: ViewStyle;
  readonly statusBadge: ViewStyle;
  readonly statusBadgeText: TextStyle;
  readonly attentionBadge: ViewStyle;
  readonly attentionBadgeText: TextStyle;
  readonly cardErrorBanner: ViewStyle;
  readonly cardErrorText: TextStyle;
  readonly cardExpandedContent: ViewStyle;
  readonly timelineContainer: ViewStyle;
  readonly timelineHeader: ViewStyle;
  readonly timelineTitle: TextStyle;
  readonly timelineLoading: ViewStyle;
  readonly timelineEmpty: TextStyle;
  readonly timelineScroll: ViewStyle;
  readonly timelineScrollContent: ViewStyle;
  readonly showEarlierButton: ViewStyle;
  readonly showEarlierText: TextStyle;
  readonly timelineMessage: ViewStyle;
  readonly messageRoleLabel: TextStyle;
  readonly userMessageContent: ViewStyle;
  readonly assistantMessageContent: ViewStyle;
  readonly messageText: TextStyle;
  readonly reasoningBox: ViewStyle;
  readonly reasoningHeader: ViewStyle;
  readonly reasoningTitle: TextStyle;
  readonly reasoningText: TextStyle;
  readonly todoBox: ViewStyle;
  readonly todoHeader: ViewStyle;
  readonly todoTitle: TextStyle;
  readonly todoList: ViewStyle;
  readonly todoRow: ViewStyle;
  readonly todoText: TextStyle;
  readonly todoCompletedText: TextStyle;
  readonly errorBox: ViewStyle;
  readonly errorTitle: TextStyle;
  readonly errorText: TextStyle;
  readonly toolCallCard: ViewStyle;
  readonly toolCallHeader: ViewStyle;
  readonly toolCallTitle: ViewStyle;
  readonly toolCallName: TextStyle;
  readonly toolCallSummary: TextStyle;
  readonly toolCallStatusBadge: ViewStyle;
  readonly toolCallStatusText: TextStyle;
  readonly toolCallDetails: ViewStyle;
  readonly toolCallDetailRow: ViewStyle;
  readonly toolCallDetailLabel: TextStyle;
  readonly toolCallDetailValue: TextStyle;
  readonly codeBlock: ViewStyle;
  readonly codeText: TextStyle;
  readonly stateContainer: ViewStyle;
  readonly stateTitle: TextStyle;
  readonly stateSubtitle: TextStyle;
  readonly errorContainer: ViewStyle;
  readonly errorSubtitle: TextStyle;
  readonly retryButton: ViewStyle;
  readonly retryButtonText: TextStyle;
}

export type SubagentStatusFilter = "main" | "all" | "attention" | "running" | "idle" | "archived";

type TimerHandle = ReturnType<typeof setTimeout>;

function isSubagentActiveOrAttention(agent: {
  status: string;
  requiresAttention?: boolean;
  attentionReason?: string | null;
}): boolean {
  if (agent.requiresAttention) {
    return true;
  }
  if (agent.attentionReason) {
    return true;
  }
  return (
    agent.status === "running" ||
    agent.status === "initializing" ||
    agent.status === "idle" ||
    agent.status === "error"
  );
}

function formatRelativeTime(isoDateString: string | null | undefined): string {
  if (!isoDateString) return "";
  const parsed = Date.parse(isoDateString);
  if (Number.isNaN(parsed)) return "";
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (elapsedSeconds < 60) return "just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getToolCallSummary(toolCall: ToolCallTimelineItem): string {
  const detail = toolCall.detail;
  if (!detail) return "";
  switch (detail.type) {
    case "shell":
      return detail.command ? detail.command.slice(0, 60) : "";
    case "read":
    case "write":
    case "edit":
      return detail.filePath || "";
    case "search":
      return detail.query || "";
    case "fetch":
      return detail.url || "";
    case "sub_agent":
      return detail.description || detail.subAgentType || "";
    case "plan":
      return detail.text ? detail.text.slice(0, 60) : "";
    case "plain_text":
      return detail.label || (detail.text ? detail.text.slice(0, 60) : "");
    case "worktree_setup":
      return detail.branchName || detail.worktreePath || "";
    case "unknown":
      return "";
    default:
      return "";
  }
}

function extractRecentActivitySummary(items: readonly AgentTimelineItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.type === "assistant_message" && item.text) {
      const line = item.text.trim().split("\n")[0]?.trim();
      if (line) return line.length > 80 ? `${line.slice(0, 77)}...` : line;
    }
    if (item.type === "tool_call") {
      const summary = getToolCallSummary(item);
      return `Tool: ${item.name}${summary ? ` (${summary})` : ""}`;
    }
    if (item.type === "reasoning" && item.text) {
      const line = item.text.trim().split("\n")[0]?.trim();
      if (line) return `Reasoning: ${line.length > 70 ? `${line.slice(0, 67)}...` : line}`;
    }
    if (item.type === "error" && item.message) {
      return `Error: ${item.message.slice(0, 60)}`;
    }
    if (item.type === "user_message" && item.text) {
      const line = item.text.trim().split("\n")[0]?.trim();
      if (line) return `Prompt: ${line.length > 70 ? `${line.slice(0, 67)}...` : line}`;
    }
  }
  return null;
}

function formatSafeObjectText(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return "[Unserializable data]";
  }
}

function createStyles(theme: PluginTheme, compact: boolean): SubagentsPanelStyles {
  const padding = compact ? 10 : 14;
  const gap = compact ? 8 : 12;
  const fontSize = 14;
  const smallFontSize = 12;
  const detailFontSize = 11;

  return {
    screen: {
      flex: 1,
      backgroundColor: theme.colors.surface0,
    },
    header: {
      minHeight: compact ? 56 : 36,
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap,
      paddingHorizontal: padding,
      paddingVertical: compact ? 8 : 6,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    headerTitle: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: compact ? "400" : "300",
    },
    headerActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    refreshButton: {
      width: compact ? 32 : 26,
      height: compact ? 32 : 26,
      borderRadius: 6,
      backgroundColor: "transparent",
      justifyContent: "center",
      alignItems: "center",
    },
    refreshButtonDisabled: {
      opacity: 0.5,
    },
    scrollArea: {
      flex: 1,
    },
    scrollContent: {
      padding,
      gap,
    },
    sectionLabel: {
      fontSize: 12,
      color: theme.colors.foregroundMuted,
      fontWeight: "400",
      marginLeft: 4,
      marginBottom: 8,
    },
    nestedGroup: {
      marginLeft: compact ? 14 : 22,
      paddingLeft: compact ? 10 : 14,
      borderLeftWidth: 1,
      borderLeftColor: theme.colors.border,
      gap,
    },
    nestedEmptyText: {
      fontSize: 12,
      color: theme.colors.foregroundMuted,
      fontStyle: "italic",
      paddingVertical: 4,
    },
    childSummaryRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 4,
    },
    childSummaryText: {
      fontSize: smallFontSize,
      color: theme.colors.foregroundMuted,
      fontWeight: "400",
    },
    summaryStats: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      backgroundColor: theme.colors.surface1,
      padding: compact ? 8 : 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    summaryStatItem: {
      flex: 1,
      minWidth: compact ? 72 : 88,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: compact ? 6 : 8,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: "transparent",
    },
    summaryStatItemSelected: {
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
    },
    summaryStatValue: {
      color: theme.colors.foreground,
      fontSize: compact ? 16 : 18,
      fontWeight: "400",
      fontVariant: ["tabular-nums"],
    },
    summaryStatLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
      marginTop: 2,
    },
    agentCard: {
      backgroundColor: theme.colors.surface1,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      overflow: "hidden",
    },
    agentCardHeader: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: padding,
      paddingVertical: compact ? 8 : 10,
      backgroundColor: "transparent",
      gap: 8,
    },
    agentIdentity: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexShrink: 1,
    },
    agentTitleText: {
      color: theme.colors.foreground,
      fontSize,
      fontWeight: "400",
    },
    agentMetaText: {
      color: theme.colors.foregroundMuted,
      fontSize: smallFontSize,
      marginTop: 2,
    },
    badgeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flexWrap: "wrap",
    },
    statusBadge: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 9999,
      backgroundColor: theme.colors.surface2,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    statusBadgeText: {
      color: theme.colors.foregroundMuted,
      fontSize: smallFontSize,
      fontWeight: "400",
      textTransform: "capitalize",
    },
    attentionBadge: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 9999,
      backgroundColor: theme.colors.statusWarning,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    attentionBadgeText: {
      color: theme.colors.accentForeground,
      fontSize: detailFontSize,
      fontWeight: "500",
    },
    cardErrorBanner: {
      paddingHorizontal: padding,
      paddingVertical: 4,
      backgroundColor: theme.colors.surface2,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    cardErrorText: {
      color: theme.colors.statusDanger,
      fontSize: 12,
      fontWeight: "400",
    },
    cardExpandedContent: {
      padding,
      gap,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    timelineContainer: {
      gap: 8,
    },
    timelineHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    timelineTitle: {
      color: theme.colors.foreground,
      fontSize: smallFontSize,
      fontWeight: "500",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    timelineLoading: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 12,
    },
    timelineEmpty: {
      color: theme.colors.foregroundMuted,
      fontSize: smallFontSize,
      fontStyle: "italic",
      paddingVertical: 8,
    },
    timelineScroll: {
      maxHeight: compact ? 240 : 380,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface0,
    },
    timelineScrollContent: {
      padding: compact ? 8 : 10,
      gap: 8,
    },
    showEarlierButton: {
      alignSelf: "center",
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 9999,
      backgroundColor: theme.colors.surface2,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    showEarlierText: {
      color: theme.colors.foregroundMuted,
      fontSize: smallFontSize,
      fontWeight: "400",
    },
    timelineMessage: {
      padding: compact ? 8 : 10,
      borderRadius: 8,
      gap: 4,
    },
    messageRoleLabel: {
      fontSize: detailFontSize,
      fontWeight: "500",
      textTransform: "uppercase",
      color: theme.colors.foregroundMuted,
    },
    userMessageContent: {
      backgroundColor: theme.colors.surface2,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.accent,
    },
    assistantMessageContent: {
      backgroundColor: theme.colors.surface1,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.foregroundMuted,
    },
    messageText: {
      color: theme.colors.foreground,
      fontSize: smallFontSize,
      lineHeight: smallFontSize + 5,
    },
    reasoningBox: {
      padding: compact ? 6 : 8,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
      borderLeftWidth: 2,
      borderLeftColor: theme.colors.statusWarning,
      gap: 4,
    },
    reasoningHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    reasoningTitle: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
      fontWeight: "500",
    },
    reasoningText: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
      lineHeight: detailFontSize + 4,
    },
    todoBox: {
      padding: compact ? 6 : 8,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
      borderLeftWidth: 2,
      borderLeftColor: theme.colors.statusSuccess,
      gap: 4,
    },
    todoHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    todoTitle: {
      color: theme.colors.foreground,
      fontSize: detailFontSize,
      fontWeight: "500",
    },
    todoList: {
      gap: 4,
      marginTop: 2,
    },
    todoRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    todoText: {
      color: theme.colors.foreground,
      fontSize: detailFontSize,
      flexShrink: 1,
    },
    todoCompletedText: {
      color: theme.colors.foregroundMuted,
      textDecorationLine: "line-through",
    },
    errorBox: {
      padding: compact ? 6 : 8,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
      borderLeftWidth: 2,
      borderLeftColor: theme.colors.statusDanger,
      gap: 2,
    },
    errorTitle: {
      color: theme.colors.statusDanger,
      fontSize: detailFontSize,
      fontWeight: "500",
    },
    errorText: {
      color: theme.colors.statusDanger,
      fontSize: smallFontSize,
    },
    toolCallCard: {
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
      overflow: "hidden",
    },
    toolCallHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      padding: compact ? 6 : 8,
      gap: 6,
    },
    toolCallTitle: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flexShrink: 1,
    },
    toolCallName: {
      color: theme.colors.foreground,
      fontSize: smallFontSize,
      fontWeight: "400",
    },
    toolCallSummary: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
      flexShrink: 1,
    },
    toolCallStatusBadge: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 9999,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    toolCallStatusText: {
      fontSize: detailFontSize - 1,
      fontWeight: "400",
      textTransform: "capitalize",
    },
    toolCallDetails: {
      padding: compact ? 6 : 8,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      gap: 4,
    },
    toolCallDetailRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
    },
    toolCallDetailLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
      fontWeight: "500",
      width: 70,
    },
    toolCallDetailValue: {
      color: theme.colors.foreground,
      fontSize: detailFontSize,
      flex: 1,
    },
    codeBlock: {
      backgroundColor: theme.colors.surface0,
      padding: 6,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      marginTop: 2,
    },
    codeText: {
      color: theme.colors.foreground,
      fontSize: detailFontSize,
      fontFamily: MONOSPACE_FONT_FAMILY,
    },
    stateContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 32,
      gap: 8,
    },
    stateTitle: {
      color: theme.colors.foreground,
      fontSize: compact ? 14 : 16,
      fontWeight: "400",
    },
    stateSubtitle: {
      color: theme.colors.foregroundMuted,
      fontSize: smallFontSize,
      textAlign: "center",
    },
    errorContainer: {
      padding,
      backgroundColor: theme.colors.surface1,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.statusDanger,
      gap: 6,
      margin: padding,
    },
    errorSubtitle: {
      color: theme.colors.foregroundMuted,
      fontSize: smallFontSize,
    },
    retryButton: {
      alignSelf: "flex-start",
      paddingVertical: 6,
      paddingHorizontal: 12,
      backgroundColor: theme.colors.surface2,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 6,
      marginTop: 4,
    },
    retryButtonText: {
      color: theme.colors.foreground,
      fontSize: smallFontSize,
      fontWeight: "400",
    },
  };
}

function ToolCallRow({
  toolCall,
  theme,
  styles,
}: {
  readonly toolCall: ToolCallTimelineItem;
  readonly theme: PluginTheme;
  readonly styles: SubagentsPanelStyles;
}): ReactElement {
  const [expanded, setExpanded] = useState<boolean>(false);
  const summary = getToolCallSummary(toolCall);
  const handleToggleExpanded = useCallback(() => setExpanded((previous) => !previous), []);

  const statusBg =
    toolCall.status === "completed"
      ? theme.colors.surface1
      : toolCall.status === "running"
        ? theme.colors.accent
        : toolCall.status === "failed"
          ? theme.colors.statusDanger
          : theme.colors.surface2;

  const statusText =
    toolCall.status === "completed"
      ? theme.colors.statusSuccess
      : toolCall.status === "running"
        ? theme.colors.accentForeground
        : toolCall.status === "failed"
          ? theme.colors.accentForeground
          : theme.colors.foregroundMuted;

  const detail = toolCall.detail;

  return (
    <View style={styles.toolCallCard}>
      <Pressable
        tooltip={`${expanded ? "Collapse" : "Expand"} ${toolCall.name} details`}
        accessibilityRole="button"
        accessibilityLabel={`Tool call ${toolCall.name}, status ${toolCall.status}. Press to ${
          expanded ? "collapse" : "expand"
        } details.`}
        onPress={handleToggleExpanded}
        style={styles.toolCallHeader}
      >
        <View style={styles.toolCallTitle}>
          <Icon
            name={expanded ? "ChevronDown" : "ChevronRight"}
            size={12}
            color={theme.colors.foregroundMuted}
          />
          <Icon name="Wrench" size={13} color={theme.colors.accent} />
          <Text style={styles.toolCallName}>{toolCall.name}</Text>
          {summary ? (
            <Text style={styles.toolCallSummary} numberOfLines={1}>
              {summary}
            </Text>
          ) : null}
        </View>
        <View style={[styles.toolCallStatusBadge, { backgroundColor: statusBg }]}>
          <Text style={[styles.toolCallStatusText, { color: statusText }]}>{toolCall.status}</Text>
        </View>
      </Pressable>

      {expanded ? (
        <View style={styles.toolCallDetails}>
          {detail ? (
            <>
              {"filePath" in detail && detail.filePath ? (
                <View style={styles.toolCallDetailRow}>
                  <Text style={styles.toolCallDetailLabel}>File:</Text>
                  <Text style={styles.toolCallDetailValue}>{detail.filePath}</Text>
                </View>
              ) : null}

              {"command" in detail && detail.command ? (
                <View style={TOOL_DETAIL_STACK_STYLE}>
                  <Text style={styles.toolCallDetailLabel}>Command:</Text>
                  <View style={styles.codeBlock}>
                    <Text style={styles.codeText}>{detail.command}</Text>
                  </View>
                </View>
              ) : null}

              {"output" in detail && detail.output ? (
                <View style={TOOL_DETAIL_STACK_STYLE}>
                  <Text style={styles.toolCallDetailLabel}>Output:</Text>
                  <View style={styles.codeBlock}>
                    <Text style={styles.codeText} numberOfLines={12}>
                      {formatSafeObjectText(detail.output)}
                    </Text>
                  </View>
                </View>
              ) : null}

              {"content" in detail && detail.content ? (
                <View style={TOOL_DETAIL_STACK_STYLE}>
                  <Text style={styles.toolCallDetailLabel}>Content:</Text>
                  <View style={styles.codeBlock}>
                    <Text style={styles.codeText} numberOfLines={12}>
                      {detail.content}
                    </Text>
                  </View>
                </View>
              ) : null}

              {"query" in detail && detail.query ? (
                <View style={styles.toolCallDetailRow}>
                  <Text style={styles.toolCallDetailLabel}>Query:</Text>
                  <Text style={styles.toolCallDetailValue}>{detail.query}</Text>
                </View>
              ) : null}

              {"url" in detail && detail.url ? (
                <View style={styles.toolCallDetailRow}>
                  <Text style={styles.toolCallDetailLabel}>URL:</Text>
                  <Text style={styles.toolCallDetailValue}>{detail.url}</Text>
                </View>
              ) : null}

              {"description" in detail && detail.description ? (
                <View style={styles.toolCallDetailRow}>
                  <Text style={styles.toolCallDetailLabel}>Description:</Text>
                  <Text style={styles.toolCallDetailValue}>{detail.description}</Text>
                </View>
              ) : null}

              {detail.type === "unknown" && detail.input !== undefined ? (
                <View style={TOOL_DETAIL_STACK_STYLE}>
                  <Text style={styles.toolCallDetailLabel}>Input:</Text>
                  <View style={styles.codeBlock}>
                    <Text style={styles.codeText} numberOfLines={10}>
                      {formatSafeObjectText(detail.input)}
                    </Text>
                  </View>
                </View>
              ) : null}

              {detail.type === "unknown" && detail.output !== undefined ? (
                <View style={TOOL_DETAIL_STACK_STYLE}>
                  <Text style={styles.toolCallDetailLabel}>Result:</Text>
                  <View style={styles.codeBlock}>
                    <Text style={styles.codeText} numberOfLines={10}>
                      {formatSafeObjectText(detail.output)}
                    </Text>
                  </View>
                </View>
              ) : null}
            </>
          ) : null}

          {toolCall.error ? (
            <View style={TOOL_ERROR_STACK_STYLE}>
              <Text style={[styles.toolCallDetailLabel, { color: theme.colors.statusDanger }]}>
                Error:
              </Text>
              <View
                style={[
                  styles.codeBlock,
                  {
                    borderColor: theme.colors.statusDanger,
                    backgroundColor: theme.colors.surface0,
                  },
                ]}
              >
                <Text style={[styles.codeText, { color: theme.colors.statusDanger }]}>
                  {formatSafeObjectText(toolCall.error)}
                </Text>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const TimelineEntryRow = memo(function TimelineEntryRow({
  entry,
  theme,
  styles,
}: {
  readonly entry: TimelineEntryItem;
  readonly theme: PluginTheme;
  readonly styles: SubagentsPanelStyles;
}): ReactElement | null {
  const item = entry.item;
  if (!item) return null;

  if (item.type === "user_message") {
    return (
      <View style={[styles.timelineMessage, styles.userMessageContent]}>
        <Text style={styles.messageRoleLabel}>User Message</Text>
        <Text style={styles.messageText}>{item.text}</Text>
      </View>
    );
  }

  if (item.type === "assistant_message") {
    return (
      <View style={[styles.timelineMessage, styles.assistantMessageContent]}>
        <Text style={styles.messageRoleLabel}>Assistant</Text>
        <Text style={styles.messageText}>{item.text}</Text>
      </View>
    );
  }

  if (item.type === "reasoning") {
    return (
      <View style={styles.reasoningBox}>
        <View style={styles.reasoningHeader}>
          <Icon name="Brain" size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.reasoningTitle}>Reasoning Summary</Text>
        </View>
        <Text style={styles.reasoningText}>{item.text}</Text>
      </View>
    );
  }

  if (item.type === "todo") {
    const tasks: AgentTaskItem[] = Array.isArray(item.items) ? item.items : [];
    return (
      <View style={styles.todoBox}>
        <View style={styles.todoHeader}>
          <Icon name="ListTodo" size={13} color={theme.colors.foreground} />
          <Text style={styles.todoTitle}>Todos & Checklists</Text>
        </View>
        <View style={styles.todoList}>
          {tasks.map((task, idx) => (
            <View key={task.id || `todo-${idx}`} style={styles.todoRow}>
              <Icon
                name={task.completed ? "CheckCircle2" : "Circle"}
                size={12}
                color={task.completed ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
              />
              <Text style={[styles.todoText, task.completed ? styles.todoCompletedText : null]}>
                {task.text}
              </Text>
            </View>
          ))}
        </View>
      </View>
    );
  }

  if (item.type === "error") {
    return (
      <View style={styles.errorBox}>
        <Text style={styles.errorTitle}>Error</Text>
        <Text style={styles.errorText}>{item.message}</Text>
      </View>
    );
  }

  if (item.type === "tool_call") {
    return <ToolCallRow toolCall={item as ToolCallTimelineItem} theme={theme} styles={styles} />;
  }

  return null;
});

/** Entries rendered when a transcript opens; older ones load on demand. */
const TRANSCRIPT_INITIAL_TAIL = 40;
const TRANSCRIPT_PAGE = 60;
const TRANSCRIPT_MAX_ENTRIES = 300;
/** Live events are coalesced into one render per window. */
const TRANSCRIPT_FLUSH_MS = 80;
/** Distance from the bottom within which new entries keep the view pinned. */
const TRANSCRIPT_PIN_THRESHOLD = 32;

function mergeTimelineEntries(
  previous: readonly TimelineEntryItem[],
  incoming: readonly TimelineEntryItem[],
): readonly TimelineEntryItem[] {
  const next = [...previous];
  for (const entry of incoming) {
    if (entry.item.type === "tool_call") {
      const callId = entry.item.callId;
      const existingIndex = next.findIndex(
        (candidate) => candidate.item.type === "tool_call" && candidate.item.callId === callId,
      );
      if (existingIndex >= 0) {
        next[existingIndex] = entry;
        continue;
      }
    }

    const previousEntry = next[next.length - 1];
    if (entry.item.type === "reasoning" && previousEntry?.item.type === "reasoning") {
      next[next.length - 1] = {
        ...entry,
        id: previousEntry.id,
        item: {
          type: "reasoning",
          text: `${previousEntry.item.text}${entry.item.text}`,
        },
      };
      continue;
    }

    next.push(entry);
  }
  return next.length > TRANSCRIPT_MAX_ENTRIES ? next.slice(-TRANSCRIPT_MAX_ENTRIES) : next;
}

function SubagentTranscriptView({
  agentId,
  parentAgentId,
  isProviderSubagent,
  theme,
  styles,
}: {
  readonly agentId: string;
  readonly parentAgentId?: string | null;
  readonly isProviderSubagent?: boolean;
  readonly theme: PluginTheme;
  readonly styles: SubagentsPanelStyles;
}): ReactElement {
  const paseo = usePaseo();
  const getSubagentTimeline = useRpc(getProviderSubagentTimeline);
  const [timelineEntries, setTimelineEntries] = useState<readonly TimelineEntryItem[]>([]);
  const [visibleCount, setVisibleCount] = useState<number>(TRANSCRIPT_INITIAL_TAIL);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const pinnedToBottomRef = useRef<boolean>(true);
  const pendingRef = useRef<TimelineEntryItem[]>([]);
  const flushTimerRef = useRef<TimerHandle | null>(null);

  const fetchTimeline = useCallback(async () => {
    if (!agentId) return;
    try {
      setError(null);
      if (isProviderSubagent && parentAgentId) {
        const res = await getSubagentTimeline({
          parentAgentId,
          subagentId: agentId,
          limit: 150,
        });
        const parsed: TimelineEntryItem[] = res.entries.map((e, idx) => ({
          id: `entry-${e.seq ?? idx}-${e.timestamp || Date.now()}`,
          timestamp: e.timestamp,
          item: e.item as AgentTimelineItem,
        }));
        setTimelineEntries(mergeTimelineEntries([], [...parsed, ...pendingRef.current]));
        pendingRef.current = [];
        return;
      }
      if (!paseo) return;
      const agentRef = paseo.agents.ref(agentId);
      const res = await agentRef.timeline.refetch({
        direction: "tail",
        limit: 150,
        projection: "projected",
      });

      const parsed: TimelineEntryItem[] = res.entries.map((e, idx) => ({
        id: `entry-${e.seqStart ?? idx}-${e.timestamp || Date.now()}`,
        timestamp: e.timestamp,
        item: e.item as AgentTimelineItem,
      }));

      setTimelineEntries(mergeTimelineEntries([], [...parsed, ...pendingRef.current]));
      pendingRef.current = [];
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to fetch timeline.");
    } finally {
      setLoading(false);
    }
  }, [agentId, getSubagentTimeline, isProviderSubagent, parentAgentId, paseo]);

  useEffect(() => {
    setLoading(true);
    setVisibleCount(TRANSCRIPT_INITIAL_TAIL);
    pinnedToBottomRef.current = true;
    fetchTimeline();

    if (!paseo || !agentId || isProviderSubagent) return;

    const flush = () => {
      flushTimerRef.current = null;
      const batch = pendingRef.current;
      if (batch.length === 0) return;
      pendingRef.current = [];
      setTimelineEntries((previous) => mergeTimelineEntries(previous, batch));
    };

    const agentRef = paseo.agents.ref(agentId);
    const unsubscribe = agentRef.timeline.subscribe((stream) => {
      // A re-established subscription resolves a new epoch, and the transcript held here
      // came from the previous one.
      if (!isAgentStream(stream)) {
        fetchTimeline();
        return;
      }
      if (stream.event.type !== "timeline") return;

      const newItem = stream.event.item as AgentTimelineItem;
      const timestamp = stream.timestamp;
      pendingRef.current.push({
        id:
          newItem.type === "tool_call"
            ? `tool-${newItem.callId}`
            : `stream-${stream.seq ?? timestamp}`,
        timestamp,
        item: newItem,
      });
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(flush, TRANSCRIPT_FLUSH_MS);
      }
    });

    return () => {
      unsubscribe();
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingRef.current = [];
    };
  }, [agentId, fetchTimeline, isProviderSubagent, paseo]);

  const hiddenCount = Math.max(0, timelineEntries.length - visibleCount);
  const visibleEntries = useMemo(
    () => (hiddenCount > 0 ? timelineEntries.slice(hiddenCount) : timelineEntries),
    [timelineEntries, hiddenCount],
  );

  const handleShowEarlier = useCallback(() => {
    pinnedToBottomRef.current = false;
    setVisibleCount((count) => count + TRANSCRIPT_PAGE);
  }, []);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    pinnedToBottomRef.current = distanceFromBottom <= TRANSCRIPT_PIN_THRESHOLD;
  }, []);

  const handleContentSizeChange = useCallback(() => {
    if (pinnedToBottomRef.current) {
      scrollRef.current?.scrollToEnd({ animated: false });
    }
  }, []);

  if (loading && timelineEntries.length === 0) {
    return (
      <View style={styles.timelineLoading}>
        <Icon name="RefreshCw" size={14} color={theme.colors.accent} />
        <Text style={styles.timelineEmpty}>Loading live subagent timeline...</Text>
      </View>
    );
  }

  if (error && timelineEntries.length === 0) {
    return (
      <View style={styles.errorBox}>
        <Text style={styles.errorTitle}>Timeline Error</Text>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (timelineEntries.length === 0) {
    return <Text style={styles.timelineEmpty}>No transcript entries yet.</Text>;
  }

  return (
    <ScrollView
      ref={scrollRef}
      nestedScrollEnabled
      style={styles.timelineScroll}
      contentContainerStyle={styles.timelineScrollContent}
      onScroll={handleScroll}
      scrollEventThrottle={64}
      onContentSizeChange={handleContentSizeChange}
    >
      {hiddenCount > 0 ? (
        <Pressable
          tooltip={`Show ${hiddenCount} earlier transcript entries`}
          accessibilityRole="button"
          accessibilityLabel={`Show ${hiddenCount} earlier transcript entries`}
          onPress={handleShowEarlier}
          style={styles.showEarlierButton}
        >
          <Text style={styles.showEarlierText}>
            Show {Math.min(hiddenCount, TRANSCRIPT_PAGE)} earlier ({hiddenCount} hidden)
          </Text>
        </Pressable>
      ) : null}
      {visibleEntries.map((entry) => (
        <TimelineEntryRow key={entry.id} entry={entry} theme={theme} styles={styles} />
      ))}
    </ScrollView>
  );
}

/**
 * `childSummary` is set when the card owns nested subagents: the header chevron
 * then folds those children, and the thread is reached from the action bar. For
 * a leaf card the chevron toggles the thread directly.
 */
const AgentCard = memo(function AgentCard({
  agent,
  theme,
  compact,
  styles,
  isExpanded,
  isSteerOpen,
  isStopping,
  isArchiving,
  cardError,
  childSummary,
  childrenCollapsed,
  onHeaderPress,
  onToggleThread,
  onOpen,
  onToggleSteer,
  onArchive,
  onStop,
  onSubmitSteer,
}: {
  readonly agent: SubagentViewModel;
  readonly theme: PluginTheme;
  readonly compact: boolean;
  readonly styles: SubagentsPanelStyles;
  readonly isExpanded: boolean;
  readonly isSteerOpen: boolean;
  readonly isStopping: boolean;
  readonly isArchiving: boolean;
  readonly cardError: string | null;
  readonly childSummary: ChildSummary | null;
  readonly childrenCollapsed: boolean;
  readonly onHeaderPress: () => void;
  readonly onToggleThread: (event: GestureResponderEvent) => void;
  readonly onOpen: (event: GestureResponderEvent) => void;
  readonly onToggleSteer: (event: GestureResponderEvent) => void;
  readonly onArchive: (event: GestureResponderEvent) => void;
  readonly onStop: (event: GestureResponderEvent) => void;
  readonly onSubmitSteer: (text: string) => Promise<void>;
}): ReactElement {
  const relativeUpdated = formatRelativeTime(agent.lastActivityAt || agent.updatedAt);
  const statusColor = statusDotColor(theme, agent.status, agent.attentionReason);
  const statusLabel = agent.archivedAt ? "archived" : agent.status;
  const chevronOpen = childSummary ? !childrenCollapsed : isExpanded;
  const headerLabel = childSummary
    ? `${agent.title}, status ${statusLabel}. Press to ${
        childrenCollapsed ? "expand" : "collapse"
      } ${childSummary.count} subagents.`
    : `${agent.title}, status ${statusLabel}. Press to ${
        isExpanded ? "collapse" : "expand"
      } thread.`;
  const headerAccessibilityState = useMemo(() => ({ expanded: chevronOpen }), [chevronOpen]);

  return (
    <View style={styles.agentCard}>
      <Pressable
        tooltip={
          childSummary
            ? `${childrenCollapsed ? "Expand" : "Collapse"} ${agent.title} subagents`
            : `${isExpanded ? "Collapse" : "Expand"} ${agent.title} thread`
        }
        accessibilityRole="button"
        accessibilityLabel={headerLabel}
        accessibilityState={headerAccessibilityState}
        onPress={onHeaderPress}
        style={styles.agentCardHeader}
      >
        <View style={styles.agentIdentity}>
          <Icon
            name={chevronOpen ? "ChevronDown" : "ChevronRight"}
            size={compact ? 13 : 15}
            color={theme.colors.foregroundMuted}
          />
          <AgentStatusIndicator
            theme={theme}
            status={agent.status}
            attentionReason={agent.attentionReason}
          />
          <View style={AGENT_TITLE_COLUMN_STYLE}>
            <Text style={styles.agentTitleText} numberOfLines={1}>
              {agent.title}
            </Text>
            <Text style={styles.agentMetaText} numberOfLines={1}>
              {agent.provider}
              {agent.model ? ` · ${agent.model}` : ""}
              {relativeUpdated ? ` · ${relativeUpdated}` : ""}
            </Text>
            {agent.isMain ? (
              <Text style={styles.agentMetaText} numberOfLines={2}>
                Directory: {agent.cwd}
              </Text>
            ) : null}
            {agent.recentActivitySummary ? (
              <Text
                style={[
                  styles.agentMetaText,
                  { color: theme.colors.foreground, fontStyle: "italic" },
                ]}
                numberOfLines={1}
              >
                {agent.recentActivitySummary}
              </Text>
            ) : null}
            {childSummary && childrenCollapsed ? (
              <View style={styles.childSummaryRow}>
                <AgentStatusIndicator
                  theme={theme}
                  status={childSummary.running > 0 ? "running" : "idle"}
                  attentionReason={null}
                />
                <Text style={styles.childSummaryText} numberOfLines={1}>
                  {childSummary.count} {childSummary.count === 1 ? "subagent" : "subagents"}
                  {childSummary.running > 0
                    ? ` · ${childSummary.running} running`
                    : " · none running"}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={styles.badgeRow}>
          {agent.requiresAttention || agent.attentionReason ? (
            <View style={styles.attentionBadge}>
              <Text style={styles.attentionBadgeText}>
                {agent.attentionReason ? agent.attentionReason.toUpperCase() : "ATTENTION"}
              </Text>
            </View>
          ) : null}

          <View style={styles.statusBadge}>
            <Text style={[styles.statusBadgeText, { color: statusColor }]}>{statusLabel}</Text>
          </View>

          <AgentActionBar
            theme={theme}
            compact={compact}
            agentTitle={agent.title}
            status={agent.status}
            threadOpen={isExpanded}
            steerOpen={isSteerOpen}
            stopping={isStopping}
            archiving={isArchiving}
            archived={agent.archivedAt !== null}
            onToggleThread={onToggleThread}
            onOpen={agent.isProviderSubagent ? NOOP_EVENT_HANDLER : onOpen}
            onToggleSteer={agent.isProviderSubagent ? NOOP_EVENT_HANDLER : onToggleSteer}
            onArchive={agent.isProviderSubagent ? NOOP_EVENT_HANDLER : onArchive}
            onStop={agent.isProviderSubagent ? NOOP_EVENT_HANDLER : onStop}
          />
        </View>
      </Pressable>

      {cardError ? (
        <View style={styles.cardErrorBanner}>
          <Text style={styles.cardErrorText}>{cardError}</Text>
        </View>
      ) : null}

      {isExpanded ? (
        <View style={styles.cardExpandedContent}>
          <View style={styles.timelineContainer}>
            <View style={styles.timelineHeader}>
              <Text style={styles.timelineTitle}>Live Transcript & Tools</Text>
            </View>
            <SubagentTranscriptView
              agentId={agent.id}
              parentAgentId={agent.parentAgentId}
              isProviderSubagent={agent.isProviderSubagent}
              theme={theme}
              styles={styles}
            />
          </View>
          {agent.status === "running" ? (
            <WorkingIndicator theme={theme} compact={compact} startedAt={agent.turnStartedAt} />
          ) : null}
          {isSteerOpen ? (
            <SteerComposer
              theme={theme}
              compact={compact}
              status={agent.status}
              onSubmit={onSubmitSteer}
              autoFocus
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

export function WorkspaceSubagentsBody({
  workspaceId,
  theme,
  host,
  layout,
}: {
  readonly workspaceId: string;
  readonly theme: PluginTheme;
  readonly host: PluginHostProps["host"];
  readonly layout: PluginHostProps["layout"];
}): ReactElement {
  const paseo = usePaseo();
  const cancelAgent = useRpc(cancelWorkspaceAgent);
  const listProviderSubagents = useRpc(listWorkspaceProviderSubagents);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [allAgents, setAllAgents] = useState<readonly SubagentViewModel[]>([]);
  const [filter, setFilter] = useState<SubagentStatusFilter>("all");
  const [expandedAgentIds, setExpandedAgentIds] = useState<ReadonlySet<string>>(new Set());
  const [steerOpenAgentIds, setSteerOpenAgentIds] = useState<ReadonlySet<string>>(new Set());
  const [stoppingAgentIds, setStoppingAgentIds] = useState<ReadonlySet<string>>(new Set());
  const [archivingAgentIds, setArchivingAgentIds] = useState<ReadonlySet<string>>(new Set());
  const [cardErrors, setCardErrors] = useState<ReadonlyMap<string, string>>(new Map());
  /** Latest committed list, read by handlers so they keep a stable identity. */
  const agentsRef = useRef<readonly SubagentViewModel[]>([]);

  const isMountedRef = useRef<boolean>(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchAgentsForWorkspace = useCallback(async () => {
    if (!paseo || !workspaceId) return;
    try {
      setErrorMessage(null);
      const listResult = await paseo.agents.list({
        filter: { includeArchived: true },
        page: { limit: 200 },
      });

      const matched = listResult.entries
        .map((entry) => {
          const agent = entry.agent;
          const parentAgentId = agent.labels["paseo.parent-agent-id"]?.trim() || null;
          const isMain = !parentAgentId;
          return {
            agent,
            parentAgentId,
            isMain,
          };
        })
        .filter(({ agent, isMain }) => {
          if (agent.workspaceId !== workspaceId) return false;
          if (agent.archivedAt) return true;
          if (isMain) return true;
          return isSubagentActiveOrAttention(agent) || agent.status === "closed";
        });

      // Reuse the previous view model when the snapshot has not moved, so memoized
      // cards skip re-rendering and the summary tail is only refetched for agents
      // that actually changed. Live agent updates arrive several times a second.
      const previousById = new Map(agentsRef.current.map((agent) => [agent.id, agent]));
      const viewModels: SubagentViewModel[] = await Promise.all(
        matched.map(async ({ agent, parentAgentId, isMain }) => {
          const previous = previousById.get(agent.id);
          const unchanged =
            previous !== undefined &&
            previous.updatedAt === agent.updatedAt &&
            previous.status === agent.status &&
            previous.cwd === agent.cwd &&
            previous.title === (agent.title || previous.title) &&
            previous.requiresAttention === Boolean(agent.requiresAttention) &&
            previous.attentionReason === (agent.attentionReason ?? null) &&
            previous.archivedAt === (agent.archivedAt ?? null);
          if (unchanged) return previous;

          let recentSummary: string | null = previous?.recentActivitySummary ?? null;
          try {
            const agentRef = paseo.agents.ref(agent.id);
            const timelinePayload = await agentRef.timeline.refetch({
              direction: "tail",
              limit: 20,
              projection: "projected",
            });
            recentSummary = extractRecentActivitySummary(
              timelinePayload.entries.map((e) => e.item) as AgentTimelineItem[],
            );
          } catch {
            // Keep the last known summary on a transient fetch failure.
          }

          return {
            id: agent.id,
            workspaceId,
            parentAgentId,
            isMain,
            title:
              agent.title ||
              (isMain ? `Main Agent ${agent.id.slice(0, 8)}` : `Subagent ${agent.id.slice(0, 8)}`),
            cwd: agent.cwd,
            provider: agent.provider,
            model: agent.model,
            status: agent.status,
            requiresAttention: Boolean(agent.requiresAttention),
            attentionReason: agent.attentionReason ?? null,
            createdAt: agent.createdAt,
            archivedAt: agent.archivedAt ?? null,
            updatedAt: agent.updatedAt,
            lastActivityAt: agent.updatedAt,
            turnStartedAt: agent.activeTurn?.startedAt ?? agent.lastUserMessageAt ?? null,
            recentActivitySummary: recentSummary,
          };
        }),
      );

      const mainAgentIds = matched.filter(({ isMain }) => isMain).map(({ agent }) => agent.id);

      let providerSubagentItems: ProviderSubagentItem[] = [];
      if (mainAgentIds.length > 0) {
        try {
          const res = await listProviderSubagents({ parentAgentIds: mainAgentIds });
          providerSubagentItems = res.subagents ?? [];
        } catch {
          // Fall back gracefully if RPC is unavailable
        }
      }

      const providerViewModels: SubagentViewModel[] = providerSubagentItems.map((sub) => {
        const parent = matched.find((m) => m.agent.id === sub.parentAgentId)?.agent;
        let mappedStatus: SubagentViewModel["status"] = "idle";
        let requiresAttention = false;
        let attentionReason: SubagentViewModel["attentionReason"] = null;

        if (sub.status === "running") {
          mappedStatus = "running";
        } else if (sub.status === "failed") {
          mappedStatus = "error";
          requiresAttention = true;
          attentionReason = "error";
        } else if (sub.status === "completed") {
          mappedStatus = "idle";
          attentionReason = "finished";
        } else if (sub.status === "canceled") {
          mappedStatus = "closed";
        }

        return {
          id: sub.id,
          workspaceId,
          parentAgentId: sub.parentAgentId,
          isMain: false,
          isProviderSubagent: true,
          title:
            sub.title ||
            (sub.description ? sub.description.slice(0, 60) : `Subagent ${sub.id.slice(0, 8)}`),
          cwd: sub.cwd || parent?.cwd || "",
          provider: sub.provider,
          model: sub.subtitle || null,
          status: mappedStatus,
          requiresAttention,
          attentionReason,
          createdAt: sub.createdAt,
          archivedAt: null,
          updatedAt: sub.updatedAt,
          lastActivityAt: sub.updatedAt,
          turnStartedAt: sub.status === "running" ? sub.createdAt : null,
          recentActivitySummary: sub.description || null,
        };
      });

      const combined = [...viewModels, ...providerViewModels];

      if (isMountedRef.current) {
        combined.sort((a, b) => {
          if (a.requiresAttention !== b.requiresAttention) {
            return a.requiresAttention ? -1 : 1;
          }
          if (a.status === "running" && b.status !== "running") return -1;
          if (b.status === "running" && a.status !== "running") return 1;
          return (
            Date.parse(b.lastActivityAt || b.updatedAt || "") -
            Date.parse(a.lastActivityAt || a.updatedAt || "")
          );
        });
        const previousList = agentsRef.current;
        const sameList =
          previousList.length === combined.length &&
          previousList.every((agent, index) => agent === combined[index]);
        if (!sameList) {
          agentsRef.current = combined;
          setAllAgents(combined);
        }
        setStoppingAgentIds((prev) => {
          if (prev.size === 0) return prev;
          const next = new Set(prev);
          for (const id of prev) {
            const matchedAgent = combined.find((a) => a.id === id);
            if (!matchedAgent || matchedAgent.status !== "running") {
              next.delete(id);
            }
          }
          return next.size === prev.size ? prev : next;
        });
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to load workspace agents.");
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [listProviderSubagents, paseo, workspaceId]);

  useEffect(() => {
    setLoading(true);
    fetchAgentsForWorkspace();

    if (!paseo) return;

    let debounceTimer: TimerHandle | null = null;
    const triggerDebouncedFetch = () => {
      clearTimeout(debounceTimer as TimerHandle);
      debounceTimer = setTimeout(() => {
        if (isMountedRef.current) {
          fetchAgentsForWorkspace();
        }
      }, 400);
    };

    const unsubAgents = paseo.agents.subscribe(() => {
      triggerDebouncedFetch();
    });

    return () => {
      clearTimeout(debounceTimer as TimerHandle);
      unsubAgents();
    };
  }, [paseo, workspaceId, fetchAgentsForWorkspace]);

  const handleManualRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAgentsForWorkspace();
  }, [fetchAgentsForWorkspace]);

  const handleStopAgent = useCallback(
    async (agentId: string) => {
      setStoppingAgentIds((prev) => {
        const next = new Set(prev);
        next.add(agentId);
        return next;
      });
      try {
        const result = await cancelAgent({ agentId });
        if (!result.ok) {
          setCardErrors((prev) => {
            const next = new Map(prev);
            next.set(agentId, result.error ?? "Failed to stop agent.");
            return next;
          });
        } else {
          setCardErrors((prev) => {
            if (!prev.has(agentId)) return prev;
            const next = new Map(prev);
            next.delete(agentId);
            return next;
          });
        }
      } catch (err: unknown) {
        setCardErrors((prev) => {
          const next = new Map(prev);
          next.set(agentId, err instanceof Error ? err.message : "Failed to stop agent.");
          return next;
        });
      } finally {
        setStoppingAgentIds((prev) => {
          if (!prev.has(agentId)) return prev;
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }
    },
    [cancelAgent],
  );
  const handleArchiveAgent = useCallback(
    async (agentId: string) => {
      const agent = agentsRef.current.find((candidate) => candidate.id === agentId);
      if (!paseo || !agent || agent.archivedAt) return;

      setArchivingAgentIds((prev) => {
        const next = new Set(prev);
        next.add(agentId);
        return next;
      });
      setCardErrors((prev) => {
        if (!prev.has(agentId)) return prev;
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });

      try {
        await paseo.agents.ref(agentId).archive();
        await fetchAgentsForWorkspace();
      } catch (err: unknown) {
        setCardErrors((prev) => {
          const next = new Map(prev);
          next.set(agentId, err instanceof Error ? err.message : "Failed to archive agent.");
          return next;
        });
      } finally {
        setArchivingAgentIds((prev) => {
          if (!prev.has(agentId)) return prev;
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }
    },
    [fetchAgentsForWorkspace, paseo],
  );

  const toggleAgentExpanded = useCallback((agentId: string) => {
    setExpandedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }, []);

  const toggleAgentSteer = useCallback((agentId: string) => {
    setSteerOpenAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
        setExpandedAgentIds((exp) => {
          if (!exp.has(agentId)) {
            const nextExp = new Set(exp);
            nextExp.add(agentId);
            return nextExp;
          }
          return exp;
        });
      }
      return next;
    });
  }, []);

  const handleOpenInNewTab = useCallback(
    (agentId: string) => {
      openAgentInPaseoWorkspace(host.id, workspaceId, agentId);
    },
    [host.id, workspaceId],
  );

  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const nativeHitSlop = layout.platform === "web" ? undefined : TOUCH_HIT_SLOP;
  const refreshControl = useMemo(
    () => (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={handleManualRefresh}
        tintColor={theme.colors.accent}
        colors={[theme.colors.accent]}
      />
    ),
    [handleManualRefresh, refreshing, theme.colors.accent],
  );

  const liveAgents = useMemo(
    () => allAgents.filter((agent) => agent.archivedAt === null),
    [allAgents],
  );
  const archivedAgents = useMemo(
    () => allAgents.filter((agent) => agent.archivedAt !== null),
    [allAgents],
  );
  const mainAgents = useMemo(() => liveAgents.filter((agent) => agent.isMain), [liveAgents]);
  const archivedMainAgents = useMemo(
    () => archivedAgents.filter((agent) => agent.isMain),
    [archivedAgents],
  );
  const archivedSubagents = useMemo(
    () => archivedAgents.filter((agent) => !agent.isMain),
    [archivedAgents],
  );

  const counts = useMemo(() => {
    let running = 0;
    let idle = 0;
    let attention = 0;
    for (const agent of liveAgents) {
      if (agent.status === "running") running++;
      if (agent.status === "idle") idle++;
      if (agent.requiresAttention || agent.attentionReason) attention++;
    }
    const allSubagentsCount = allAgents.filter((a) => {
      if (a.isMain) return false;
      if (a.archivedAt === null) return true;
      return mainAgents.some((m) => m.id === a.parentAgentId);
    }).length;
    return {
      subagents: allSubagentsCount,
      running,
      idle,
      attention,
      archived: archivedAgents.length,
    };
  }, [allAgents, archivedAgents.length, liveAgents, mainAgents]);

  const filteredMainAgents = useMemo(() => {
    if (filter === "archived") return archivedMainAgents;
    if (filter === "main" || filter === "all") return mainAgents;
    return mainAgents.filter((agent) => {
      if (filter === "running") return agent.status === "running";
      if (filter === "idle") return agent.status === "idle";
      return agent.requiresAttention || Boolean(agent.attentionReason);
    });
  }, [archivedMainAgents, filter, mainAgents]);

  const filteredSubagents = useMemo(() => {
    if (filter === "archived") return archivedSubagents;
    if (filter === "main") return [];
    if (filter === "all") {
      return allAgents.filter((agent) => {
        if (agent.isMain) return false;
        if (agent.archivedAt === null) return true;
        return mainAgents.some((m) => m.id === agent.parentAgentId);
      });
    }
    return liveAgents
      .filter((agent) => !agent.isMain)
      .filter((agent) => {
        if (filter === "running") return agent.status === "running";
        if (filter === "idle") return agent.status === "idle";
        return agent.requiresAttention || Boolean(agent.attentionReason);
      });
  }, [allAgents, archivedSubagents, filter, liveAgents, mainAgents]);

  /**
   * Subagents nest under the agent named by their parent label, recursively, so
   * a subagent's own subagents sit under it. A subagent whose parent is not in
   * the workspace list (archived or closed parent) becomes an orphan root.
   */
  const agentTree = useMemo(() => {
    const knownIds = new Set(
      [...filteredMainAgents, ...filteredSubagents].map((agent) => agent.id),
    );
    const childrenByParent = new Map<string, SubagentViewModel[]>();
    const orphans: SubagentViewModel[] = [];
    for (const agent of filteredSubagents) {
      const parentId = agent.parentAgentId;
      if (parentId && knownIds.has(parentId)) {
        const siblings = childrenByParent.get(parentId);
        if (siblings) {
          siblings.push(agent);
        } else {
          childrenByParent.set(parentId, [agent]);
        }
      } else {
        orphans.push(agent);
      }
    }
    const summaryByParent = new Map<string, ChildSummary>();
    for (const [parentId, children] of childrenByParent) {
      let running = 0;
      for (const child of children) {
        if (child.status === "running") running++;
      }
      summaryByParent.set(parentId, { count: children.length, running });
    }
    return { childrenByParent, summaryByParent, orphans };
  }, [filteredMainAgents, filteredSubagents]);

  const refreshAccessibilityState = useMemo(() => ({ disabled: refreshing }), [refreshing]);
  const mainFilterAccessibilityState = useMemo(() => ({ selected: filter === "main" }), [filter]);
  const allFilterAccessibilityState = useMemo(() => ({ selected: filter === "all" }), [filter]);
  const runningFilterAccessibilityState = useMemo(
    () => ({ selected: filter === "running" }),
    [filter],
  );
  const attentionFilterAccessibilityState = useMemo(
    () => ({ selected: filter === "attention" }),
    [filter],
  );
  const idleFilterAccessibilityState = useMemo(() => ({ selected: filter === "idle" }), [filter]);
  const archivedFilterAccessibilityState = useMemo(
    () => ({ selected: filter === "archived" }),
    [filter],
  );

  const handleMainFilter = useCallback(() => setFilter("main"), []);
  const handleAllFilter = useCallback(() => setFilter("all"), []);
  const handleRunningFilter = useCallback(() => setFilter("running"), []);
  const handleAttentionFilter = useCallback(() => setFilter("attention"), []);
  const handleIdleFilter = useCallback(() => setFilter("idle"), []);
  const handleArchivedFilter = useCallback(() => setFilter("archived"), []);

  // Handlers are keyed on the id set, not the snapshot list, so a status tick on
  // one agent does not hand every memoized card a fresh callback.
  const agentIdsKey = allAgents.map((agent) => agent.id).join("\n");
  const agentIds = useMemo(() => (agentIdsKey ? agentIdsKey.split("\n") : []), [agentIdsKey]);

  const agentToggleHandlers = useMemo(
    () => new Map(agentIds.map((id) => [id, () => toggleAgentExpanded(id)])),
    [agentIds, toggleAgentExpanded],
  );

  const agentOpenHandlers = useMemo(
    () =>
      new Map(
        agentIds.map((id) => [
          id,
          (event: GestureResponderEvent) => {
            event.stopPropagation();
            handleOpenInNewTab(id);
          },
        ]),
      ),
    [agentIds, handleOpenInNewTab],
  );

  const agentToggleSteerHandlers = useMemo(
    () =>
      new Map(
        agentIds.map((id) => [
          id,
          (event: GestureResponderEvent) => {
            event.stopPropagation();
            toggleAgentSteer(id);
          },
        ]),
      ),
    [agentIds, toggleAgentSteer],
  );

  const agentStopHandlers = useMemo(
    () =>
      new Map(
        agentIds.map((id) => [
          id,
          (event: GestureResponderEvent) => {
            event.stopPropagation();
            handleStopAgent(id);
          },
        ]),
      ),
    [agentIds, handleStopAgent],
  );
  const agentArchiveHandlers = useMemo(
    () =>
      new Map(
        agentIds.map((id) => [
          id,
          (event: GestureResponderEvent) => {
            event.stopPropagation();
            handleArchiveAgent(id);
          },
        ]),
      ),
    [agentIds, handleArchiveAgent],
  );

  const agentSubmitHandlers = useMemo(
    () =>
      new Map(
        agentIds.map((id) => [
          id,
          async (text: string): Promise<void> => {
            if (!paseo) return;
            type SteerSendOptions = PaseoAgentSendOptions & {
              activeTurnBehavior?: "steer" | "interrupt";
            };
            const current = agentsRef.current.find((agent) => agent.id === id);
            const sendOptions: SteerSendOptions =
              current?.status === "running" ? { activeTurnBehavior: "steer" } : {};
            await paseo.agents.ref(id).send(text, sendOptions as PaseoAgentSendOptions);
          },
        ]),
      ),
    [agentIds, paseo],
  );

  const agentThreadToggleHandlers = useMemo(
    () =>
      new Map(
        agentIds.map((id) => [
          id,
          (event: GestureResponderEvent) => {
            event.stopPropagation();
            toggleAgentExpanded(id);
          },
        ]),
      ),
    [agentIds, toggleAgentExpanded],
  );

  const [collapsedParentIds, setCollapsedParentIds] = useState<ReadonlySet<string>>(new Set());
  const toggleParentCollapsed = useCallback((agentId: string) => {
    setCollapsedParentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }, []);
  const collapseToggleHandlers = useMemo(
    () => new Map(agentIds.map((id) => [id, () => toggleParentCollapsed(id)])),
    [agentIds, toggleParentCollapsed],
  );

  /**
   * A card followed by its children in an indented, left-ruled group. The
   * card's chevron folds the group; while folded the card summarises it.
   */
  const renderAgentNode = (agent: SubagentViewModel): ReactElement => {
    const children = agentTree.childrenByParent.get(agent.id) ?? [];
    const childSummary =
      agentTree.summaryByParent.get(agent.id) ?? (agent.isMain ? EMPTY_CHILD_SUMMARY : null);
    const ownsChildren = childSummary !== null;
    const collapsed = ownsChildren && collapsedParentIds.has(agent.id);
    return (
      <View key={agent.id} style={SECTION_CONTAINER_STYLE}>
        <AgentCard
          agent={agent}
          theme={theme}
          compact={layout.compact}
          styles={styles}
          isExpanded={expandedAgentIds.has(agent.id)}
          isSteerOpen={steerOpenAgentIds.has(agent.id)}
          isStopping={stoppingAgentIds.has(agent.id)}
          isArchiving={archivingAgentIds.has(agent.id)}
          cardError={cardErrors.get(agent.id) ?? null}
          childSummary={childSummary}
          childrenCollapsed={collapsed}
          onHeaderPress={
            (ownsChildren ? collapseToggleHandlers : agentToggleHandlers).get(agent.id) ??
            NOOP_HANDLER
          }
          onToggleThread={agentThreadToggleHandlers.get(agent.id) ?? NOOP_EVENT_HANDLER}
          onOpen={agentOpenHandlers.get(agent.id) ?? NOOP_EVENT_HANDLER}
          onToggleSteer={agentToggleSteerHandlers.get(agent.id) ?? NOOP_EVENT_HANDLER}
          onArchive={agentArchiveHandlers.get(agent.id) ?? NOOP_EVENT_HANDLER}
          onStop={agentStopHandlers.get(agent.id) ?? NOOP_EVENT_HANDLER}
          onSubmitSteer={agentSubmitHandlers.get(agent.id) ?? NOOP_SUBMIT_HANDLER}
        />
        {ownsChildren && !collapsed ? (
          <View style={styles.nestedGroup}>
            {children.length === 0 ? (
              <Text style={styles.nestedEmptyText}>
                {filter === "all" || filter === "main"
                  ? "No active subagents"
                  : "No subagents match the filter"}
              </Text>
            ) : (
              children.map(renderAgentNode)
            )}
          </View>
        ) : null}
      </View>
    );
  };

  if (loading && allAgents.length === 0) {
    return (
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Agent Monitor</Text>
        </View>
        <View style={styles.stateContainer}>
          <Icon name="RefreshCw" size={14} color={theme.colors.accent} />
          <Text style={styles.stateTitle}>Loading active subagents...</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Agent Monitor</Text>
        <View style={styles.headerActions}>
          <Pressable
            tooltip={refreshing ? "Refreshing agent monitor" : "Refresh agent monitor"}
            accessibilityRole="button"
            accessibilityLabel={refreshing ? "Refreshing agent monitor" : "Refresh agent monitor"}
            accessibilityState={refreshAccessibilityState}
            disabled={refreshing}
            onPress={handleManualRefresh}
            style={[styles.refreshButton, refreshing ? styles.refreshButtonDisabled : null]}
            hitSlop={nativeHitSlop}
          >
            <Icon
              name="RefreshCw"
              size={layout.compact ? 13 : 15}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
        </View>
      </View>

      {errorMessage ? (
        <View style={styles.errorContainer}>
          <Text style={[styles.errorTitle, { color: theme.colors.statusDanger }]}>
            Unable to synchronize subagents
          </Text>
          <Text style={styles.errorSubtitle}>{errorMessage}</Text>
          <Pressable
            tooltip="Retry loading agent monitor"
            accessibilityRole="button"
            accessibilityLabel="Retry loading agent monitor"
            onPress={handleManualRefresh}
            style={styles.retryButton}
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        refreshControl={layout.platform === "web" ? undefined : refreshControl}
      >
        <View accessibilityRole="tablist" style={styles.summaryStats}>
          <Pressable
            tooltip={`Show ${mainAgents.length} main agents`}
            accessibilityRole="tab"
            accessibilityLabel={`Show ${mainAgents.length} main agents`}
            accessibilityState={mainFilterAccessibilityState}
            onPress={handleMainFilter}
            style={[
              styles.summaryStatItem,
              filter === "main" ? styles.summaryStatItemSelected : null,
            ]}
            hitSlop={nativeHitSlop}
          >
            <Text style={styles.summaryStatValue}>{mainAgents.length}</Text>
            <Text style={styles.summaryStatLabel}>
              {mainAgents.length === 1 ? "Main agent" : "Main agents"}
            </Text>
          </Pressable>
          <Pressable
            tooltip={`Show all ${counts.subagents} subagents`}
            accessibilityRole="tab"
            accessibilityLabel={`Show all ${counts.subagents} subagents`}
            accessibilityState={allFilterAccessibilityState}
            onPress={handleAllFilter}
            style={[
              styles.summaryStatItem,
              filter === "all" ? styles.summaryStatItemSelected : null,
            ]}
            hitSlop={nativeHitSlop}
          >
            <Text style={styles.summaryStatValue}>{counts.subagents}</Text>
            <Text style={styles.summaryStatLabel}>Subagents</Text>
          </Pressable>
          <Pressable
            tooltip={`Show ${counts.running} running agents`}
            accessibilityRole="tab"
            accessibilityLabel={`Show ${counts.running} running agents`}
            accessibilityState={runningFilterAccessibilityState}
            onPress={handleRunningFilter}
            style={[
              styles.summaryStatItem,
              filter === "running" ? styles.summaryStatItemSelected : null,
            ]}
            hitSlop={nativeHitSlop}
          >
            <Text style={[styles.summaryStatValue, { color: theme.colors.accent }]}>
              {counts.running}
            </Text>
            <Text style={styles.summaryStatLabel}>Running</Text>
          </Pressable>
          <Pressable
            tooltip={`Show ${counts.attention} attention-requiring agents`}
            accessibilityRole="tab"
            accessibilityLabel={`Show ${counts.attention} attention-requiring agents`}
            accessibilityState={attentionFilterAccessibilityState}
            onPress={handleAttentionFilter}
            style={[
              styles.summaryStatItem,
              filter === "attention" ? styles.summaryStatItemSelected : null,
            ]}
            hitSlop={nativeHitSlop}
          >
            <Text
              style={[
                styles.summaryStatValue,
                {
                  color:
                    counts.attention > 0 ? theme.colors.statusWarning : theme.colors.foreground,
                },
              ]}
            >
              {counts.attention}
            </Text>
            <Text style={styles.summaryStatLabel}>Attention</Text>
          </Pressable>
          <Pressable
            tooltip={`Show ${counts.idle} idle agents`}
            accessibilityRole="tab"
            accessibilityLabel={`Show ${counts.idle} idle agents`}
            accessibilityState={idleFilterAccessibilityState}
            onPress={handleIdleFilter}
            style={[
              styles.summaryStatItem,
              filter === "idle" ? styles.summaryStatItemSelected : null,
            ]}
            hitSlop={nativeHitSlop}
          >
            <Text style={styles.summaryStatValue}>{counts.idle}</Text>
            <Text style={styles.summaryStatLabel}>Idle</Text>
          </Pressable>
          <Pressable
            tooltip={`Show ${counts.archived} archived agents`}
            accessibilityRole="tab"
            accessibilityLabel={`Show ${counts.archived} archived agents`}
            accessibilityState={archivedFilterAccessibilityState}
            onPress={handleArchivedFilter}
            style={[
              styles.summaryStatItem,
              filter === "archived" ? styles.summaryStatItemSelected : null,
            ]}
            hitSlop={nativeHitSlop}
          >
            <Text style={styles.summaryStatValue}>{counts.archived}</Text>
            <Text style={styles.summaryStatLabel}>Archived</Text>
          </Pressable>
        </View>

        {filteredMainAgents.length === 0 &&
        (filter === "main" || agentTree.orphans.length === 0) ? (
          <View style={styles.stateContainer}>
            <Icon name="Bot" size={28} color={theme.colors.foregroundMuted} />
            <Text style={styles.stateTitle}>No agents</Text>
            <Text style={styles.stateSubtitle}>
              {filter === "all"
                ? "No agents are active in this workspace."
                : "No agents match the selected filter."}
            </Text>
          </View>
        ) : (
          filteredMainAgents.map(renderAgentNode)
        )}

        {filter !== "main" && agentTree.orphans.length > 0 ? (
          <View style={SECTION_CONTAINER_STYLE}>
            <Text style={styles.sectionLabel}>Agents without a matching parent</Text>
            {agentTree.orphans.map(renderAgentNode)}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

export function WorkspaceSubagentsPanel(props: PluginWorkspacePanelProps): ReactElement {
  return (
    <WorkspaceSubagentsBody
      workspaceId={props.workspaceId}
      theme={props.theme}
      host={props.host}
      layout={props.layout}
    />
  );
}

export const WorkspaceAgentMonitorPanel = WorkspaceSubagentsPanel;
