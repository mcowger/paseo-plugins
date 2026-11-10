import { translator } from "../shared/i18n";
import { endedStamp } from "../shared/turn-time";
import { useI18n } from "./i18n-client";
import { t } from "../shared/text";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useAgent, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { type ScrollView as NativeScrollView } from "react-native";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { parsePiSubagentCall, piSubagentOperation } from "../shared/pi-subagents";
import { compactText, estimateReasoningTokens, expansionTargetForToolCall, formatReasoningMeta, hasMeaningfulToolCallDetail, isAskTool, isTodoTool, MAX_VISIBLE_SUBAGENT_ACTIONS, parseSubAgentActionLog, relativeToRoot, resolveActivityPalette, resolveSubAgentActionPresentation, splitFileDisplay, splitReasoningSteps, stripAnsi, stripLeadingCwdCd, toolCallHasBody, truncateDirFront, type ActivityPalette, type ActivityThemeColors } from "../shared/presentation";
import { noticeSections } from "../shared/notice";
import type { ExpansionMode, ExpansionTarget, PaletteMode, Strength } from "../shared/settings";
import { activitySettings, DEFAULT_EXPANSION, DEFAULT_PALETTE_MODE, DEFAULT_STRENGTH, STRENGTH_OPACITY } from "../shared/settings";
import { formatDuration } from "../shared/timing";
import { isLatestTaskUpdate, resolveExpansion, resolveTaskUpdateExpansion, toolCallItemDataSchema, type ReasoningItemData, type TaskUpdateExpansionOverride, type ToolCallItemData, } from "../shared/timeline";
import { useActivityDetails } from "./activity-lazy";
import { usePendingPermissions } from "./attention";
import { densityMetrics, useDensity, useFoldRow, type DensityMetrics } from "./density";
import { useTypography } from "./typography";
import { buildActivityStyles } from "./activity-styles";
import { foldRuntime } from "./fold-runtime";
import { aria, Button } from "./kit";
import { createLatestRows, forgetWith } from "./latest-rows";
import { PiSubagentLifecycleSummary } from "./pi-subagent-summary";
import { PinnedPrompt, usePromptPin } from "./prompt-pin";
import { timingText, useLiveNow, useOnScreen, useRowTiming } from "./timing";
import { useFollowBottom, useFollowOutput } from "./settings-hooks";
import { useFx } from "./fx";
import { retryPiNotices } from "./transform";
import { failureText, lookFor, mcpParts, resolveVividPalette, VividHeader, zh, type LookKey, type RowStatus } from "./vivid";
import { cmonoViewEscape, cuiTextEscape, pmonoViewEscape } from "./web";

// Paseo spaces consecutive activity rows by applying its inter-row gap to the row
// that still has a newer neighbor. On the native inverted timeline the newest live
// row gets none, leaving no gap above it. The plugin supplies the missing gap on the
// row itself whenever it is the live tail.
// 本地补丁：行距按「行密度」取（client/density.ts）：紧凑行间 4px，标准 10px（0.3.0-local.1）。

type Theme = PluginTimelineItemProps["theme"];
type ToolCallData = z.output<typeof toolCallItemDataSchema>;

// 0.5.0：每个 Agent 最新的思考行、工具行、任务更新时间，有上限，折叠运行时忘掉 Agent 时一起丢掉（client/latest-rows.ts）。
const latestReasoning = createLatestRows();
const latestToolCall = createLatestRows();
const latestTaskUpdate = createLatestRows();
forgetWith(foldRuntime, [latestReasoning, latestToolCall, latestTaskUpdate]);
const getEmptyTaskUpdateTimestamp = () => 0;

function useIsLatestReasoning(agentId: string, timestamp: Date, isStreaming: boolean): boolean {
  const itemTime = timestamp.getTime();
  if (isStreaming || itemTime > latestReasoning.get(agentId)) {
    latestReasoning.note(agentId, itemTime);
  }

  const latestTime = useSyncExternalStore(
    latestReasoning.subscribe,
    () => latestReasoning.get(agentId),
    () => 0,
  );
  return isStreaming || (latestTime > 0 && itemTime >= latestTime);
}

function useIsLatestToolCall(agentId: string, timestamp: Date, isRunning: boolean): boolean {
  const itemTime = timestamp.getTime();
  if (isRunning || itemTime > latestToolCall.get(agentId)) {
    latestToolCall.note(agentId, itemTime);
  }

  const latestTime = useSyncExternalStore(
    latestToolCall.subscribe,
    () => latestToolCall.get(agentId),
    () => 0,
  );
  return isRunning || (latestTime > 0 && itemTime >= latestTime);
}

function useLatestTaskUpdateTimestamp(agentId: string, timestamp: Date, isTaskUpdate: boolean): number {
  const itemTime = timestamp.getTime();
  const subscribe = useCallback(
    (listener: () => void) => (isTaskUpdate ? latestTaskUpdate.subscribe(listener) : () => {}),
    [isTaskUpdate],
  );
  const getSnapshot = useCallback(
    () => (isTaskUpdate ? latestTaskUpdate.get(agentId) : 0),
    [agentId, isTaskUpdate],
  );
  const latestTimestamp = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getEmptyTaskUpdateTimestamp,
  );
  useLayoutEffect(() => {
    if (isTaskUpdate) latestTaskUpdate.note(agentId, itemTime);
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
    latestReasoning.subscribe,
    () => latestReasoning.get(agentId),
    () => 0,
  );
  const toolCallLatest = useSyncExternalStore(
    latestToolCall.subscribe,
    () => latestToolCall.get(agentId),
    () => 0,
  );
  return (
    active &&
    platform !== "web" &&
    timestamp.getTime() >= Math.max(reasoningLatest, toolCallLatest)
  );
}

function useExpansionMode(target: ExpansionTarget): ExpansionMode {
  const settings = useSettings(activitySettings);
  if (settings.status === "ready") return settings.values.expansion[target] ?? DEFAULT_EXPANSION[target];
  return DEFAULT_EXPANSION[target];
}

/** 0.11.0:预览等非 hook 场景的调色板解析（usePalette 的纯函数内核；经 props 传给 ui chunk 的预览卡）。 */
export function paletteFor(theme: Theme, mode: PaletteMode): ActivityPalette {
  return mode === "vivid" ? resolveVividPalette(theme) : resolveActivityPalette(mode === "theme" ? "vivid" : mode, theme.colors as ActivityThemeColors);
}

export function usePalette(theme: Theme): ActivityPalette {
  const settings = useSettings(activitySettings);
  const mode = settings.status === "ready" ? settings.values.palette : DEFAULT_PALETTE_MODE;
  return useMemo(() => paletteFor(theme, mode), [mode, theme]);
}

/** 「淡出强度」的档位 → 不透明度改由 shared/settings 的 STRENGTH_OPACITY 提供（preview/fold-row 共用）。 */
export function useStrength(): Strength {
  const settings = useSettings(activitySettings);
  return settings.status === "ready" ? settings.values.strength : DEFAULT_STRENGTH;
}

/** 0.11.0:「命令着色」档位（着色组件在 fx 懒加载块 client/command-tokens.tsx，常驻包不带 Prism）。 */
function useCommandColors(): "expanded" | "always" {
  const settings = useSettings(activitySettings);
  return settings.status === "ready" ? settings.values.commandColors : "expanded";
}

export function useActivityStyles(theme: Theme, palette: ActivityPalette, metrics: DensityMetrics) {
  const type = useTypography();
  return useMemo(() => buildActivityStyles(theme, palette, metrics, type), [metrics, palette, theme, type]);
}

export type ActivityStyles = ReturnType<typeof useActivityStyles>;

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
    const explicitActions = [...(detail.actions ?? [])].sort((left, right) => left.index - right.index);
    return explicitActions.length > 0 ? explicitActions : parseSubAgentActionLog(detail.log);
  }, [detail.actions, detail.log]);
  const hiddenActionCount = Math.max(0, actions.length - MAX_VISIBLE_SUBAGENT_ACTIONS);
  const visibleActions = actions.slice(hiddenActionCount);
  const thinking = (actions.length > 0 && !(detail.actions?.length ?? 0)) || (piSubagentOperation(toolName) && parsePiSubagentCall(undefined, detail.log).lifecycle)
    ? null : detail.log?.replace(/\s+/g, " ").trim();

  if (!thinking && actions.length === 0) return null;

  return (
    <View style={styles.subAgentProgress}>
      {thinking ? (
        <View style={styles.subAgentLine}>
          <View style={styles.subAgentLineIcon}>
            <Icon name="Brain" color={styles.subAgentLineSummary.color} size={11} />
          </View>
          <Text numberOfLines={1} style={styles.subAgentLineLabel}>
            {t("ui.thinking")}</Text>
          <Text numberOfLines={1} style={styles.subAgentLineSummary}>
            {thinking}
          </Text>
        </View>
      ) : null}
      {hiddenActionCount > 0 ? <Text style={styles.subAgentMore}>{t("ui.moreSteps", { count: hiddenActionCount })}</Text> : null}
      {visibleActions.map((action) => {
        const presentation = resolveSubAgentActionPresentation(action.toolName, action.summary);
        return (
          <View key={`${action.index}-${action.toolName}`} style={styles.subAgentAction}>
            <View style={styles.subAgentActionIcon}>
              <Icon name={presentation.icon} color={styles.subAgentActionSummary.color} size={11} />
            </View>
            <Text numberOfLines={1} style={styles.subAgentActionLabel}>
              {zh(presentation.label)}
            </Text>
            {presentation.summaryIcon && action.summary ? (
              <Icon name={presentation.summaryIcon} color={styles.subAgentActionSummary.color} size={11} />
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

function ActivityHeader({
  icon,
  iconColor,
  title,
  summary,
  summaryNode,
  fileDisplay,
  status,
  statusColor,
  stats,
  expanded,
  onPress,
  onHover,
  expandable = true,
  styles,
  stamp,
  vivid,
}: {
  vivid?: { theme: Theme; compact: boolean; look: LookKey; status?: RowStatus; statusText?: string; meta?: string; live?: boolean; icon?: string; metrics?: DensityMetrics; timing?: string | null };
  stamp?: string | null;
  icon: string;
  iconColor: string;
  title: string;
  summary?: string;
  summaryNode?: ReactNode;
  fileDisplay?: { dir?: string; base: string };
  status?: ToolCallData["status"];
  statusColor?: string;
  stats?: ToolCallData["presentation"]["diffStats"];
  expanded: boolean;
  onPress: () => void;
  onHover?: (hovering: boolean) => void;
  expandable?: boolean;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  if (vivid) {
    return (
      <VividHeader
        theme={vivid.theme}
        compact={vivid.compact}
        look={vivid.look}
        title={title}
        summary={summary}
        summaryNode={summaryNode}
        fileDisplay={fileDisplay}
        status={vivid.status}
        statusText={vivid.statusText}
        stats={stats}
        meta={vivid.meta}
        live={vivid.live}
        icon={vivid.icon}
        metrics={vivid.metrics}
        timing={vivid.timing}
        stamp={stamp}
        expanded={expanded}
        expandable={expandable}
        chevronColor={styles.summary.color}
        onPress={onPress}
        dirText={truncateDirFront}
        Pressable={({ children, style, onPress: press, label, expanded: open, disabled }) => (
          <Pressable
            accessibilityLabel={label}
            accessibilityRole="button"
            {...aria({ expanded: open })}
            disabled={disabled}
            onPress={press}
            onHoverIn={() => onHover?.(true)}
            onHoverOut={() => onHover?.(false)}
            onFocus={() => onHover?.(true)}
            onBlur={() => onHover?.(false)}
            style={[styles.headerButton, style]}
          >
            {children}
          </Pressable>
        )}
      />
    );
  }
  const content = (
    <>
      <View style={styles.iconBadge}>
        <Icon name={icon} color={iconColor} size={12} />
      </View>
      <Text {...cuiTextEscape} numberOfLines={1} style={styles.title}>{title}</Text>
      {summaryNode ? (
        <Text {...cuiTextEscape} numberOfLines={1} style={styles.summary}>{summaryNode}</Text>
      ) : fileDisplay ? (
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
      ) : summary ? (
        <Text numberOfLines={1} style={styles.summary}>
          {summary}
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
      {stamp ? <Text numberOfLines={1} style={{ color: styles.summary.color, fontSize: 11, flexShrink: 0 }}>{stamp}</Text> : null}
      {expandable ? (
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} color={styles.summary.color} size={12} />
      ) : (
        <Icon name="ChevronRight" color="transparent" size={12} />
      )}
    </>
  );
  if (!expandable) {
    return <View style={styles.headerButton}>{content}</View>;
  }
  return (
    <Pressable
      accessibilityLabel={expanded ? t("ui.collapseTitle", { title }) : t("ui.expandTitle", { title })}
      accessibilityRole="button"
      {...aria({ expanded })}
      onPress={onPress}
      onHoverIn={() => onHover?.(true)}
      onHoverOut={() => onHover?.(false)}
      onFocus={() => onHover?.(true)}
      onBlur={() => onHover?.(false)}
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
  useI18n();
  const { ReasoningText } = useActivityDetails();
  const palette = usePalette(theme);
  const metrics = densityMetrics(useDensity(), layout.compact, layout.platform !== "web");
  const styles = useActivityStyles(theme, palette, metrics);
  const isStreaming = item.data.phase === "streaming";
  // 0.5.0: a streaming row's key changes with every chunk; the finished text's key is the one the index will know.
  useFoldRow(agentId, isStreaming ? undefined : item.data.fold, undefined, timestamp);
  // 本地补丁：「思考了 8.4 秒」；思考中实时走表（只在前台、行在屏幕上时）。
  const rootRef = useRef<View>(null);
  const onScreen = useOnScreen(rootRef, isStreaming);
  const timing = useRowTiming(agentId, item.data.fold, isStreaming);
  const liveNow = useLiveNow(isStreaming && onScreen && timing?.start != null);
  const thinkTime = timingText(timing, isStreaming, liveNow);
  const timeSettings = useSettings(activitySettings);
  const stamp = endedStamp(timestamp, timeSettings.status === "ready" && timeSettings.values.foldTime, isStreaming);
  const isLatest = useIsLatestReasoning(agentId, timestamp, isStreaming);
  const isLiveTail = useIsLiveTail(agentId, timestamp, isStreaming, layout.platform);
  // 0.6.0 (grok-B2): the question of this turn, when this row opens the newest stretch of activity.
  const pin = usePromptPin(agentId, { key: isStreaming ? undefined : item.data.fold });
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = resolveExpansion(useExpansionMode("thinking"), isLatest, userExpanded);
  const [hovered, setHovered] = useState(false);
  const strength = useStrength();
  // 「淡出强度」：已完成的思考行退后；流式、展开、悬停/聚焦与本轮末行保持原样。
  const quiet = strength !== "full" && !isStreaming && !expanded && !isLiveTail && !hovered;
  const meta = useMemo(
    () =>
      formatReasoningMeta(
        splitReasoningSteps(item.data.text).length,
        estimateReasoningTokens(item.data.text),
      ),
    [item.data.text, translator()],
  );
  const toggle = useCallback(() => {
    setUserExpanded(!expanded);
  }, [expanded]);
  return (
    <View ref={rootRef} {...pmonoViewEscape} style={[styles.card, isLiveTail ? styles.cardTail : null, quiet ? { opacity: STRENGTH_OPACITY[strength] } : null]}>
      {pin ? <PinnedPrompt agentId={agentId} pin={pin} theme={theme} mode={palette.mode} metrics={metrics} /> : null}
      <ActivityHeader
        icon="Sparkles"
        iconColor={palette.categoryColors.reasoning}
        title={isStreaming ? (thinkTime ? t("ui.thinking3", { time: thinkTime }) : t("ui.thinking2")) : thinkTime ? t("ui.thoughtFor", { time: thinkTime }) : t("ui.thinking")}
        summary={palette.mode === "vivid" ? undefined : meta}
        expanded={expanded}
        onPress={toggle}
        onHover={setHovered}
        styles={styles}
        stamp={stamp}
        vivid={palette.mode === "vivid" ? { theme, compact: layout.compact, look: "think", meta, live: isStreaming, metrics } : undefined}
      />
      {expanded ? (
        <View {...cmonoViewEscape} style={styles.details}>
          <ReasoningText text={item.data.text} phase={item.data.phase} theme={theme} palette={palette} styles={styles} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * 0.6.0-local.5 (codex-vivid-merge-F2): under a Pi notice drawn without its reader because the download failed: try again
 * now (it is also retried by itself, client/transform.ts). Resident, so it works whether or not the details chunk loaded.
 */
export function PiReaderRetry({ theme }: { theme: Theme }) {
  useI18n();
  return (
    <View style={{ alignItems: "flex-start", paddingTop: 6 }}>
      <Button theme={theme} size="sm" icon="RefreshCw" label={t("ui.readAgain")} accessibilityLabel={t("ui.readPiNoticesAgain")} onPress={retryPiNotices} />
    </View>
  );
}

export function ColorfulToolCall({
  agentId,
  item,
  theme,
  timestamp,
  layout,
}: PluginTimelineItemProps<ToolCallItemData>) {
  useI18n();
  const { DetailBody } = useActivityDetails();
  const palette = usePalette(theme);
  const metrics = densityMetrics(useDensity(), layout.compact, layout.platform !== "web");
  const styles = useActivityStyles(theme, palette, metrics);
  const isRunning = item.data.status === "running";

  useFoldRow(agentId, item.data.fold, item.data.status, timestamp);
  // 本地补丁：耗时；运行中实时走表（只在前台、行在屏幕上时每秒刷新）。
  const rootRef = useRef<View>(null);
  const onScreen = useOnScreen(rootRef, isRunning);
  const timing = useRowTiming(agentId, item.data.fold, isRunning);
  const liveNow = useLiveNow(isRunning && onScreen && timing?.start != null);
  const durationText = item.data.notice || item.data.pi ? null : timingText(timing, isRunning, liveNow);
  const timeSettings = useSettings(activitySettings);
  const stamp = endedStamp(timestamp, timeSettings.status === "ready" && timeSettings.values.foldTime, isRunning);
  const isLatest = useIsLatestToolCall(agentId, timestamp, isRunning);
  const isLiveTail = useIsLiveTail(agentId, timestamp, isRunning, layout.platform);
  // 0.6.0 (grok-B2): the question of this turn, when this row opens the newest stretch of activity.
  const pin = usePromptPin(agentId, { key: item.data.fold, part: item.data.part });
  const detail = asToolCallDetail(item.data.detail);
  // 0.11.0:「跟随最新输出」矩阵：展开明细区流式更新时回底（域按明细类型映射；思考行走 thoughtTail*，折叠明细无内滚容器不在矩阵内）。
  const browserTool = /browser/i.test(item.data.name);
  const followArea = browserTool ? "browser" : detail?.type === "shell" ? "shell" : isTodoTool(item.data.name) ? "todo" : "logs";
  const followScope = useFollowOutput(followArea);
  // 只在运行中跟随：已完成的行展开时停在顶部，输出块显示头部预览（与 0.10.0 相同）。
  const follow = followScope && isRunning;
  const detailScrollRef = useRef<NativeScrollView | null>(null);
  const detailNearBottom = useRef(true);
  // 共享回底钩子（client/settings-hooks.ts）。内容键 = 明细 JSON 长度：宿主流式更新会原地改 detail
  // （对象身份不变），长度签名才能随内容增长变化，让跟随 effect 逐 tick 重跑。
  const detailContentKey = JSON.stringify(item.data.detail ?? {}).length;
  const { onScroll: onDetailScroll, onContentSizeChange: onDetailContentSizeChange } = useFollowBottom(detailScrollRef, detailNearBottom, detailContentKey, follow);
  const isTaskUpdate = isTodoTool(item.data.name);
  const itemTimestamp = timestamp.getTime();
  const latestTaskUpdateTimestamp = useLatestTaskUpdateTimestamp(agentId, timestamp, isTaskUpdate);
  const isLatestTaskCard = isLatestTaskUpdate(itemTimestamp, latestTaskUpdateTimestamp);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const [taskUpdateOverride, setTaskUpdateOverride] = useState<TaskUpdateExpansionOverride | null>(null);
  const categoryColor = palette.categoryColors[item.data.presentation.category];
  const statusColor = palette.statusColors[item.data.status];
  const configuredExpansion = useExpansionMode(expansionTargetForToolCall(item.data.name, detail?.type ?? "unknown"));
  // 本地补丁：后台任务通知默认收起（说明已在行头）。0.6.0：Pi 扩展的通知也是。
  const expansionMode = item.data.notice || item.data.pi ? "never" : configuredExpansion;
  const baseExpanded = isTaskUpdate
    ? resolveTaskUpdateExpansion(expansionMode, isLatestTaskCard, latestTaskUpdateTimestamp, taskUpdateOverride)
    : resolveExpansion(expansionMode, isLatest, userExpanded, item.data.status === "failed");
  const hasDetails = detail ? hasMeaningfulToolCallDetail(detail) : true;
  // A notice always has its explanation and state to show.
  const hasBody = Boolean(item.data.notice || item.data.pi) || toolCallHasBody(item.data.name, detail, item.data.presentation.summary);
  const expandable = hasBody || Boolean(item.data.errorText);
  const expanded = expandable ? baseExpanded : false;
  const [hovered, setHovered] = useState(false);
  const strength = useStrength();
  // 「淡出强度」：已完成的工具行退后（失败行同样淡出、保留红色状态）；运行中、等待批准、提问、展开、悬停/聚焦与本轮末行保持原样。
  // 没有正文的行（expandable=false）不淡：disabled Pressable 上 hover/focus 不触发，淡了就没有恢复全强度的途径。
  const quiet = strength !== "full" && expandable && !isRunning && !expanded && !isLiveTail && !hovered;
  const toggle = useCallback(() => {
    if (isTaskUpdate) {
      setTaskUpdateOverride({ expanded: !expanded, latestTimestamp: latestTaskUpdateTimestamp });
    } else {
      setUserExpanded(!expanded);
    }
  }, [expanded, isTaskUpdate, latestTaskUpdateTimestamp]);
  const operation = piSubagentOperation(item.data.name);
  const subAgentDetail = detail?.type === "sub_agent" ? detail : null;
  const cwd = useAgent(agentId, (agent) => agent.cwd);
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
  // 本地补丁：最新一条运行中的工具 + Agent 正在等权限 = 「等你批准」（琥珀）。
  // 0.6.0：提问（Claude 的 AskUserQuestion、Codex 的 request_user_input 等，请求的 kind 是 question）是「等你回答」，问号图标。
  const pending = usePendingPermissions(agentId, isRunning);
  const callId = item.data.callId;
  const waiting = isRunning && (callId ? pending.ids.has(callId) : pending.any && pending.ids.size === 0 && isLatest);
  const asking = waiting && (isAskTool(item.data.name) || (callId ? pending.questions.has(callId) : pending.onlyQuestions));
  const rowStatus: RowStatus = asking ? "question" : waiting ? "waiting" : item.data.status;
  const pi = item.data.pi;
  const look = pi ? pi.look : lookFor(item.data.name, detail, item.data.presentation);
  const mcp = look === "mcp" ? mcpParts(item.data.name) : null;
  const vividTitle = mcp ? t("ui.mcp") : zh(item.data.presentation.label);
  const vividSummary = mcp ? [t("ui.mcpSummary", { server: mcp.server, tool: mcp.tool }), headerSummary].filter(Boolean).join("  ") : headerSummary;
  // 0.6.0: a notice says how it ended in its own words; a reminder or an event (info) carries no state mark.
  const notice = item.data.notice;
  const noticeRaw = notice && detail?.type === "plain_text" ? detail.text : undefined;
  const noticeTime = useMemo(() => {
    const ms = noticeRaw ? noticeSections(noticeRaw).usage?.durationMs : null;
    return ms != null ? formatDuration(ms) : null;
  }, [noticeRaw, translator()]);
  // 0.6.0 (opus-B30): a Pi notice too; one that reports work still going on (仍在运行) gets no spinner, the work is elsewhere.
  const headerStatus: RowStatus | undefined = notice?.state === "info" || pi?.state === "info" || pi?.state === "running" ? undefined : rowStatus;
  const statusText = notice
    ? notice.state === "blocked" ? t("ui.blocked") : notice.state === "stopped" ? t("ui.stopped") : undefined
    : pi
      ? pi.state === "stopped" ? t("ui.stopped") : undefined
      : rowStatus === "failed" ? failureText(detail, item.data.errorText) : undefined;
  const vivid = palette.mode === "vivid";
  // 0.11.0:「命令着色」：shell 行的行头命令按语法色渲染（展开时或始终）。着色组件在 fx 懒加载块，
  // 下载到之前（或失败时）行头保持纯文本摘要——与运行中动画同一降级模式。只有真的需要着色才触发下载：
  // 默认配置（折叠 + 展开时着色）下，fx 不因工具行的存在而被下载。
  const commandColors = useCommandColors();
  const wantsColor = look === "shell" && !mcp && !notice && !pi && (commandColors === "always" || expanded);
  const CommandTokens = useFx(wantsColor)?.CommandTokens;
  const commandNode =
    wantsColor && headerSummary && CommandTokens ? (
      <CommandTokens text={headerSummary} theme={theme} />
    ) : null;
  return (
    <View ref={rootRef} {...pmonoViewEscape} style={[styles.card, isLiveTail ? styles.cardTail : null, quiet ? { opacity: STRENGTH_OPACITY[strength] } : null]}>
      {pin ? <PinnedPrompt agentId={agentId} pin={pin} theme={theme} mode={palette.mode} metrics={metrics} /> : null}
      <ActivityHeader
        icon={item.data.presentation.icon}
        iconColor={categoryColor}
        title={vividTitle}
        summary={vividSummary}
        summaryNode={commandNode}
        fileDisplay={headerFile ?? undefined}
        // 0.6.0-local.5 (codex-vivid-merge-F2): the other palettes leave out the same state marks as the vivid one.
        status={headerStatus === undefined ? undefined : item.data.status}
        statusColor={statusColor}
        stats={item.data.presentation.diffStats}
        expanded={expanded}
        onPress={toggle}
        onHover={setHovered}
        expandable={expandable}
        styles={styles}
        stamp={stamp}
        vivid={vivid ? { theme, compact: layout.compact, look, status: headerStatus, statusText, icon: notice || pi ? item.data.presentation.icon : item.data.presentation.fileIcon, metrics, timing: notice ? noticeTime : durationText } : undefined}
      />
      {operation && detail ? <PiSubagentLifecycleSummary toolName={item.data.name} input={undefined}
        output={detail.type === "sub_agent" ? detail.log : detail.type === "unknown" ? detail.output : undefined}
        theme={theme} palette={palette} styles={styles} /> : null}
      {hasDetails && subAgentDetail ? <SubAgentProgress detail={subAgentDetail} toolName={item.data.name} styles={styles} /> : null}
      {expandable && expanded ? (
        <View {...cmonoViewEscape} style={styles.details}>
          <ScrollView ref={detailScrollRef} style={styles.detailsScroll} contentContainerStyle={styles.detailsContent} nestedScrollEnabled showsVerticalScrollIndicator onScroll={onDetailScroll} onContentSizeChange={onDetailContentSizeChange} scrollEventThrottle={16}>
            {hasBody ? (
              <DetailBody data={item.data} agentId={agentId} theme={theme} palette={palette} styles={styles} follow={follow} />
            ) : null}
            {pi?.reader === "failed" ? <PiReaderRetry theme={theme} /> : null}
            {item.data.errorText && !(detail?.type === "shell" && !detail.output) ? (
              <View style={styles.section}>
                <Text style={styles.detailLabel}>{t("ui.error")}</Text>
                <Text selectable style={{ ...styles.detailText, color: palette.statusColors.failed }}>{stripAnsi(item.data.errorText)}</Text>
              </View>
            ) : null}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
