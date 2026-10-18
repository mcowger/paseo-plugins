import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useAgent, useRpc } from "@getpaseo/plugin/client";
import {
  copyText,
  Icon,
  ScrollView,
  useRevealedText,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import React, {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActivityIndicator,
  Image,
  type NativeScrollEvent,
  type ScrollView as NativeScrollView,
  type NativeSyntheticEvent,
  Pressable,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import type { z } from "zod";
import { extractCodeModeCode, isCodeModeTool } from "../shared/codemode";
import { exaToolKind } from "../shared/exa";
import { githubToolKind } from "../shared/github";
import {
  parseInlineMarkdown,
  parseReasoningMarkdown,
  type ReasoningMarkdownBlock,
} from "../shared/markdown";
import { isOmpFindTool } from "../shared/omp-find";
import { parsePiSubagentCall, piSubagentOperation } from "../shared/pi-subagents";
import {
  agentRowFacts,
  type ActivityPalette,
  type AskAnswer,
  type ActivityThemeColors,
  compactText,
  type DiffLine,
  diffLinesForDetail,
  editDiffContentSize,
  effectiveUnifiedDiff,
  estimateReasoningTokens,
  expansionTargetForToolCall,
  extractCodeInput,
  extractPiToolText,
  fileIconForPath,
  formatReasoningMeta,
  formatUnknownValue,
  hasMeaningfulToolCallDetail,
  hasMeaningfulUnknownValue,
  isAskTool,
  isBgWaitTool,
  isOmpWaitTool,
  isOpencodeSubagentTool,
  isSkillTool,
  isSubagentSupervisorTool,
  isTodoTool,
  MAX_DIFF_CHARS,
  MAX_VISIBLE_SUBAGENT_ACTIONS,
  notInHeader,
  parseAskAnswers,
  parseOpencodeSearchContent,
  parsePiFileList,
  parsePiLsOutput,
  parsePiSearchContent,
  parseSubAgentActionLog,
  paseoToolLeafName,
  previewText,
  readErrorMessage,
  readRangeLabel,
  relativeToRoot,
  resolveActivityPalette,
  resolveSearchCounts,
  resolveSubAgentActionPresentation,
  skillNameForDetail,
  splitFileDisplay,
  splitReasoningSteps,
  stripLeadingCwdCd,
  subAgentLogFullyShown,
  tailPreview,
  todoTaskLabel,
  toolCallHasBody,
  toolDetailFacts,
  truncateDirFront,
} from "../shared/presentation";
import { readImageRpc, shouldAttemptImageLoad } from "../shared/read-image";
import { alpha, rule, sunken, tint } from "../shared/color";
import type { CodeChrome, ExpansionMode, ExpansionTarget } from "../shared/settings";
import {
  DEFAULT_EXPANSION,
} from "../shared/settings";
import {
  isLatestTaskUpdate,
  type ReasoningItemData,
  type reasoningItemDataSchema,
  resolveExpansion,
  resolveTaskUpdateExpansion,
  type TaskUpdateExpansionOverride,
  type TodoItemData,
  type ToolCallItemData,
  type toolCallItemDataSchema,
} from "../shared/timeline";
import { CodeModeToolDetail } from "./codemode";
import { GithubToolDetail } from "./github";
import { type HighlightToken, useHighlightTokens } from "./highlight";
import { commandColorEnabled, quietOpacity, useActivityPrefs, useReplyCodeStyles } from "./prefs";
import { OmpFindToolDetail } from "./omp-find";
import { OmpWaitToolDetail } from "./omp-wait";
import { OpencodeSubagentToolDetail } from "./opencode-subagent";
import { ExaToolDetail, PaseoFields, PaseoToolDetail, Section } from "./paseo";
import { mcpCallFields, mcpToolLabel, type McpToolName, parseMcpToolName } from "../shared/mcp";
import { isRecallTool, parseRecallOutput, type RecallResult } from "../shared/recall";
import {
  BgWaitToolDetail,
  PiSubagentLifecycleSummary,
  PiSubagentToolDetail,
  SupervisorToolDetail,
} from "./pi-subagents";
import { TodoToolDetail } from "./todo";
import {
  cmonoTextEscape,
  cmonoViewEscape,
  cuiTextEscape,
  cuiViewEscape,
  pmonoViewEscape,
} from "./web";

const MAX_DETAIL_HEIGHT = 420;
/**
 * Reasoning is shown whole while it streams, because truncating it to a preview
 * would cut off the newest text and leave the block frozen on its opening lines.
 * The scroll region caps the height instead. The **Thinking** line budget decides
 * where the cut is; this is the character ceiling behind it, so a thinking block
 * of pathological width cannot stall layout either.
 */
const MAX_REASONING_TAIL_CHARS = 32_000;


// Paseo spaces consecutive activity rows by applying its inter-row gap to the row
// that still has a newer neighbor. On the native inverted timeline the newest live
// row gets none, leaving no gap above it. The plugin supplies the missing gap on the
// row itself whenever it is the live tail.
const STREAM_ROW_GAP = 16;
const CARD_VERTICAL_MARGIN = -3;
const CARD_TAIL_MARGIN_TOP = STREAM_ROW_GAP + CARD_VERTICAL_MARGIN;

type Theme = PluginTimelineItemProps["theme"];
type ReasoningData = z.output<typeof reasoningItemDataSchema>;
type ToolCallData = z.output<typeof toolCallItemDataSchema>;
type TodoData = TodoItemData;

const latestReasoningTimestamps = new Map<string, number>();
const latestReasoningListeners = new Set<() => void>();
const latestToolCallTimestamps = new Map<string, number>();
const latestToolCallListeners = new Set<() => void>();
const latestTaskUpdateTimestamps = new Map<string, number>();
const latestTaskUpdateListeners = new Set<() => void>();
const getEmptyTaskUpdateTimestamp = () => 0;

function updateLatestReasoningTimestamp(agentId: string, timestamp: number): void {
  const current = latestReasoningTimestamps.get(agentId) ?? 0;
  if (timestamp <= current) return;
  latestReasoningTimestamps.set(agentId, timestamp);
  for (const listener of latestReasoningListeners) listener();
}

function subscribeLatestReasoning(listener: () => void): () => void {
  latestReasoningListeners.add(listener);
  return () => latestReasoningListeners.delete(listener);
}

function useIsLatestReasoning(agentId: string, timestamp: Date, isStreaming: boolean): boolean {
  const itemTime = timestamp.getTime();
  if (isStreaming || itemTime > (latestReasoningTimestamps.get(agentId) ?? 0)) {
    updateLatestReasoningTimestamp(agentId, itemTime);
  }

  const latestTime = useSyncExternalStore(
    subscribeLatestReasoning,
    () => latestReasoningTimestamps.get(agentId) ?? 0,
    () => 0,
  );
  return isStreaming || (latestTime > 0 && itemTime >= latestTime);
}

function updateLatestToolCallTimestamp(agentId: string, timestamp: number): void {
  const current = latestToolCallTimestamps.get(agentId) ?? 0;
  if (timestamp <= current) return;
  latestToolCallTimestamps.set(agentId, timestamp);
  for (const listener of latestToolCallListeners) listener();
}

function subscribeLatestToolCall(listener: () => void): () => void {
  latestToolCallListeners.add(listener);
  return () => latestToolCallListeners.delete(listener);
}

function useIsLatestToolCall(agentId: string, timestamp: Date, isRunning: boolean): boolean {
  const itemTime = timestamp.getTime();
  if (isRunning || itemTime > (latestToolCallTimestamps.get(agentId) ?? 0)) {
    updateLatestToolCallTimestamp(agentId, itemTime);
  }

  const latestTime = useSyncExternalStore(
    subscribeLatestToolCall,
    () => latestToolCallTimestamps.get(agentId) ?? 0,
    () => 0,
  );
  return isRunning || (latestTime > 0 && itemTime >= latestTime);
}

function updateLatestTaskUpdateTimestamp(agentId: string, timestamp: number): void {
  const current = latestTaskUpdateTimestamps.get(agentId) ?? 0;
  if (timestamp <= current) return;
  latestTaskUpdateTimestamps.set(agentId, timestamp);
  for (const listener of latestTaskUpdateListeners) listener();
}

function subscribeLatestTaskUpdate(listener: () => void): () => void {
  latestTaskUpdateListeners.add(listener);
  return () => latestTaskUpdateListeners.delete(listener);
}

function useLatestTaskUpdateTimestamp(
  agentId: string,
  timestamp: Date,
  isTaskUpdate: boolean,
): number {
  const itemTime = timestamp.getTime();
  const subscribe = useCallback(
    (listener: () => void) => (isTaskUpdate ? subscribeLatestTaskUpdate(listener) : () => {}),
    [isTaskUpdate],
  );
  const getSnapshot = useCallback(
    () => (isTaskUpdate ? (latestTaskUpdateTimestamps.get(agentId) ?? 0) : 0),
    [agentId, isTaskUpdate],
  );
  const latestTimestamp = useSyncExternalStore(subscribe, getSnapshot, getEmptyTaskUpdateTimestamp);
  useLayoutEffect(() => {
    if (isTaskUpdate) updateLatestTaskUpdateTimestamp(agentId, itemTime);
  }, [agentId, isTaskUpdate, itemTime]);
  return isTaskUpdate ? Math.max(latestTimestamp, itemTime) : latestTimestamp;
}

/**
 * Whether a row is the live tail: the newest activity row, still being produced, on
 * the native inverted timeline. Paseo's inverted stream skips the inter-row gap on
 * that row (the gap lands above the row before it), so only it needs the plugin to
 * supply its own top spacing. Comparing against both activity stores keeps parallel
 * (or background) rows from claiming the tail while a newer row exists; the web
 * timeline is not inverted and already receives the host's gap.
 */
function useIsLiveTail(
  agentId: string,
  timestamp: Date,
  active: boolean,
  platform: PluginTimelineItemProps["layout"]["platform"],
): boolean {
  const reasoningLatest = useSyncExternalStore(
    subscribeLatestReasoning,
    () => latestReasoningTimestamps.get(agentId) ?? 0,
    () => 0,
  );
  const toolCallLatest = useSyncExternalStore(
    subscribeLatestToolCall,
    () => latestToolCallTimestamps.get(agentId) ?? 0,
    () => 0,
  );
  return (
    active && platform !== "web" && timestamp.getTime() >= Math.max(reasoningLatest, toolCallLatest)
  );
}

/**
 * Where a row's details start: past the header's padding, icon, and gap, so
 * expanded content lines up under the row's label rather than its icon. Every
 * renderer consumes this through `useActivityStyles` instead of guessing.
 */
export const LABEL_INSET = 26;
/** One nesting level inside a detail region. */
export const NEST_INSET = 12;

function useExpansionMode(target: ExpansionTarget): ExpansionMode {
  const prefs = useActivityPrefs();
  return prefs.expansion[target] ?? DEFAULT_EXPANSION[target];
}

export function usePalette(theme: Theme): ActivityPalette {
  const prefs = useActivityPrefs();
  return useMemo(
    () => resolveActivityPalette(prefs.palette, theme.colors as ActivityThemeColors),
    [prefs.palette, theme.colors],
  );
}

export function useActivityStyles(theme: Theme, palette: ActivityPalette) {
  // Derived colors: a sunken surface for code, softened rules for guides, and
  // washes for changed diff lines. Kept here so every renderer shares them.
  const c = theme.colors;
  const codeSurface = sunken(c.surface0);
  const rail = rule(c.border, palette.railAlpha);
  const railWidth = palette.borderWidth;
  const gutter = alpha(c.foregroundMuted, 0.6);
  const diffAdded = tint(palette.statusColors.completed, 0.12);
  const diffRemoved = tint(palette.statusColors.failed, 0.12);
  const diffMeta = tint(palette.categoryColors.search, 0.1);
  return useMemo(
    () => ({
      card: {
        marginHorizontal: 0,
        marginVertical: CARD_VERTICAL_MARGIN,
      } satisfies ViewStyle,
      cardTail: {
        marginTop: CARD_TAIL_MARGIN_TOP,
      } satisfies ViewStyle,
      headerButton: {
        alignItems: "center",
        borderRadius: 2,
        flexDirection: "row",
        gap: 5,
        minWidth: 0,
        outlineColor: "transparent",
        outlineStyle: "none" as unknown as ViewStyle["outlineStyle"],
        outlineWidth: 0,
        overflow: "hidden",
        paddingHorizontal: 5,
        paddingVertical: 2,
      } satisfies ViewStyle,
      iconBadge: {
        alignItems: "center",
        height: 16,
        justifyContent: "center",
        width: 16,
      } satisfies ViewStyle,
      title: {
        color: theme.colors.foreground,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 12,
        fontWeight: "600",
        lineHeight: 17,
      } satisfies TextStyle,
      summary: {
        color: theme.colors.foregroundMuted,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 17,
        minWidth: 0,
      } satisfies TextStyle,
      filePath: {
        alignItems: "center",
        flex: 1,
        flexDirection: "row",
        minWidth: 0,
      } satisfies ViewStyle,
      fileDir: {
        color: theme.colors.foregroundMuted,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 17,
      } satisfies TextStyle,
      fileName: {
        color: theme.colors.foreground,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 12,
        fontWeight: "600",
        lineHeight: 17,
      } satisfies TextStyle,
      status: {
        alignItems: "center",
        flexDirection: "row",
        marginLeft: 2,
      } satisfies ViewStyle,
      stats: {
        alignItems: "center",
        flexDirection: "row",
        gap: 3,
        marginLeft: 2,
      } satisfies ViewStyle,
      additions: {
        color: theme.colors.statusSuccess,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 15,
      } satisfies TextStyle,
      deletions: {
        color: theme.colors.statusDanger,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 15,
      } satisfies TextStyle,
      details: {
        borderLeftColor: rail,
        borderLeftWidth: railWidth,
        flexShrink: 1,
        marginLeft: LABEL_INSET - 9,
        minWidth: 0,
        overflow: "hidden",
      } satisfies ViewStyle,
      detailsScroll: {
        maxHeight: MAX_DETAIL_HEIGHT,
      } satisfies ViewStyle,
      detailsContent: {
        gap: 6,
        paddingLeft: 8,
        paddingRight: 7,
        paddingVertical: 5,
      } satisfies ViewStyle,
      detailLabel: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 10,
        fontWeight: "500",
        letterSpacing: 0.35,
        lineHeight: 14,
        textTransform: "uppercase",
      } satisfies TextStyle,
      detailText: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      mutedText: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      searchLineNumber: {
        color: theme.colors.accent,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      pathRow: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
        minWidth: 0,
      } satisfies ViewStyle,
      pathText: {
        color: theme.colors.foreground,
        flex: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      section: {
        gap: 3,
      } satisfies ViewStyle,
      showMoreButton: {
        alignSelf: "flex-start",
        paddingHorizontal: 6,
        paddingVertical: 3,
        borderRadius: 2,
        marginTop: 3,
      } satisfies ViewStyle,
      showMoreText: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 10,
        fontWeight: "500",
        lineHeight: 14,
      } satisfies TextStyle,
      recallEntry: {
        borderLeftColor: alpha(theme.colors.border, 0.5),
        borderLeftWidth: 2,
        gap: 2,
        paddingLeft: 8,
      } satisfies ViewStyle,
      recallMeta: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 10.5,
        lineHeight: 15,
      } satisfies TextStyle,
      askPair: {
        gap: 2,
      } satisfies ViewStyle,
      askQuestion: {
        color: theme.colors.foregroundMuted,
        fontSize: 11.5,
        lineHeight: 17,
      } satisfies TextStyle,
      askAnswer: {
        color: theme.colors.foreground,
        fontSize: 12.5,
        lineHeight: 18,
      } satisfies TextStyle,
      factRows: {
        gap: 4,
        marginTop: 4,
      } satisfies ViewStyle,
      factRow: {
        alignItems: "flex-start",
        flexDirection: "row",
        gap: 10,
      } satisfies ViewStyle,
      factLabel: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        minWidth: 84,
      } satisfies TextStyle,
      factValue: {
        color: theme.colors.foreground,
        flex: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      codeHeader: {
        alignItems: "center",
        flexDirection: "row",
        justifyContent: "space-between",
        minWidth: "100%",
      } satisfies ViewStyle,
      copyButton: {
        alignItems: "center",
        borderRadius: 2,
        flexDirection: "row",
        gap: 3,
        paddingHorizontal: 4,
        paddingVertical: 2,
      } satisfies ViewStyle,
      copyText: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 14,
      } satisfies TextStyle,
      todoList: {
        gap: 2,
      } satisfies ViewStyle,
      todoRow: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
        minWidth: 0,
      } satisfies ViewStyle,
      todoTitle: {
        color: theme.colors.foreground,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        minWidth: 0,
      } satisfies TextStyle,
      todoDone: {
        color: theme.colors.foregroundMuted,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        minWidth: 0,
        textDecorationLine: "line-through",
      } satisfies TextStyle,
      imageSurface: {
        backgroundColor: codeSurface,
        borderColor: rail,
        borderRadius: 6,
        borderWidth: 1,
        minWidth: "100%",
        overflow: "hidden",
      } satisfies ViewStyle,
      imageThumbnail: {
        height: 200,
        width: "100%",
      } satisfies ViewStyle,
      imageExpanded: {
        height: 480,
        width: "100%",
      } satisfies ViewStyle,
      codeSurface: {
        minWidth: "100%",
        paddingHorizontal: 8,
        paddingVertical: 6,
      } satisfies ViewStyle,
      codeCard: {
        backgroundColor: codeSurface,
        borderColor: rail,
        borderRadius: 6,
        borderWidth: 1,
        overflow: "hidden",
      } satisfies ViewStyle,
      codeCardHeader: {
        alignItems: "center",
        borderBottomColor: rail,
        borderBottomWidth: 1,
        flexDirection: "row",
        justifyContent: "space-between",
        minWidth: "100%",
        paddingHorizontal: 8,
        paddingVertical: 4,
      } satisfies ViewStyle,
      codeCardLanguage: {
        color: gutter,
        fontFamily: "monospace",
        fontSize: 10,
        fontWeight: "500",
        letterSpacing: 0.4,
        lineHeight: 14,
      } satisfies TextStyle,
      shellCommandScroll: {
        flex: 1,
        minWidth: 0,
      } satisfies ViewStyle,
      shellCommand: {
        color: theme.colors.foreground,
        fontSize: 11.5,
        lineHeight: 16,
      } satisfies TextStyle,
      /** Command output recedes: it is reference material, not the point of the row. */
      shellOutput: {
        color: theme.colors.foregroundMuted,
      } satisfies TextStyle,
      shellExitFailed: {
        color: theme.colors.statusDanger,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      codeLineRow: {
        flexDirection: "row",
        gap: 8,
      } satisfies ViewStyle,
      codeGutter: {
        color: gutter,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        minHeight: 16,
        textAlign: "right",
        width: 22,
      } satisfies TextStyle,
      codeScroll: {
        maxWidth: "100%",
      } satisfies ViewStyle,
      codeLine: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        minHeight: 16,
      } satisfies TextStyle,
      diffSurface: {
        backgroundColor: codeSurface,
        borderColor: rail,
        borderRadius: 6,
        borderWidth: 1,
        minWidth: "100%",
        overflow: "hidden",
        paddingVertical: 2,
      } satisfies ViewStyle,
      diffLine: {
        flexDirection: "row",
        minHeight: 16,
        paddingHorizontal: 5,
      } satisfies ViewStyle,
      diffMarker: {
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        width: 12,
      } satisfies TextStyle,
      diffText: {
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      diffTextWrap: {
        flex: 1,
        flexShrink: 1,
      } satisfies TextStyle,
      diffAdded: {
        backgroundColor: diffAdded,
      } satisfies ViewStyle,
      diffRemoved: {
        backgroundColor: diffRemoved,
      } satisfies ViewStyle,
      diffMeta: {
        backgroundColor: diffMeta,
      } satisfies ViewStyle,
      reasoningBody: {
        gap: 3,
        paddingLeft: 8,
        paddingRight: 7,
        paddingVertical: 5,
      } satisfies ViewStyle,
      stepList: {
        gap: 10,
        paddingLeft: 8,
        paddingRight: 7,
        paddingVertical: 5,
      } satisfies ViewStyle,
      stepHeader: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
      } satisfies ViewStyle,
      stepBody: {
        gap: 3,
        marginLeft: 16,
      } satisfies ViewStyle,
      reasoningLine: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 17,
      } satisfies TextStyle,
      reasoningHeading: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 12,
        fontWeight: "600",
        lineHeight: 17,
      } satisfies TextStyle,
      reasoningBullet: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 17,
        width: 14,
      } satisfies TextStyle,
      reasoningBulletRow: {
        alignItems: "flex-start",
        flexDirection: "row",
        gap: 4,
      } satisfies ViewStyle,
      reasoningQuote: {
        borderLeftColor: rail,
        borderLeftWidth: railWidth,
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 17,
        paddingLeft: 6,
      } satisfies TextStyle,
      reasoningInlineCode: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 3,
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 11,
        paddingHorizontal: 3,
      } satisfies TextStyle,
      reasoningSpacer: {
        height: 2,
      } satisfies ViewStyle,
      subAgentProgress: {
        borderLeftColor: rail,
        borderLeftWidth: railWidth,
        gap: 1,
        paddingBottom: 2,
        paddingLeft: NEST_INSET,
        paddingTop: 1,
      } satisfies ViewStyle,
      subAgentLine: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
        minWidth: 0,
      } satisfies ViewStyle,
      subAgentLineIcon: {
        alignItems: "center",
        justifyContent: "center",
        width: 14,
      } satisfies ViewStyle,
      subAgentLineLabel: {
        color: theme.colors.foreground,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 11,
        fontWeight: "600",
        lineHeight: 16,
      } satisfies TextStyle,
      subAgentLineSummary: {
        color: theme.colors.foregroundMuted,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        minWidth: 0,
      } satisfies TextStyle,
      subAgentMore: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        paddingLeft: 19,
      } satisfies TextStyle,
      subAgentAction: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
        minWidth: 0,
        paddingLeft: 19,
      } satisfies ViewStyle,
      subAgentActionIcon: {
        alignItems: "center",
        justifyContent: "center",
        width: 14,
      } satisfies ViewStyle,
      subAgentActionLabel: {
        color: theme.colors.foreground,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      subAgentActionSummary: {
        color: theme.colors.foregroundMuted,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        minWidth: 0,
      } satisfies TextStyle,
      childTimelineSection: {
        gap: 2,
      } satisfies ViewStyle,
      childTimelineHeader: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
      } satisfies ViewStyle,
      childTimelineList: {
        borderLeftColor: rail,
        borderLeftWidth: railWidth,
        gap: 1,
        paddingLeft: NEST_INSET,
      } satisfies ViewStyle,
      childTimelineItem: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
        minWidth: 0,
        paddingVertical: 1,
      } satisfies ViewStyle,
      childTimelineItemTitle: {
        color: theme.colors.foreground,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 11,
        fontWeight: "500",
        lineHeight: 15,
      } satisfies TextStyle,
      childTimelineItemSummary: {
        color: theme.colors.foregroundMuted,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 14,
        minWidth: 0,
      } satisfies TextStyle,
      childTimelineItemMeta: {
        color: theme.colors.foregroundMuted,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 14,
      } satisfies TextStyle,
      empty: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      pendingRow: {
        alignItems: "center",
        flexDirection: "row",
        gap: 8,
        paddingVertical: 4,
      } satisfies ViewStyle,
      paseoStack: {
        gap: 6,
      } satisfies ViewStyle,
      paseoHero: {
        borderLeftColor: rail,
        borderLeftWidth: railWidth + 1,
        paddingHorizontal: 6,
        paddingVertical: 2,
      } satisfies ViewStyle,
      paseoHeroRow: {
        alignItems: "center",
        flexDirection: "row",
        gap: 6,
      } satisfies ViewStyle,
      paseoHeroIcon: {
        alignItems: "center",
        height: 16,
        justifyContent: "center",
        width: 16,
      } satisfies ViewStyle,
      paseoHeroTitle: {
        color: theme.colors.foreground,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        fontWeight: "600",
        lineHeight: 16,
      } satisfies TextStyle,
      paseoHeroSubtitle: {
        color: theme.colors.foregroundMuted,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 14,
      } satisfies TextStyle,
      paseoRows: {
        gap: 2,
      } satisfies ViewStyle,
      paseoRow: {
        alignItems: "flex-start",
        flexDirection: "row",
        gap: 8,
        minWidth: 0,
      } satisfies ViewStyle,
      paseoKey: {
        color: theme.colors.foregroundMuted,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 15,
        minWidth: 90,
      } satisfies TextStyle,
      paseoValue: {
        color: theme.colors.foreground,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 15,
        minWidth: 0,
      } satisfies TextStyle,
      paseoPrompt: {
        backgroundColor: codeSurface,
        borderLeftColor: rail,
        borderLeftWidth: 1,
        borderRadius: 4,
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        paddingHorizontal: 6,
        paddingVertical: 4,
      } satisfies TextStyle,
      paseoList: {
        gap: 0,
      } satisfies ViewStyle,
      paseoListItem: {
        borderTopColor: rail,
        borderTopWidth: 1,
        gap: 1,
        paddingHorizontal: 5,
        paddingVertical: 3,
      } satisfies ViewStyle,
      paseoListItemHeader: {
        alignItems: "center",
        flexDirection: "row",
        gap: 7,
        minWidth: 0,
      } satisfies ViewStyle,
      paseoListItemTitle: {
        color: theme.colors.foreground,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        fontWeight: "500",
        lineHeight: 15,
        minWidth: 0,
      } satisfies TextStyle,
      paseoListItemMeta: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 14,
      } satisfies TextStyle,
      paseoChips: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 5,
      } satisfies ViewStyle,
      paseoChip: {
        borderColor: rail,
        borderRadius: 3,
        borderWidth: 1,
        paddingHorizontal: 4,
        paddingVertical: 1,
      } satisfies ViewStyle,
      paseoChipText: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 14,
      } satisfies TextStyle,
      paseoStatus: {
        alignSelf: "flex-start",
      } satisfies ViewStyle,
      paseoStatusText: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 10,
        fontWeight: "500",
        lineHeight: 14,
      } satisfies TextStyle,
    }),
    [
      codeSurface,
      diffAdded,
      diffMeta,
      diffRemoved,
      gutter,
      palette,
      rail,
      railWidth,
      theme,
    ],
  );
}

export type ActivityStyles = ReturnType<typeof useActivityStyles>;

function useQuietRow(calm: boolean) {
  const prefs = useActivityPrefs();
  const [hovered, setHovered] = useState(false);
  const onHoverChange = useCallback((next: boolean) => setHovered(next), []);
  const opacity = quietOpacity(prefs.quiet);
  return { onHoverChange, quiet: calm && !hovered && opacity < 1 ? { opacity } : null };
}

function statusIcon(status: ToolCallData["status"]): string {
  switch (status) {
    case "running":
      return "LoaderCircle";
    case "completed":
      return "CircleCheck";
    case "failed":
      return "CircleX";
    case "canceled":
      return "CircleSlash2";
  }
}

function asToolCallDetail(value: ToolCallData["detail"]): ToolCallDetail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = Reflect.get(value, "type");
  if (typeof type !== "string") return null;
  return value as unknown as ToolCallDetail;
}

function DetailLabel({ children, style }: { children: ReactNode; style: TextStyle }) {
  return <Text style={style}>{children}</Text>;
}

function PathRow({
  icon,
  path,
  styles,
}: {
  icon: string;
  path: string;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  return (
    <View style={styles.pathRow}>
      <Icon name={icon} color={styles.pathText.color} size={12} />
      <Text selectable style={styles.pathText}>
        {path}
      </Text>
    </View>
  );
}

/**
 * A command, syntax colored with the theme's own colors. Rendered inside the
 * row's summary Text, so it inherits the muted summary color for every token the
 * bash grammar does not name. Longer commands keep every line: a heredoc or a
 * chained command must not lose its tail.
 */
function HighlightedCommand({ text, theme }: { text: string; theme: Theme }) {
  const tokens = useHighlightTokens(text, "bash", theme.colors);
  if (!tokens) return <>{text}</>;
  return (
    <>
      {tokens.map((line, lineIndex) => (
        <Fragment key={`cmd-${lineIndex}`}>
          {lineIndex > 0 ? "\n" : null}
          {line.map((token, tokenIndex) =>
            token.color ? (
              <Text key={`token-${lineIndex}-${tokenIndex}`} style={{ color: token.color }}>
                {token.content}
              </Text>
            ) : (
              token.content
            ),
          )}
        </Fragment>
      ))}
    </>
  );
}

function TokenizedLines({
  lines,
  styles,
  gutter = false,
}: {
  lines: HighlightToken[][];
  styles: ReturnType<typeof useActivityStyles>;
  /** Line numbers in a muted column, aligned with the code. */
  gutter?: boolean;
}) {
  const width = String(lines.length).length;
  return (
    <View>
      {lines.map((line, lineIndex) => (
        <View key={`line-${lineIndex}`} style={gutter ? styles.codeLineRow : undefined}>
          {gutter ? (
            <Text style={styles.codeGutter}>{String(lineIndex + 1).padStart(width, " ")}</Text>
          ) : null}
          <Text selectable style={styles.codeLine}>
            {line.length === 0
              ? " "
              : line.map((token, tokenIndex) => {
                  const tokenStyle: TextStyle = {
                    color: token.color ?? styles.codeLine.color,
                    ...(token.fontStyle && token.fontStyle & 1 ? { fontStyle: "italic" } : {}),
                    ...(token.fontStyle && token.fontStyle & 2 ? { fontWeight: "700" } : {}),
                    ...(token.fontStyle && token.fontStyle & 4
                      ? { textDecorationLine: "underline" }
                      : {}),
                  };
                  return (
                    <Text key={`${lineIndex}-${tokenIndex}`} style={tokenStyle}>
                      {token.content}
                    </Text>
                  );
                })}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Copy-to-clipboard control shared by every code and command surface. */
function CopyCodeButton({
  code,
  theme,
  styles,
}: {
  code: string;
  theme: Theme;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    void copyText(code).then(
      () => {
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => {
        toast.error("Copy failed");
      },
    );
  }, [code, toast]);

  return (
    <Pressable
      accessibilityLabel={copied ? "Copied" : "Copy code"}
      accessibilityRole="button"
      onPress={handleCopy}
      style={styles.copyButton}
    >
      <Icon
        name={copied ? "Check" : "Copy"}
        color={copied ? theme.colors.statusSuccess : styles.copyText.color}
        size={11}
      />
      <Text style={styles.copyText}>{copied ? "Copied" : "Copy"}</Text>
    </Pressable>
  );
}

function HighlightedCodeBlock({
  code,
  language,
  theme,
  label,
  styles,
  chrome,
}: {
  code: string;
  language: string;
  theme: Theme;
  label?: string;
  styles: ReturnType<typeof useActivityStyles>;
  /** Overrides the saved code-chrome setting, for surfaces that need a fixed frame. */
  chrome?: CodeChrome;
}) {
  const prefs = useActivityPrefs();
  const frame = chrome ?? prefs.codeChrome;
  const [showAll, setShowAll] = useState(false);
  const preview = useMemo(() => previewText(code, prefs.previewLines), [code, prefs.previewLines]);
  const displayCode = showAll ? code : preview.text;
  const tokens = useHighlightTokens(displayCode, language, theme.colors);
  const lineCount = displayCode.split("\n").length;
  const framed = frame !== "bare";
  return (
    <View {...cmonoViewEscape} style={styles.section}>
      {!framed ? (
        <View style={styles.codeHeader}>
          {label ? <DetailLabel style={styles.detailLabel}>{label}</DetailLabel> : <View />}
          <CopyCodeButton code={code} theme={theme} styles={styles} />
        </View>
      ) : null}
      <View style={styles.codeCard}>
        {framed ? (
          <View style={styles.codeCardHeader}>
            <Text style={styles.codeCardLanguage}>{(label ?? language).toLowerCase()}</Text>
            <CopyCodeButton code={code} theme={theme} styles={styles} />
          </View>
        ) : null}
        <ScrollView horizontal nestedScrollEnabled style={styles.codeScroll}>
          <View style={styles.codeSurface}>
            {tokens ? (
              <TokenizedLines
                lines={tokens}
                styles={styles}
                gutter={frame === "gutter" && lineCount > 1}
              />
            ) : frame === "gutter" && lineCount > 1 ? (
              <PlainLines code={displayCode} styles={styles} />
            ) : (
              <Text selectable style={styles.codeLine}>
                {displayCode || " "}
              </Text>
            )}
          </View>
        </ScrollView>
      </View>
      {preview.truncated ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowAll(!showAll)}
          style={styles.showMoreButton}
        >
          <Text style={styles.showMoreText}>
            {showAll
              ? "Show less"
              : `Show all (${preview.totalLines} lines, ${preview.totalChars.toLocaleString()} chars)`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

type ReadImageState =
  | { status: "loading" }
  | { status: "ok"; uri: string }
  | { status: "fallback" };

/** Code with no grammar to highlight: still numbered when the gutter is on. */
function PlainLines({
  code,
  styles,
}: {
  code: string;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const lines = code.split("\n");
  const width = String(lines.length).length;
  return (
    <View>
      {lines.map((line, index) => (
        <View key={`plain-${index}`} style={styles.codeLineRow}>
          <Text style={styles.codeGutter}>{String(index + 1).padStart(width, " ")}</Text>
          <Text selectable style={styles.codeLine}>
            {line || " "}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The plugin's code card for callers outside this module: the dashboard preview
 * renders the same component the timeline does, so the two cannot drift.
 */
export function CodeCard({
  code,
  language,
  label,
  theme,
  chrome,
}: {
  code: string;
  language: string;
  label?: string;
  theme: Theme;
  chrome?: CodeChrome;
}) {
  const palette = usePalette(theme);
  const styles = useActivityStyles(theme, palette);
  return (
    <HighlightedCodeBlock
      code={code}
      language={language}
      label={label}
      theme={theme}
      styles={styles}
      chrome={chrome}
    />
  );
}

function ReadImageBlock({
  filePath,
  agentId,
  fallback,
  styles,
}: {
  filePath: string;
  agentId: string;
  fallback: ReactNode;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const loadImage = useRpc(readImageRpc);
  const [image, setImage] = useState<ReadImageState>({ status: "loading" });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setImage({ status: "loading" });
    setExpanded(false);
    void loadImage({ filePath, agentId }).then(
      (result) => {
        if (cancelled) return;
        if (result.status === "ok" && result.data && result.mimeType) {
          setImage({ status: "ok", uri: `data:${result.mimeType};base64,${result.data}` });
        } else {
          setImage({ status: "fallback" });
        }
      },
      () => {
        if (!cancelled) setImage({ status: "fallback" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentId, filePath, loadImage]);

  if (image.status === "fallback") return <>{fallback}</>;
  if (image.status === "loading") return <Text style={styles.mutedText}>Loading image…</Text>;
  return (
    <View style={styles.section}>
      <DetailLabel style={styles.detailLabel}>Image</DetailLabel>
      <Pressable
        accessibilityLabel={expanded ? "Collapse image" : "Expand image"}
        accessibilityRole="button"
        onPress={() => setExpanded(!expanded)}
      >
        <View style={styles.imageSurface}>
          <Image
            source={{ uri: image.uri }}
            style={expanded ? styles.imageExpanded : styles.imageThumbnail}
            resizeMode="contain"
          />
        </View>
      </Pressable>
    </View>
  );
}

function DiffBlock({
  detail,
  palette,
  styles,
}: {
  detail: Extract<ToolCallDetail, { type: "edit" }>;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const [showAll, setShowAll] = useState(false);
  const prefs = useActivityPrefs();
  const wrap = prefs.diffWrap === "on";
  // 0 means the reader asked for whole blocks: never cut a diff they chose to see.
  const limit = prefs.previewLines;
  const lines = useMemo(() => diffLinesForDetail(detail), [detail]);
  const isTruncated = limit > 0 && lines.length > limit;
  const displayLines = showAll || !isTruncated ? lines : lines.slice(0, limit);
  const body = (
    <View style={styles.diffSurface}>
      {displayLines.length === 0 ? (
        <Text style={styles.empty}>Diff unavailable.</Text>
      ) : (
        displayLines.map((line, index) => (
          <DiffRow
            key={`${line.kind}-${index}`}
            line={line}
            palette={palette}
            styles={styles}
            wrap={wrap}
          />
        ))
      )}
    </View>
  );

  return (
    <View style={styles.section}>
      <DetailLabel style={styles.detailLabel}>Diff</DetailLabel>
      {wrap ? (
        body
      ) : (
        <ScrollView horizontal nestedScrollEnabled style={styles.codeScroll}>
          {body}
        </ScrollView>
      )}
      {isTruncated ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowAll(!showAll)}
          style={styles.showMoreButton}
        >
          <Text style={styles.showMoreText}>
            {showAll ? "Show less" : `Show all (${lines.length} lines)`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function DiffRow({
  line,
  palette,
  styles,
  wrap,
}: {
  line: DiffLine;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
  wrap: boolean;
}) {
  const rowStyle =
    line.kind === "add"
      ? styles.diffAdded
      : line.kind === "remove"
        ? styles.diffRemoved
        : line.kind === "meta"
          ? styles.diffMeta
          : undefined;
  const marker =
    line.kind === "add" ? "+" : line.kind === "remove" ? "-" : line.kind === "meta" ? "" : " ";
  const markerColor =
    line.kind === "add"
      ? palette.statusColors.completed
      : line.kind === "remove"
        ? palette.statusColors.failed
        : line.kind === "meta"
          ? palette.categoryColors.search
          : palette.categoryColors.unknown;
  return (
    <View style={[styles.diffLine, rowStyle]}>
      <Text style={[styles.diffMarker, { color: markerColor }]}>{marker}</Text>
      <Text
        selectable
        style={[
          styles.diffText,
          wrap ? styles.diffTextWrap : null,
          { color: line.kind === "meta" ? markerColor : styles.codeLine.color },
        ]}
      >
        {line.text || " "}
      </Text>
    </View>
  );
}

function PendingOutput({ styles }: { styles: ReturnType<typeof useActivityStyles> }) {
  return (
    <View style={styles.pendingRow}>
      <ActivityIndicator size="small" color={styles.mutedText.color} />
      <Text style={styles.mutedText}>Waiting for output…</Text>
    </View>
  );
}

function SearchDetail({
  detail,
  headerSummary,
  cwd,
  theme,
  styles,
}: {
  detail: Extract<ToolCallDetail, { type: "search" }>;
  headerSummary: string | undefined;
  /** Passed down from the card: this component never looks up agent state itself. */
  cwd: string | null;
  theme: Theme;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  // A file search lists paths; a content search groups matches per file. Pi emits
  // neither in opencode's format, so both parsers run.
  const fileList = useMemo(
    () => (detail.toolName === "glob" ? parsePiFileList(detail.content) : undefined),
    [detail.toolName, detail.content],
  );
  const parsed = useMemo(
    () => parseOpencodeSearchContent(detail.content) ?? parsePiSearchContent(detail.content),
    [detail.content],
  );
  const displayPath = useCallback(
    (filePath: string) => (cwd ? relativeToRoot(filePath, cwd) : filePath),
    [cwd],
  );
  const { matchCount, fileCount } = resolveSearchCounts(detail, parsed);
  const meta = fileList
    ? `${fileList.length} file${fileList.length === 1 ? "" : "s"}`
    : [
        matchCount !== undefined ? `${matchCount} match${matchCount === 1 ? "" : "es"}` : undefined,
        fileCount !== undefined ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");

  if (fileList) {
    return (
      <>
        {notInHeader(detail.query, headerSummary) ? (
          <Text style={styles.detailText}>Pattern: {detail.query}</Text>
        ) : null}
        <Text style={styles.mutedText}>{meta}</Text>
        {fileList.map((filePath) => (
          <PathRow
            key={filePath}
            icon={fileIconForPath(filePath)}
            path={displayPath(filePath)}
            styles={styles}
          />
        ))}
      </>
    );
  }

  return (
    <>
      {notInHeader(detail.query, headerSummary) ? (
        <Text style={styles.detailText}>Query: {detail.query}</Text>
      ) : null}
      {meta ? <Text style={styles.mutedText}>{meta}</Text> : null}
      {parsed && parsed.files.length > 0 ? (
        parsed.files.map((file, fileIndex) => {
          const display = file.filePath ? displayPath(file.filePath) : "";
          return (
            <View key={file.filePath || `matches-${fileIndex}`} style={styles.section}>
              {file.filePath ? (
                <PathRow icon={fileIconForPath(file.filePath)} path={display} styles={styles} />
              ) : null}
              {file.matches.map((match, matchIndex) => (
                <View
                  key={`${file.filePath}-${match.lineNumber ?? "line"}-${matchIndex}`}
                  style={{ flexDirection: "row", gap: 6, minWidth: 0 }}
                >
                  {match.lineNumber !== undefined ? (
                    <Text style={styles.searchLineNumber}>{match.lineNumber}:</Text>
                  ) : null}
                  <Text selectable style={[styles.detailText, { flex: 1 }]}>
                    {match.text || " "}
                  </Text>
                </View>
              ))}
            </View>
          );
        })
      ) : (
        <>
          {detail.filePaths?.map((filePath) => (
            <PathRow
              key={filePath}
              icon={fileIconForPath(filePath)}
              path={displayPath(filePath)}
              styles={styles}
            />
          ))}
          {detail.content && matchCount !== 0 ? (
            <HighlightedCodeBlock
              code={detail.content}
              language="text"
              styles={styles}
              theme={theme}
            />
          ) : null}
        </>
      )}
      {detail.webResults?.map((result) => (
        <View key={result.url} style={styles.section}>
          <Text selectable style={styles.detailText}>
            {result.title}
          </Text>
          <Text selectable style={styles.mutedText}>
            {result.url}
          </Text>
        </View>
      ))}
      {detail.annotations?.map((annotation, index) => (
        <Text key={`${annotation}-${index}`} selectable style={styles.mutedText}>
          {annotation}
        </Text>
      ))}
    </>
  );
}

/**
 * A shell call as one surface: the command in the card's header, colored with the
 * bash grammar, then the output it produced and how the command exited.
 */
/**
 * Shell output is streamed and read from its tail, so it is not governed by the
 * code-block line setting: a command that prints a hundred lines must keep the
 * newest ones, or following it means following something that was never rendered.
 * This ceiling only keeps a pathological dump from stalling layout.
 */
const MAX_SHELL_OUTPUT_LINES = 1_000;
const MAX_SHELL_OUTPUT_CHARS = 100_000;

function ShellCommandBlock({
  detail,
  theme,
  styles,
}: {
  detail: Extract<ToolCallDetail, { type: "shell" }> & {
    truncated?: boolean;
    fullOutputPath?: string;
  };
  theme: Theme;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const output = detail.output ?? "";
  const window = useMemo(
    () => tailPreview(output, MAX_SHELL_OUTPUT_LINES, MAX_SHELL_OUTPUT_CHARS),
    [output],
  );
  const tokens = useHighlightTokens(window.text, "ansi", theme.colors);
  const failed = typeof detail.exitCode === "number" && detail.exitCode !== 0;
  return (
    <View {...cmonoViewEscape} style={styles.section}>
      <View style={styles.codeCard}>
        <View style={styles.codeCardHeader}>
          <Text
            style={[
              styles.codeCardLanguage,
              { color: failed ? theme.colors.statusDanger : styles.codeCardLanguage.color },
            ]}
          >
            $
          </Text>
          <ScrollView horizontal nestedScrollEnabled style={styles.shellCommandScroll}>
            <Text selectable style={[styles.codeLine, styles.shellCommand]}>
              <HighlightedCommand text={detail.command} theme={theme} />
            </Text>
          </ScrollView>
          {detail.cwd ? (
            <Text numberOfLines={1} style={styles.codeCardLanguage}>
              {detail.cwd.split("/").pop()}
            </Text>
          ) : null}
          <CopyCodeButton code={detail.command} theme={theme} styles={styles} />
        </View>
        {output ? (
          <>
            {window.hiddenLines > 0 ? (
              <Text style={[styles.mutedText, styles.codeSurface]}>
                …earlier output hidden ({window.hiddenLines.toLocaleString()} lines)
              </Text>
            ) : null}
            <ScrollView horizontal nestedScrollEnabled style={styles.codeScroll}>
              <View style={styles.codeSurface}>
                {tokens ? (
                  <TokenizedLines lines={tokens} styles={styles} />
                ) : (
                  <Text selectable style={[styles.codeLine, styles.shellOutput]}>
                    {window.text || " "}
                  </Text>
                )}
              </View>
            </ScrollView>
          </>
        ) : null}
      </View>
      {detail.exitCode !== undefined && detail.exitCode !== null ? (
        <Text style={failed ? styles.shellExitFailed : styles.mutedText}>
          Exit code {detail.exitCode}
        </Text>
      ) : null}
      {detail.truncated === true ? (
        <Text selectable style={styles.mutedText}>
          {detail.fullOutputPath
            ? `Output truncated · ${compactText(detail.fullOutputPath, 160)}`
            : "Output truncated"}
        </Text>
      ) : null}
    </View>
  );
}

function DetailBody({
  data,
  agentId,
  cwd,
  theme,
  palette,
  styles,
}: {
  data: ToolCallData;
  agentId: string;
  /** Resolved once by the card; detail views never touch agent state. */
  cwd: string | null;
  theme: Theme;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const detail = asToolCallDetail(data.detail);
  if (!detail) return <Text style={styles.empty}>Tool details unavailable.</Text>;

  if (isSkillTool(data.name)) {
    const skillName = skillNameForDetail(detail);
    if (!skillName) return <Text style={styles.empty}>Skill details unavailable.</Text>;
    return (
      <Text selectable style={styles.detailText}>
        {skillName}
      </Text>
    );
  }

  switch (detail.type) {
    case "shell": {
      // A provider's shell detail has no truncation fields, so the facts are where
      // they arrive: say the row is incomplete, and where the rest is.
      const fullOutputPath = data.facts?.fullOutputPath;
      return (
        <ShellCommandBlock
          detail={{
            ...detail,
            truncated: data.facts?.truncated === true,
            ...(typeof fullOutputPath === "string" ? { fullOutputPath } : {}),
          }}
          theme={theme}
          styles={styles}
        />
      );
    }
    case "read":
      if (readErrorMessage(detail.content) && data.errorText) {
        return (
          <PathRow
            icon={data.presentation.fileIcon ?? "Eye"}
            path={detail.filePath}
            styles={styles}
          />
        );
      }
      if (!shouldAttemptImageLoad(detail.filePath, detail.content)) {
        const range = readRangeLabel(detail.offset, detail.limit);
        return (
          <>
            <PathRow
              icon={data.presentation.fileIcon ?? "Eye"}
              path={detail.filePath}
              styles={styles}
            />
            {range ? <Text style={styles.mutedText}>{range}</Text> : null}
            {detail.content ? (
              <HighlightedCodeBlock
                code={detail.content}
                language={data.presentation.language ?? "text"}
                label="Contents"
                styles={styles}
                theme={theme}
              />
            ) : null}
          </>
        );
      }
      return (
        <>
          <PathRow
            icon={data.presentation.fileIcon ?? "Eye"}
            path={detail.filePath}
            styles={styles}
          />
          <ReadImageBlock
            filePath={detail.filePath}
            agentId={agentId}
            styles={styles}
            fallback={
              detail.content ? (
                <HighlightedCodeBlock
                  code={detail.content}
                  language={data.presentation.language ?? "text"}
                  label="Contents"
                  styles={styles}
                  theme={theme}
                />
              ) : null
            }
          />
        </>
      );
    case "write":
      return (
        <>
          <PathRow
            icon={data.presentation.fileIcon ?? "Pencil"}
            path={detail.filePath}
            styles={styles}
          />
          {detail.content ? (
            <HighlightedCodeBlock
              code={detail.content}
              language={data.presentation.language ?? "text"}
              label="Written contents"
              styles={styles}
              theme={theme}
            />
          ) : null}
        </>
      );
    case "edit": {
      const isOversized = editDiffContentSize(detail) > MAX_DIFF_CHARS;

      if (isOversized && effectiveUnifiedDiff(detail) === undefined) {
        return (
          <>
            <PathRow
              icon={data.presentation.fileIcon ?? "Pencil"}
              path={detail.filePath}
              styles={styles}
            />
            {detail.oldString ? (
              <HighlightedCodeBlock
                code={detail.oldString}
                language={data.presentation.language ?? "text"}
                label="Before"
                styles={styles}
                theme={theme}
              />
            ) : null}
            {detail.newString ? (
              <HighlightedCodeBlock
                code={detail.newString}
                language={data.presentation.language ?? "text"}
                label="After"
                styles={styles}
                theme={theme}
              />
            ) : null}
          </>
        );
      }

      return (
        <>
          <PathRow
            icon={data.presentation.fileIcon ?? "Pencil"}
            path={detail.filePath}
            styles={styles}
          />
          <DiffBlock detail={detail} palette={palette} styles={styles} />
        </>
      );
    }
    case "search":
      return (
        <SearchDetail
          detail={detail}
          headerSummary={data.presentation.summary}
          cwd={cwd}
          theme={theme}
          styles={styles}
        />
      );
    case "fetch":
      return (
        <>
          {notInHeader(detail.url, data.presentation.summary) ? (
            <Text selectable style={styles.detailText}>
              {detail.url}
            </Text>
          ) : null}
          {detail.result ? (
            <HighlightedCodeBlock
              code={detail.result}
              language="text"
              label="Result"
              styles={styles}
              theme={theme}
            />
          ) : null}
          {detail.code !== undefined ? (
            <Text style={styles.mutedText}>
              HTTP {detail.code} {detail.codeText ?? ""}
            </Text>
          ) : null}
        </>
      );
    case "worktree_setup":
      return (
        <>
          <Text style={styles.detailText}>Branch: {detail.branchName}</Text>
          <Text style={styles.mutedText}>Path: {detail.worktreePath}</Text>
          {detail.log ? (
            <HighlightedCodeBlock
              code={detail.log}
              language="ansi"
              label="Setup log"
              styles={styles}
              theme={theme}
            />
          ) : null}
        </>
      );
    case "sub_agent":
      if (piSubagentOperation(data.name) && parsePiSubagentCall(undefined, detail.log).lifecycle) {
        return (
          <PiSubagentToolDetail
            toolName={data.name}
            input={undefined}
            output={detail.log}
            theme={theme}
            palette={palette}
            styles={styles}
          />
        );
      }
      return (
        <>
          {notInHeader(detail.subAgentType, data.presentation.summary) ? (
            <Text style={styles.detailText}>{detail.subAgentType}</Text>
          ) : null}
          {notInHeader(detail.description, data.presentation.summary) ? (
            <Text style={styles.mutedText}>{detail.description}</Text>
          ) : null}
          {detail.log && !subAgentLogFullyShown(detail) ? (
            <HighlightedCodeBlock
              code={detail.log}
              language="ansi"
              label="Activity log"
              styles={styles}
              theme={theme}
            />
          ) : null}
        </>
      );
    case "plain_text":
      return (
        <Text selectable style={styles.detailText}>
          {detail.text ?? ""}
        </Text>
      );
    case "plan":
      return (
        <Text selectable style={styles.detailText}>
          {detail.text}
        </Text>
      );
    case "unknown": {
      if (piSubagentOperation(data.name)) {
        return (
          <PiSubagentToolDetail
            toolName={data.name}
            input={detail.input}
            output={detail.output}
            theme={theme}
            palette={palette}
            styles={styles}
          />
        );
      }
      if (isOpencodeSubagentTool(data.name)) {
        return (
          <OpencodeSubagentToolDetail
            toolName={data.name}
            input={detail.input}
            output={detail.output}
            theme={theme}
            palette={palette}
            styles={styles}
          />
        );
      }
      if (isCodeModeTool(data.name)) {
        const code = extractCodeModeCode(detail.input);
        if (code) {
          return (
            <CodeModeToolDetail code={code} output={detail.output} theme={theme} styles={styles} />
          );
        }
      }
      if (data.name.trim().toLowerCase() === "ls") {
        const entries = parsePiLsOutput(detail.output);
        if (entries !== null) {
          return (
            <View style={styles.section}>
              <DetailLabel style={styles.detailLabel}>Files</DetailLabel>
              {entries.length === 0 ? (
                <Text style={styles.empty}>No files returned.</Text>
              ) : (
                entries.map((entry) => (
                  <PathRow
                    key={entry}
                    icon={entry.endsWith("/") ? "Folder" : fileIconForPath(entry)}
                    path={entry}
                    styles={styles}
                  />
                ))
              )}
            </View>
          );
        }
      }
      if (isSubagentSupervisorTool(data.name)) {
        return (
          <SupervisorToolDetail
            toolName={data.name}
            input={detail.input}
            output={detail.output}
            theme={theme}
            palette={palette}
            styles={styles}
          />
        );
      }
      if (isBgWaitTool(data.name)) {
        return (
          <BgWaitToolDetail
            toolName={data.name}
            input={detail.input}
            output={detail.output}
            theme={theme}
            palette={palette}
            styles={styles}
          />
        );
      }
      if (isOmpWaitTool(data.name)) {
        return (
          <OmpWaitToolDetail
            toolName={data.name}
            input={detail.input}
            output={detail.output}
            theme={theme}
            palette={palette}
            styles={styles}
          />
        );
      }
      if (isOmpFindTool(data.name)) {
        return <OmpFindToolDetail input={detail.input} output={detail.output} styles={styles} />;
      }
      if (isTodoTool(data.name)) {
        return (
          <TodoToolDetail
            toolName={data.name}
            input={detail.input}
            output={detail.output}
            theme={theme}
            palette={palette}
            styles={styles}
          />
        );
      }
      if (githubToolKind(data.name)) {
        return (
          <GithubToolDetail
            toolName={data.name}
            input={detail.input}
            output={detail.output}
            theme={theme}
            palette={palette}
            styles={styles}
          />
        );
      }
      if (exaToolKind(data.name)) {
        return (
          <ExaToolDetail
            toolName={data.name}
            input={detail.input}
            output={detail.output}
            theme={theme}
            styles={styles}
          />
        );
      }
      if (isRecallTool(data.name)) {
        const recalled = parseRecallOutput(extractPiToolText(detail.output)?.text);
        if (recalled) {
          return <RecallDetail result={recalled} styles={styles} />;
        }
      }
      const mcpTool = parseMcpToolName(data.name);
      if (mcpTool) {
        return (
          <McpCallDetail
            mcp={mcpTool}
            input={detail.input}
            output={detail.output}
            theme={theme}
            palette={palette}
            styles={styles}
          />
        );
      }
      if (paseoToolLeafName(data.name)) {
        return (
          <PaseoToolDetail
            toolName={data.name}
            input={detail.input}
            output={detail.output}
            theme={theme}
            palette={palette}
            styles={styles}
          />
        );
      }
      if (isAskTool(data.name)) {
        const text = extractPiToolText(detail.output)?.text ?? "";
        const answers = parseAskAnswers(text);
        if (answers.length > 0) {
          return <AskAnswersDetail answers={answers} styles={styles} />;
        }
      }
      const facts = toolDetailFacts(detail.output);
      if (facts) {
        return (
          <ToolFacts
            text={facts.text}
            facts={facts.facts}
            omitted={facts.omitted}
            styles={styles}
          />
        );
      }
      const codeInput = extractCodeInput(data.name, detail.input);
      if (codeInput) {
        return (
          <>
            <HighlightedCodeBlock
              code={codeInput.code}
              language={codeInput.language}
              label="Input"
              styles={styles}
              theme={theme}
            />
            {hasMeaningfulUnknownValue(detail.output) ? (
              <HighlightedCodeBlock
                code={formatUnknownValue(detail.output)}
                language="json"
                label="Output"
                styles={styles}
                theme={theme}
              />
            ) : data.status === "running" ? (
              <PendingOutput styles={styles} />
            ) : null}
          </>
        );
      }
      return (
        <>
          {hasMeaningfulUnknownValue(detail.input) ? (
            <HighlightedCodeBlock
              code={formatUnknownValue(detail.input)}
              language="json"
              label="Input"
              styles={styles}
              theme={theme}
            />
          ) : null}
          {hasMeaningfulUnknownValue(detail.output) ? (
            <HighlightedCodeBlock
              code={formatUnknownValue(detail.output)}
              language="json"
              label="Output"
              styles={styles}
              theme={theme}
            />
          ) : data.status === "running" ? (
            <PendingOutput styles={styles} />
          ) : null}
        </>
      );
    }
  }
}

/**
 * An MCP tool no renderer targets: the arguments as fields, then its result.
 *
 * The alternative was two JSON blocks. Arguments are the part that identifies what
 * happened — which container, which repo — and they are almost always flat.
 */
function McpCallDetail({
  mcp,
  input,
  output,
  theme,
  palette,
  styles,
}: {
  mcp: McpToolName;
  input: unknown;
  output: unknown;
  theme: Theme;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const fields = mcpCallFields(input);
  const text = extractPiToolText(output)?.text ?? "";
  const result = text.trim();
  return (
    <View style={styles.paseoStack}>
      {fields.length > 0 ? (
        <Section title={`${mcpToolLabel(mcp.tool)} call`} styles={styles}>
          <PaseoFields fields={fields} palette={palette} styles={styles} />
        </Section>
      ) : null}
      {result ? (
        <HighlightedCodeBlock
          code={result}
          language={/^\s*[[{]/.test(result) ? "json" : "text"}
          label="Result"
          styles={styles}
          theme={theme}
        />
      ) : null}
    </View>
  );
}

/** One recalled session entry: where it is, then what it says. */
function RecallDetail({
  result,
  styles,
}: {
  result: RecallResult;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  return (
    <View style={styles.paseoStack}>
      {result.entries.map((entry) => (
        <View key={`recall-${entry.index}`} style={styles.recallEntry}>
          <Text style={styles.recallMeta} numberOfLines={1}>
            #{entry.index}
            {`  ${entry.kind}`}
            {entry.time ? `  ${entry.time}` : ""}
          </Text>
          {entry.preview ? (
            <Text selectable style={styles.detailText} numberOfLines={3}>
              {entry.preview}
            </Text>
          ) : null}
          {entry.note ? <Text style={styles.mutedText}>{entry.note}</Text> : null}
        </View>
      ))}
      {result.hints.map((hint) => (
        <Text key={hint} style={styles.mutedText}>
          {hint}
        </Text>
      ))}
    </View>
  );
}

/** An ask tool's result as the Q/A pairs it actually is, rather than one paragraph. */
function AskAnswersDetail({
  answers,
  styles,
}: {
  answers: AskAnswer[];
  styles: ReturnType<typeof useActivityStyles>;
}) {
  return (
    <View style={styles.section}>
      {answers.map((entry, index) => (
        <View key={`${index}-${entry.question}`} style={styles.askPair}>
          <Text style={styles.askQuestion}>{entry.question}</Text>
          <Text selectable style={styles.askAnswer}>
            {entry.answer}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A tool nobody has written a parser for: the text the model saw, plus its scalar
 * facts behind a disclosure. The alternative was a JSON block that made the reader
 * decode a schema mid-scan, and the fields are capped by the provider either way.
 */
function ToolFacts({
  text,
  facts,
  omitted = 0,
  styles,
}: {
  text?: string;
  facts: { label: string; value: string }[] | Record<string, string | number | boolean>;
  omitted?: number;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const rows = Array.isArray(facts)
    ? facts
    : Object.entries(facts).map(([label, value]) => ({ label, value: String(value) }));
  // No second disclosure: the row is already open, so its facts show with it.
  return (
    <View style={styles.section}>
      {text ? (
        <Text selectable style={styles.detailText}>
          {text}
        </Text>
      ) : null}
      <DetailLabel style={styles.detailLabel}>Details</DetailLabel>
      <View style={styles.factRows}>
        {rows.map((fact) => (
          <View key={fact.label} style={styles.factRow}>
            <Text style={styles.factLabel}>{fact.label}</Text>
            <Text selectable style={styles.factValue}>
              {fact.value}
            </Text>
          </View>
        ))}
        {omitted > 0 ? <Text style={styles.mutedText}>+{omitted} more fields</Text> : null}
      </View>
    </View>
  );
}

function SubAgentProgress({
  detail,
  styles,
  toolName,
}: {
  detail: Extract<ToolCallDetail, { type: "sub_agent" }>;
  styles: ReturnType<typeof useActivityStyles>;
  toolName: string;
}) {
  const actions = useMemo(() => {
    const explicitActions = [...(detail.actions ?? [])].sort(
      (left, right) => left.index - right.index,
    );
    return explicitActions.length > 0 ? explicitActions : parseSubAgentActionLog(detail.log);
  }, [detail.actions, detail.log]);
  const hiddenActionCount = Math.max(0, actions.length - MAX_VISIBLE_SUBAGENT_ACTIONS);
  const visibleActions = actions.slice(hiddenActionCount);
  const thinking =
    (actions.length > 0 && !(detail.actions?.length ?? 0)) ||
    (piSubagentOperation(toolName) && parsePiSubagentCall(undefined, detail.log).lifecycle)
      ? null
      : detail.log?.replace(/\s+/g, " ").trim();

  if (!thinking && actions.length === 0) return null;

  return (
    <View style={styles.subAgentProgress}>
      {thinking ? (
        <View style={styles.subAgentLine}>
          <View style={styles.subAgentLineIcon}>
            <Icon name="Brain" color={styles.subAgentLineSummary.color} size={11} />
          </View>
          <Text numberOfLines={1} style={styles.subAgentLineLabel}>
            Thinking
          </Text>
          <Text numberOfLines={1} style={styles.subAgentLineSummary}>
            {thinking}
          </Text>
        </View>
      ) : null}
      {hiddenActionCount > 0 ? (
        <Text style={styles.subAgentMore}>+{hiddenActionCount} more…</Text>
      ) : null}
      {visibleActions.map((action) => {
        const presentation = resolveSubAgentActionPresentation(action.toolName, action.summary);
        return (
          <View key={`${action.index}-${action.toolName}`} style={styles.subAgentAction}>
            <View style={styles.subAgentActionIcon}>
              <Icon name={presentation.icon} color={styles.subAgentActionSummary.color} size={11} />
            </View>
            <Text numberOfLines={1} style={styles.subAgentActionLabel}>
              {presentation.label}
            </Text>
            {presentation.summaryIcon && action.summary ? (
              <Icon
                name={presentation.summaryIcon}
                color={styles.subAgentActionSummary.color}
                size={11}
              />
            ) : null}
            {action.summary ? (
              <Text numberOfLines={1} style={styles.subAgentActionSummary}>
                {action.summary}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function renderInlineReasoning(
  text: string,
  styles: ReturnType<typeof useActivityStyles>,
): ReactNode[] {
  return parseInlineMarkdown(text).map((part, index) => {
    if (part.type === "text") return part.text;
    const style =
      part.type === "bold"
        ? [styles.reasoningLine, { fontWeight: "700" as const }]
        : part.type === "italic"
          ? [styles.reasoningLine, { fontStyle: "italic" as const }]
          : styles.reasoningInlineCode;
    const escape = part.type === "code" ? cmonoTextEscape : undefined;
    return (
      <Text {...escape} key={`inline-${index}`} style={style}>
        {part.text}
      </Text>
    );
  });
}

function InlineReasoning({
  text,
  styles,
}: {
  text: string;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  return <Text style={styles.reasoningLine}>{renderInlineReasoning(text, styles)}</Text>;
}

function ReasoningBlockList({
  blocks,
  keyPrefix,
  theme,
  styles,
}: {
  blocks: ReasoningMarkdownBlock[];
  keyPrefix: string;
  theme: Theme;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  return (
    <>
      {blocks.map((block, index) => {
        const key = `${keyPrefix}-${block.type}-${index}`;
        switch (block.type) {
          case "code":
            return (
              <HighlightedCodeBlock
                key={key}
                code={block.text}
                language={block.language ?? "text"}
                theme={theme}
                styles={styles}
              />
            );
          case "spacer":
            return <View key={key} style={styles.reasoningSpacer} />;
          case "heading":
            return (
              <Text key={key} selectable style={styles.reasoningHeading}>
                {renderInlineReasoning(block.text, styles)}
              </Text>
            );
          case "unordered":
            return (
              <View key={key} style={styles.reasoningBulletRow}>
                <Text style={styles.reasoningBullet}>•</Text>
                <InlineReasoning text={block.text} styles={styles} />
              </View>
            );
          case "ordered":
            return (
              <View key={key} style={styles.reasoningBulletRow}>
                <Text style={styles.reasoningBullet}>{block.marker}</Text>
                <InlineReasoning text={block.text} styles={styles} />
              </View>
            );
          case "quote":
            return (
              <Text key={key} selectable style={styles.reasoningQuote}>
                {renderInlineReasoning(block.text, styles)}
              </Text>
            );
          case "paragraph":
            return <InlineReasoning key={key} text={block.text} styles={styles} />;
        }
      })}
    </>
  );
}

export function ReasoningMarkdown({
  text,
  theme,
  styles,
}: {
  text: string;
  theme: Theme;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const blocks = useMemo(() => parseReasoningMarkdown(text), [text]);
  return (
    <View {...cuiViewEscape} style={styles.reasoningBody}>
      <ReasoningBlockList blocks={blocks} keyPrefix="reasoning" theme={theme} styles={styles} />
    </View>
  );
}

function ReasoningStep({
  index,
  text,
  active,
  theme,
  palette,
  styles,
}: {
  index: number;
  text: string;
  active: boolean;
  theme: Theme;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const blocks = useMemo(() => parseReasoningMarkdown(text), [text]);
  return (
    <View style={styles.section}>
      <View style={styles.stepHeader}>
        <Icon
          name={active ? "LoaderCircle" : "CircleCheck"}
          color={active ? palette.statusColors.running : palette.statusColors.completed}
          size={11}
        />
        <Text style={styles.detailLabel}>Step {index + 1}</Text>
      </View>
      <View style={styles.stepBody}>
        <ReasoningBlockList
          blocks={blocks}
          keyPrefix={`step-${index}`}
          theme={theme}
          styles={styles}
        />
      </View>
    </View>
  );
}

/**
 * Keeps a scroll region pinned to its tail while `live`, until the reader scrolls
 * up. Growth alone never stops it: revealed or streamed content can arrive faster
 * than the scroll lands, and treating that as "the reader scrolled away" is what
 * used to leave the tail unreachable.
 */
function useTailFollow(live: boolean) {
  const ref = useRef<NativeScrollView | null>(null);
  const following = useRef(true);
  const lastOffset = useRef(0);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance = contentSize.height - layoutMeasurement.height - contentOffset.y;
    // Only the reader scrolling up stops the follow.
    if (contentOffset.y < lastOffset.current - 16) following.current = false;
    else if (distance <= 32) following.current = true;
    lastOffset.current = contentOffset.y;
  }, []);
  const follow = useCallback(() => {
    if (!live || !following.current) return;
    const scroll = () => ref.current?.scrollToEnd({ animated: false });
    // After the frame that laid the new content out: react-native-web does not
    // report content-size changes reliably, so this cannot ride on that event.
    const frame = (
      globalThis as { requestAnimationFrame?: (callback: () => void) => unknown }
    ).requestAnimationFrame;
    if (frame) frame(scroll);
    else scroll();
  }, [live]);
  const handleContentSizeChange = useCallback(() => follow(), [follow]);
  return { ref, follow, handleScroll, handleContentSizeChange };
}

function ReasoningText({
  text,
  phase,
  live,
  theme,
  palette,
  styles,
}: {
  text: string;
  phase: ReasoningData["phase"];
  /** The newest thinking block: follow its tail while it streams and stays open. */
  live: boolean;
  theme: Theme;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const prefs = useActivityPrefs();
  const [showAll, setShowAll] = useState(false);
  const isStreaming = phase === "streaming";
  // Whole text, not a head preview: a truncated block would stop following the
  // stream and hide the newest lines. The tail is what matters, and the cap that
  // governs it is the thinking setting.
  const window = tailPreview(text, prefs.thinkingLines, MAX_REASONING_TAIL_CHARS);
  const shownText = showAll ? text : window.text;
  const revealedText = useRevealedText(shownText, phase);
  const steps = useMemo(() => splitReasoningSteps(revealedText), [revealedText]);
  // The newest block follows its tail until it stops being the newest; a finished
  // block that is now history opens at its start.
  const tail = useTailFollow(live);
  useEffect(() => {
    tail.follow();
  }, [revealedText, tail.follow]);

  return (
    <View>
      <ScrollView
        ref={tail.ref}
        nestedScrollEnabled
        onContentSizeChange={tail.handleContentSizeChange}
        onScroll={tail.handleScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator
        style={styles.detailsScroll}
      >
        {steps.length <= 1 ? (
          <ReasoningMarkdown text={revealedText} theme={theme} styles={styles} />
        ) : (
          <View {...cuiViewEscape} style={styles.stepList}>
            {steps.map((step, index) => (
              <ReasoningStep
                key={`step-${index}`}
                index={index}
                text={step}
                active={isStreaming && index === steps.length - 1}
                theme={theme}
                palette={palette}
                styles={styles}
              />
            ))}
          </View>
        )}
      </ScrollView>
      {window.hiddenLines > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowAll(!showAll)}
          style={styles.showMoreButton}
        >
          <Text style={styles.showMoreText}>
            {showAll
              ? "Show less"
              : `Earlier reasoning hidden · ${window.hiddenLines.toLocaleString()} lines`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ActivityHeader({
  icon,
  iconColor,
  title,
  summary,
  summaryContent,
  onHoverChange,
  fileDisplay,
  status,
  statusColor,
  stats,
  expanded,
  onPress,
  expandable = true,
  styles,
}: {
  icon: string;
  iconColor: string;
  title: string;
  summary?: string;
  /** Rendered instead of the plain summary: syntax-colored spans for a shell command. */
  summaryContent?: ReactNode;
  onHoverChange?: (hovered: boolean) => void;
  fileDisplay?: { dir?: string; base: string };
  status?: ToolCallData["status"];
  statusColor?: string;
  stats?: ToolCallData["presentation"]["diffStats"];
  expanded: boolean;
  onPress: () => void;
  expandable?: boolean;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const content = (
    <>
      <View style={styles.iconBadge}>
        <Icon name={icon} color={iconColor} size={12} />
      </View>
      <Text {...cuiTextEscape} numberOfLines={1} style={styles.title}>
        {title}
      </Text>
      {fileDisplay ? (
        <View style={styles.filePath}>
          {fileDisplay.dir ? (
            <Text numberOfLines={1} style={styles.fileDir}>
              {truncateDirFront(fileDisplay.dir)}/
            </Text>
          ) : null}
          <Text numberOfLines={1} style={styles.fileName}>
            {fileDisplay.base}
          </Text>
        </View>
      ) : summary || summaryContent ? (
        <Text numberOfLines={1} style={styles.summary}>
          {summaryContent ?? summary}
        </Text>
      ) : null}
      {stats ? (
        <View style={styles.stats}>
          <Text style={styles.additions}>+{stats.additions}</Text>
          <Text style={styles.deletions}>-{stats.deletions}</Text>
        </View>
      ) : null}
      {status ? (
        <View style={styles.status}>
          <Icon name={statusIcon(status)} color={statusColor ?? styles.title.color} size={12} />
        </View>
      ) : null}
      {expandable ? (
        <Icon
          name={expanded ? "ChevronDown" : "ChevronRight"}
          color={styles.summary.color}
          size={12}
        />
      ) : (
        <Icon name="ChevronRight" color="transparent" size={12} />
      )}
    </>
  );
  if (!expandable) {
    return (
      <View
        onPointerEnter={onHoverChange ? () => onHoverChange(true) : undefined}
        onPointerLeave={onHoverChange ? () => onHoverChange(false) : undefined}
        style={styles.headerButton}
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${title}`}
      accessibilityRole="button"
      onPress={onPress}
      onHoverIn={onHoverChange ? () => onHoverChange(true) : undefined}
      onHoverOut={onHoverChange ? () => onHoverChange(false) : undefined}
      style={styles.headerButton}
    >
      {content}
    </Pressable>
  );
}

export function ColorfulReasoning({
  agentId,
  item,
  theme,
  timestamp,
  layout,
}: PluginTimelineItemProps<ReasoningItemData>) {
  const palette = usePalette(theme);
  const styles = useActivityStyles(theme, palette);
  const isStreaming = item.data.phase === "streaming";
  const isLatest = useIsLatestReasoning(agentId, timestamp, isStreaming);
  const isLiveTail = useIsLiveTail(agentId, timestamp, isStreaming, layout.platform);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = resolveExpansion(useExpansionMode("thinking"), isLatest, userExpanded);
  const quiet = useQuietRow(!expanded && !isStreaming);
  useReplyCodeStyles(theme);
  const meta = useMemo(
    () =>
      formatReasoningMeta(
        splitReasoningSteps(item.data.text).length,
        estimateReasoningTokens(item.data.text),
      ),
    [item.data.text],
  );
  const toggle = useCallback(() => {
    setUserExpanded(!expanded);
  }, [expanded]);
  return (
    <View
      {...pmonoViewEscape}
      style={[styles.card, isLiveTail ? styles.cardTail : null, quiet.quiet]}
    >
      <ActivityHeader
        icon="Sparkles"
        iconColor={palette.categoryColors.reasoning}
        title="Thinking"
        summary={meta}
        expanded={expanded}
        onPress={toggle}
        onHoverChange={quiet.onHoverChange}
        styles={styles}
      />
      {expanded ? (
        <View {...cmonoViewEscape} style={styles.details}>
          <ReasoningText
            text={item.data.text}
            phase={item.data.phase}
            live={isStreaming || isLatest}
            theme={theme}
            palette={palette}
            styles={styles}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Resolves the agent's working directory for path shortening.
 *
 * Kept in its own component on purpose: Paseo only provides agent state inside a
 * timeline or popover, and `useAgent` throws anywhere else (a plugin screen, for
 * example). Mounting this component only when that state exists keeps the card
 * itself renderable in a preview.
 */
function AgentCwd({
  agentId,
  children,
}: {
  agentId: string;
  children: (cwd: string | null) => ReactNode;
}) {
  const cwd = useAgent(agentId, (agent) => agent.cwd) ?? null;
  return <>{children(cwd)}</>;
}

export function ColorfulToolCall({
  preview,
  ...props
}: PluginTimelineItemProps<ToolCallItemData> & { preview?: boolean }) {
  if (preview) return <ToolCallCard {...props} cwd={null} />;
  return (
    <AgentCwd agentId={props.agentId}>{(cwd) => <ToolCallCard {...props} cwd={cwd} />}</AgentCwd>
  );
}

function ToolCallCard({
  agentId,
  item,
  theme,
  timestamp,
  layout,
  cwd,
}: PluginTimelineItemProps<ToolCallItemData> & { cwd: string | null }) {
  const palette = usePalette(theme);
  const styles = useActivityStyles(theme, palette);
  const isRunning = item.data.status === "running";
  const isLatest = useIsLatestToolCall(agentId, timestamp, isRunning);
  const isLiveTail = useIsLiveTail(agentId, timestamp, isRunning, layout.platform);
  const detail = asToolCallDetail(item.data.detail);
  const isTaskUpdate = isTodoTool(item.data.name);
  const itemTimestamp = timestamp.getTime();
  const latestTaskUpdateTimestamp = useLatestTaskUpdateTimestamp(agentId, timestamp, isTaskUpdate);
  const isLatestTaskCard = isLatestTaskUpdate(itemTimestamp, latestTaskUpdateTimestamp);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const [taskUpdateOverride, setTaskUpdateOverride] = useState<TaskUpdateExpansionOverride | null>(
    null,
  );
  const categoryColor = palette.categoryColors[item.data.presentation.category];
  const statusColor = palette.statusColors[item.data.status];
  const expansionMode = useExpansionMode(
    expansionTargetForToolCall(item.data.name, detail?.type ?? "unknown"),
  );
  const baseExpanded = isTaskUpdate
    ? resolveTaskUpdateExpansion(
        expansionMode,
        isLatestTaskCard,
        latestTaskUpdateTimestamp,
        taskUpdateOverride,
      )
    : resolveExpansion(expansionMode, isLatest, userExpanded);
  const hasDetails = detail ? hasMeaningfulToolCallDetail(detail) : true;
  const hasBody = toolCallHasBody(item.data.name, detail, item.data.presentation.summary);
  const expandable = hasBody || Boolean(item.data.errorText);
  const expanded = expandable ? baseExpanded : false;
  const toggle = useCallback(() => {
    if (isTaskUpdate) {
      setTaskUpdateOverride({ expanded: !expanded, latestTimestamp: latestTaskUpdateTimestamp });
    } else {
      setUserExpanded(!expanded);
    }
  }, [expanded, isTaskUpdate, latestTaskUpdateTimestamp]);
  const operation = piSubagentOperation(item.data.name);
  const subAgentDetail = detail?.type === "sub_agent" ? detail : null;
  const headerFile = useMemo(() => {
    const filePath = item.data.presentation.filePath;
    if (!filePath) return null;
    const relative = cwd ? relativeToRoot(filePath, cwd) : filePath;
    return splitFileDisplay(compactText(relative) ?? relative);
  }, [cwd, item.data.presentation.filePath]);
  const headerSummary =
    detail?.type === "shell" && item.data.presentation.summary
      ? stripLeadingCwdCd(item.data.presentation.summary, cwd)
      : item.data.presentation.summary;
  const prefs = useActivityPrefs();
  // A typed detail has no field for these; the provider attaches them as facts.
  // A shell shows truncation inline, so the same two keys are not repeated here.
  const facts = useMemo(() => {
    const all = item.data.facts ?? {};
    const inline = detail?.type === "shell" ? ["truncated", "fullOutputPath"] : [];
    const merged: Record<string, string | number | boolean> = Object.fromEntries(
      Object.entries(all).filter(([key]) => !inline.includes(key)),
    );
    if (operation) {
      const text =
        detail?.type === "sub_agent"
          ? detail.log
          : detail?.type === "unknown"
            ? detail.output
            : undefined;
      const outputFile = parsePiSubagentCall(undefined, text).outputFile;
      if (outputFile) merged.outputFile = outputFile;
      return agentRowFacts(merged);
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }, [item.data.facts, detail, operation]);
  const quiet = useQuietRow(!expanded && item.data.status === "completed");
  // A running call's detail follows its tail like a terminal, and stops when the
  // reader scrolls up. A finished call's detail opens at its start.
  const tail = useTailFollow(expanded && isRunning);
  useEffect(() => {
    tail.follow();
  }, [item.data.detail, expanded, tail.follow]);
  useReplyCodeStyles(theme);
  // A shell row colors its command once expanded (or always, per settings); collapsed rows stay quiet.
  const coloredCommand =
    detail?.type === "shell" &&
    headerSummary !== undefined &&
    commandColorEnabled(prefs.commandColor, expanded);
  return (
    <View
      {...pmonoViewEscape}
      style={[styles.card, isLiveTail ? styles.cardTail : null, quiet.quiet]}
    >
      <ActivityHeader
        icon={item.data.presentation.icon}
        iconColor={categoryColor}
        title={item.data.presentation.label}
        summary={headerSummary}
        summaryContent={
          coloredCommand ? <HighlightedCommand text={headerSummary} theme={theme} /> : undefined
        }
        fileDisplay={headerFile ?? undefined}
        status={item.data.status}
        statusColor={statusColor}
        stats={item.data.presentation.diffStats}
        expanded={expanded}
        onPress={toggle}
        onHoverChange={quiet.onHoverChange}
        expandable={expandable}
        styles={styles}
      />
      {operation && detail ? (
        <PiSubagentLifecycleSummary
          toolName={item.data.name}
          input={undefined}
          output={
            detail.type === "sub_agent"
              ? detail.log
              : detail.type === "unknown"
                ? detail.output
                : undefined
          }
          theme={theme}
          palette={palette}
          styles={styles}
        />
      ) : null}
      {hasDetails && subAgentDetail ? (
        <SubAgentProgress detail={subAgentDetail} toolName={item.data.name} styles={styles} />
      ) : null}
      {expandable && expanded ? (
        <View {...cmonoViewEscape} style={styles.details}>
          <ScrollView
            ref={tail.ref}
            style={styles.detailsScroll}
            contentContainerStyle={styles.detailsContent}
            nestedScrollEnabled
            onContentSizeChange={tail.handleContentSizeChange}
            onScroll={tail.handleScroll}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator
          >
            {hasBody ? (
              <DetailBody
                data={item.data}
                agentId={agentId}
                cwd={cwd}
                theme={theme}
                palette={palette}
                styles={styles}
              />
            ) : null}
            {item.data.errorText ? (
              <View style={styles.section}>
                <DetailLabel style={styles.detailLabel}>Error</DetailLabel>
                <Text selectable style={{ ...styles.detailText, color: theme.colors.statusDanger }}>
                  {item.data.errorText}
                </Text>
              </View>
            ) : null}
            {facts ? <ToolFacts facts={facts} styles={styles} /> : null}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function todoStatusIcon(status: TodoData["items"][number]["status"]): string {
  switch (status) {
    case "completed":
      return "CircleCheck";
    case "in_progress":
      return "LoaderCircle";
    case "pending":
      return "Circle";
  }
}

export function ColorfulTodo({
  agentId,
  item,
  theme,
  timestamp,
}: PluginTimelineItemProps<TodoData>) {
  const palette = usePalette(theme);
  const styles = useActivityStyles(theme, palette);
  const done = item.data.items.filter((entry) => entry.status === "completed").length;
  const itemTimestamp = timestamp.getTime();
  const latestTaskUpdateTimestamp = useLatestTaskUpdateTimestamp(agentId, timestamp, true);
  const isLatestTaskCard = isLatestTaskUpdate(itemTimestamp, latestTaskUpdateTimestamp);
  const expansionMode = useExpansionMode("todo");
  const [userExpanded, setUserExpanded] = useState<TaskUpdateExpansionOverride | null>(null);
  const expanded = resolveTaskUpdateExpansion(
    expansionMode,
    isLatestTaskCard,
    latestTaskUpdateTimestamp,
    userExpanded,
  );
  const toggle = useCallback(() => {
    setUserExpanded({ expanded: !expanded, latestTimestamp: latestTaskUpdateTimestamp });
  }, [expanded, latestTaskUpdateTimestamp]);
  const quiet = useQuietRow(!expanded && done === item.data.items.length);
  useReplyCodeStyles(theme);
  return (
    <View {...pmonoViewEscape} style={[styles.card, quiet.quiet]}>
      <ActivityHeader
        icon="ListChecks"
        iconColor={palette.categoryColors.plan}
        title="Tasks"
        summary={`${done}/${item.data.items.length} done`}
        expanded={expanded}
        onPress={toggle}
        onHoverChange={quiet.onHoverChange}
        styles={styles}
      />
      {expanded ? (
        <View {...cmonoViewEscape} style={styles.details}>
          <ScrollView
            style={styles.detailsScroll}
            contentContainerStyle={styles.detailsContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
            <View style={styles.todoList}>
              {item.data.items.map((entry, index) => (
                <View key={`${entry.id}-${index}`} style={styles.todoRow}>
                  <Icon
                    name={todoStatusIcon(entry.status)}
                    color={
                      entry.status === "completed"
                        ? palette.statusColors.completed
                        : entry.status === "in_progress"
                          ? palette.statusColors.running
                          : theme.colors.foregroundMuted
                    }
                    size={11}
                  />
                  <Text
                    numberOfLines={1}
                    selectable
                    style={entry.status === "completed" ? styles.todoDone : styles.todoTitle}
                  >
                    {todoTaskLabel(entry.id, entry.title)}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
