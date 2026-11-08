import { useI18n } from "./i18n-client";
import { t } from "../shared/text";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useAgent, useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { DiffBlocks, Glyph } from "./diffstat";
import { useFx } from "./fx";
import { foldAccessibilityLabel, foldCountParts, foldTitle, formatFoldDuration } from "../shared/fold";
import { activitySettings } from "../shared/settings";
import { formatTurnTime } from "../shared/turn-time";
import type { WireTurnTokens } from "../shared/fold-index";
import type { FoldItemData } from "../shared/timeline";
import { looks, type LookKey, type RowStatus } from "../shared/vivid-model";
import { usePalette, useStrength } from "./activity";
import { STRENGTH_OPACITY } from "../shared/settings";
import { densityMetrics, useDensity, useFoldRow } from "./density";
import { foldRuntime } from "./fold-runtime";
import { aria, compactNumber, hue, isDarkTheme, withAlpha, type Hue } from "./kit";
import { Breathe, Flash, Pop, useChangeCount } from "./motion";
import { PinnedPrompt, usePromptPin } from "./prompt-pin";
import { finishedToolItem } from "./transform";
import { StatusMark, StatusPill } from "./vivid";
import { cuiTextEscape, pmonoViewEscape } from "./web";

type Theme = PluginTimelineItemProps["theme"];

/** Text colour of a look's count under the chosen palette. */
function countColor(theme: Theme, mode: string, look: LookKey): string {
  if (mode === "soft") return theme.colors.foregroundMuted;
  if (mode === "theme") return theme.colors.accent;
  const name = looks[look].hue;
  return name === "gray" ? theme.colors.foregroundMuted : hue(theme, name, "text");
}

function barColor(theme: Theme, mode: string, look: LookKey): string {
  if (mode === "soft") return withAlpha(theme.colors.foregroundMuted.startsWith("#") ? theme.colors.foregroundMuted : "#888888", 0.5);
  if (mode === "theme") return theme.colors.accent;
  const name = looks[look].hue;
  return name === "gray" ? theme.colors.foregroundMuted : hue(theme, name);
}

/** A stack of rows: the tile says what kind of summary this is (finished, failed, or the earlier steps of a live run). */
function FoldTile({ theme, tone, size, pulse }: { theme: Theme; tone: "green" | "red" | "blue" | "muted"; size: number; pulse: number }) {
  const color = tone === "muted" ? theme.colors.foregroundMuted : hue(theme, tone);
  const tile = (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: withAlpha(color.startsWith("#") ? color : "#888888", isDarkTheme(theme) ? 0.2 : 0.13),
      }}
    >
      <Icon name="Layers" size={Math.round(size * 0.62)} color={color} />
    </View>
  );
  return pulse > 0 ? <Pop count={pulse} size={size}>{tile}</Pop> : tile;
}

/** Proportional strip of the counted looks (wide layouts only; phones read the counts). */
function LookBar({ theme, mode, parts }: { theme: Theme; mode: string; parts: ReadonlyArray<readonly [LookKey, number]> }) {
  return (
    <View style={{ flexDirection: "row", width: 44, height: 6, borderRadius: 3, overflow: "hidden", gap: 1, flexShrink: 0 }}>
      {parts.map(([look, n]) => (
        <View key={look} style={{ flexGrow: n, flexShrink: 1, backgroundColor: barColor(theme, mode, look) }} />
      ))}
    </View>
  );
}

/**
 * 0.8.0: 「3 个文件 +12 −4 ▮▮▮▮▯」 at the end of a summary; phones leave out the file count (it is in the label and the
 * list). Changes whose lines are not known are said apart, never added in: 「另 1 处未计」, or 「1 处改动未计行数」 alone.
 */
export function ChangeStat({ theme, files, added, removed, uncounted = 0, compact, lineHeight }: { theme: Theme; files: number; added: number; removed: number; uncounted?: number; compact: boolean; lineHeight: number }) {
  const number: TextStyle = { fontSize: 12, lineHeight, fontWeight: "700", fontVariant: ["tabular-nums"] };
  const muted: TextStyle = { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
      {files > 0 && !compact ? <Text {...cuiTextEscape} numberOfLines={1} style={muted}>{t("fold.files", { count: files })}</Text> : null}
      {files > 0 && added > 0 ? <Text style={[number, { color: hue(theme, "green", "text") }]}>+{added}</Text> : null}
      {files > 0 && removed > 0 ? <Text style={[number, { color: hue(theme, "red", "text") }]}>−{removed}</Text> : null}
      {files > 0 ? <DiffBlocks theme={theme} added={added} removed={removed} /> : null}
      {uncounted > 0 ? <Text {...cuiTextEscape} numberOfLines={1} style={muted}>{t(files > 0 ? "fold.uncountedMore" : "fold.uncountedOnly", { count: uncounted })}</Text> : null}
    </View>
  );
}

/** 0.8.0: tokens of a turn the plugin server watched live (server/turn-usage.ts); null until known. */
function useTurnTokens(agentId: string, turn: string | null): WireTurnTokens | null {
  const subscribe = useCallback((listener: () => void) => foldRuntime.subscribeTokens(agentId, listener), [agentId]);
  const read = useCallback(() => (turn ? foldRuntime.turnTokens(agentId, turn) : null), [agentId, turn]);
  return useSyncExternalStore(subscribe, read, read);
}

/** 0.8.0: 「本轮 输入 12.3k · 缓存 80.1k · 输出 2.4k」 under the last summary of a turn; the coin breathes while the sum still grows. */
export function TurnTokens({ theme, tokens, indent }: { theme: Theme; tokens: WireTurnTokens; indent: number }) {
  const parts: Array<{ name: Hue; id: "fold.tokensIn" | "fold.tokensCached" | "fold.tokensOut"; count: number }> = [
    { name: "blue", id: "fold.tokensIn", count: tokens.i },
    ...(tokens.c !== null ? [{ name: "teal" as const, id: "fold.tokensCached" as const, count: tokens.c }] : []),
    { name: "violet", id: "fold.tokensOut", count: tokens.o },
  ];
  const separator = t("fold.extrasSeparator");
  const label = t("fold.turn") + t("fold.countsSuffix", { counts: parts.map((part) => t(part.id, { count: part.count.toLocaleString() })).join(separator) });
  const coin = <Glyph name="Coins" color={hue(theme, "amber")} />;
  return (
    <View accessible accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingLeft: indent, paddingRight: 6, paddingBottom: 2, minWidth: 0 }}>
      {tokens.live ? <Breathe>{coin}</Breathe> : coin}
      <Text {...cuiTextEscape} numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15, flexShrink: 1, minWidth: 0 }}>
        {t("fold.turn")}
        {parts.map((part, index) => (
          <Text key={part.id}>
            {index > 0 ? t("ui.metaSeparator") : "  "}
            <Text style={{ color: hue(theme, part.name, "text"), fontWeight: "700", fontVariant: ["tabular-nums"] }}>{t(part.id, { count: compactNumber(part.count) })}</Text>
          </Text>
        ))}
      </Text>
    </View>
  );
}

/**
 * 0.8.0: an expanded summary lists the files with their +/− and the failed commands with their exit code. The list lives
 * in the lazy fx chunk (client/fold-changes.tsx) and reads the names from the rows this app drew (the index carries no
 * paths or commands); nothing shows until the chunk is here.
 */
function FoldChangeList({ agentId, theme, data, lineHeight, indent }: { agentId: string; theme: Theme; data: FoldItemData; lineHeight: number; indent: number }) {
  const cwd = useAgent(agentId, (agent) => agent.cwd) ?? null;
  const ChangesView = useFx()?.FoldChanges;
  if (!ChangesView) return null;
  return <ChangesView theme={theme} lineHeight={lineHeight} indent={indent} cwd={cwd} files={data.files ?? 0} uncounted={data.uncounted ?? 0} changed={data.changed ?? []} fails={data.fails ?? []} item={finishedToolItem} />;
}

/**
 * 本地补丁：折叠摘要行。已结束的段：「12 步 · 思考 2 · 命令 5 · 读取 3 · 编辑 2 … 失败 1 · 1 分 20 秒 ✓ ›」；
 * 运行中的段：「前面 7 步 …」。点一下展开整段（Paseo 重新投影，被折叠的行回来），再点收起；选择在本次会话里记住。
 */
export function FoldRow({ agentId, item, theme, layout, timestamp }: PluginTimelineItemProps<FoldItemData>) {
  useI18n();
  const data = item.data;
  useFoldRow(agentId, undefined, undefined, timestamp);
  const palette = usePalette(theme);
  const metrics = densityMetrics(useDensity(), layout.compact, layout.platform !== "web");
  const done = data.mode === "done";
  const status: RowStatus = data.failed > 0 ? "failed" : data.canceled > 0 && data.canceled === data.steps ? "canceled" : "completed";
  const tone = !done ? "blue" : status === "failed" ? "red" : status === "canceled" ? "muted" : "green";
  // A live run that just finished folds into this row: flash once, pop the tile.
  const changes = useChangeCount(data.mode);
  const parts = foldCountParts(data.counts);
  const bar = useMemo(() => parts.map((part) => [part.look, data.counts.find(([look]) => look === part.look)?.[1] ?? 0] as const), [data.counts, parts]);
  const duration = done ? formatFoldDuration(data.durationMs) : null;
  const settings = useSettings(activitySettings);
  const endedAt = settings.status === "ready" && settings.values.foldTime && done ? formatTurnTime(data.endedAt ?? 0) : "";
  const toggle = useCallback(() => foldRuntime.toggle(agentId, data.segment, !data.expanded), [agentId, data.expanded, data.segment]);
  // 0.6.0 (grok-B2): the question of this turn, when this summary stands for the newest stretch of activity.
  const pin = usePromptPin(agentId, { segment: data.segment });
  // 0.8.0: the turn's tokens on its last summary.
  const tokens = useTurnTokens(agentId, data.lastOfTurn && data.turn ? data.turn : null);
  const files = data.files ?? 0;
  const uncounted = data.uncounted ?? 0;
  const [hovered, setHovered] = useState(false);
  const strength = useStrength();
  // 「淡出强度」：已结束的折叠摘要同样退后，展开、悬停/聚焦恢复；运行中的段头（「前面 N 步」）保持全强度。
  const quiet = strength !== "full" && done && !data.expanded && !hovered;

  const text = useMemo(
    () => ({
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "700", lineHeight: metrics.lineHeight, flexShrink: 0 } satisfies TextStyle,
      counts: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: metrics.lineHeight, flexShrink: 1, minWidth: 0 } satisfies TextStyle,
      meta: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: metrics.lineHeight, flexShrink: 0, fontVariant: ["tabular-nums"] } satisfies TextStyle,
    }),
    [metrics.lineHeight, theme],
  );
  const card: ViewStyle = { marginHorizontal: 0, marginTop: metrics.marginTop, marginBottom: metrics.marginBottom };
  const row: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: metrics.gap,
    minHeight: metrics.rowMinHeight,
    paddingVertical: metrics.rowPaddingVertical,
    paddingLeft: layout.compact ? 6 : 8,
    paddingRight: 6,
    minWidth: 0,
    borderRadius: 8,
    overflow: "hidden",
    // Expanded: a faint band marks the header of the rows below it.
    backgroundColor: data.expanded ? withAlpha(hue(theme, done ? (status === "failed" ? "red" : "green") : "blue"), isDarkTheme(theme) ? 0.1 : 0.07) : "transparent",
  };
  const label = foldAccessibilityLabel(data);
  // The tokens line and the change list line up with the title, after the tile.
  const indent = (layout.compact ? 6 : 8) + metrics.tile + metrics.gap;

  return (
    <View {...pmonoViewEscape} style={[card, quiet ? { opacity: STRENGTH_OPACITY[strength] } : null]}>
      {pin ? <PinnedPrompt agentId={agentId} pin={pin} theme={theme} mode={palette.mode} metrics={metrics} /> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={label} {...aria({ expanded: data.expanded })} onPress={toggle} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onFocus={() => setHovered(true)} onBlur={() => setHovered(false)} style={row}>
        <FoldTile theme={theme} tone={tone} size={metrics.tile} pulse={changes} />
        <Text {...cuiTextEscape} numberOfLines={1} style={text.title}>{foldTitle(data)}</Text>
        {!layout.compact && bar.length > 0 ? <LookBar theme={theme} mode={palette.mode} parts={bar} /> : null}
        <Text {...cuiTextEscape} numberOfLines={1} style={text.counts}>
          {parts.map((part, index) => (
            <Text key={part.look}>
              {index > 0 ? t("ui.metaSeparator") : ""}
              <Text style={{ color: countColor(theme, palette.mode, part.look), fontWeight: "600" }}>{part.text}</Text>
            </Text>
          ))}
        </Text>
        <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 2 }} />
        {files > 0 || uncounted > 0 ? <ChangeStat theme={theme} files={files} added={data.added ?? 0} removed={data.removed ?? 0} uncounted={uncounted} compact={layout.compact} lineHeight={metrics.lineHeight} /> : null}
        {data.failed > 0 ? <StatusPill theme={theme} status="failed" text={t("ui.failed2", { count: data.failed })} /> : null}
        {duration ? <Text {...cuiTextEscape} numberOfLines={1} style={text.meta}>{duration}</Text> : null}
        {done ? <StatusMark theme={theme} status={status} size={14} /> : null}
        {endedAt ? <Text {...cuiTextEscape} numberOfLines={1} style={text.meta}>{endedAt}</Text> : null}
        <Icon name={data.expanded ? "ChevronDown" : "ChevronRight"} size={12} color={theme.colors.foregroundMuted} />
        {changes > 0 && done ? <Flash count={changes} color={withAlpha(hue(theme, status === "failed" ? "red" : "green"), 0.22)} radius={8} /> : null}
      </Pressable>
      {tokens ? <TurnTokens theme={theme} tokens={tokens} indent={indent} /> : null}
      {data.expanded && (files > 0 || uncounted > 0 || (data.fails?.length ?? 0) > 0) ? <FoldChangeList agentId={agentId} theme={theme} data={data} lineHeight={metrics.lineHeight} indent={indent} /> : null}
    </View>
  );
}
