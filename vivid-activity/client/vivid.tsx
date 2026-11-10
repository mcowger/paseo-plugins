import { useI18n } from "./i18n-client";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, type ReactNode } from "react";
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { hue, isDarkTheme, withAlpha, type Hue } from "./kit";
import { looks, rowLabel, rowMotion, statusLooks, VIVID_CATEGORY_HUES, washAlpha, type LookKey, type RowStatus } from "../shared/vivid-model";
export { failureText, lookFor, mcpParts, zh, type LookKey, type RowStatus } from "../shared/vivid-model";
import { Breathe, Flash, Ping, Pop, Spin, Sweep, useChangeCount } from "./motion";
import type { ActivityPalette } from "../shared/presentation";
import { badgeInk, type Badge } from "../shared/brand";
import { useFx, useLoader } from "./fx";
import { typeset, useTypography } from "./typography";

/**
 * 本地补丁（vivid-activity）：鲜明配色 + 状态动效。上游行布局与详情视图不动，只替换行头与调色板。
 * 状态色固定：运行蓝、等你琥珀、失败红、完成绿、取消灰；工具类别色与 Agent 观测台一致（见 shared/vivid-model.ts）。
 */
export function statusColor(theme: PluginTheme, status: RowStatus, use: "solid" | "text" | "soft" | "line" = "solid"): string {
  const look = statusLooks[status];
  if (look.hue === "muted") return use === "soft" ? theme.colors.surface2 : theme.colors.foregroundMuted;
  return hue(theme, look.hue, use);
}

/** A vivid ActivityPalette for the upstream detail views (diff tints, category icons, status icons). */
export function resolveVividPalette(theme: PluginTheme): ActivityPalette {
  const dark = isDarkTheme(theme);
  const soft = (name: Hue) => withAlpha(hue(theme, name), dark ? 0.2 : 0.12);
  // 0.5.0: one table for both, so a category's tint always matches its icon (the sub-agent tint used to be green).
  const categories = Object.entries(VIVID_CATEGORY_HUES) as Array<[keyof typeof VIVID_CATEGORY_HUES, Hue | null]>;
  const categoryColors = Object.fromEntries(
    categories.map(([category, name]) => [category, name ? hue(theme, name) : theme.colors.foregroundMuted]),
  ) as ActivityPalette["categoryColors"];
  return {
    mode: "vivid",
    categoryColors,
    categoryBackgrounds: Object.fromEntries(
      categories.map(([category, name]) => [category, name ? soft(name) : theme.colors.surface2]),
    ) as ActivityPalette["categoryBackgrounds"],
    statusColors: { running: hue(theme, "blue"), completed: hue(theme, "green"), failed: hue(theme, "red"), canceled: theme.colors.foregroundMuted },
    statusBackgrounds: { running: soft("blue"), completed: soft("green"), failed: soft("red"), canceled: theme.colors.surface2 },
    borderWidth: 1,
  };
}

/** Ring with a turning arc (same drawing as the observatory's running mark). */
export function Spinner({ size, color }: { size: number; color: string }) {
  const ring = size - 2, stroke = size >= 14 ? 2 : 1.5;
  const circle: ViewStyle = { position: "absolute", width: ring, height: ring, borderRadius: ring / 2, borderWidth: stroke };
  return <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
    <View style={[circle, { borderColor: withAlpha(color, 0.28) }]} />
    <Spin size={ring}><View style={[circle, { borderColor: "transparent", borderTopColor: color, borderRightColor: color }]} /></Spin>
  </View>;
}

/**
 * 0.8.0: the running mark in the animation chosen in settings (「运行中动画」). The spinner by default; the others come
 * from the lazy fx chunk (client/fx.ts), and the spinner turns until it is here.
 */
export function RunningMark({ size, color }: { size: number; color: string }) {
  const kind = useLoader();
  return kind === "spinner" ? <Spinner size={size} color={color} /> : <LoaderMark kind={kind} size={size} color={color} />;
}

/**
 * 0.8.0: one running animation by name, from the fx chunk once it is here (the spinner until then). The settings preview
 * borrows it too (index.client.tsx passes it with the settings actions), so the ui chunk carries no copy of the loaders.
 */
export function LoaderMark({ kind, size, color }: { kind: string; size: number; color: string }) {
  const Loader = useFx()?.RunningLoader;
  return kind !== "spinner" && Loader ? <Loader kind={kind} size={size} color={color} /> : <Spinner size={size} color={color} />;
}

/** The status glyph at the end of a row: spinner, pinging hand, or a filled disk with a white mark. */
export function StatusMark({ theme, status, size: requested }: { theme: PluginTheme; status: RowStatus; size?: number }) {
  const size = requested ?? (status === "completed" ? 14 : 16);
  const color = statusColor(theme, status);
  const changes = useChangeCount(status);
  const motion = rowMotion({ status, statusChanges: changes, finishes: 0, live: false });
  const box: ViewStyle = { width: size, height: size, alignItems: "center", justifyContent: "center" };
  if (status === "running") return <View style={box}><RunningMark size={size} color={color} /></View>;
  if (status === "canceled") return <View style={box}><Icon name="CircleSlash2" size={size - 2} color={color} /></View>;
  const mark = <View style={box}>
    {motion.ping ? <Ping size={size} color={color} /> : null}
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, alignItems: "center", justifyContent: "center" }}>
      <Icon name={statusLooks[status].icon} size={Math.round(size * 0.62)} color="#ffffff" />
    </View>
  </View>;
  // Pop only after a change seen live: an idle mark registers no motion listeners.
  return motion.pop ? <Pop count={changes} size={size}>{mark}</Pop> : mark;
}

export function CategoryTile({ theme, look, size = 20, live = false, icon }: { theme: PluginTheme; look: LookKey; size?: number; live?: boolean; icon?: string }) {
  const meta = looks[look];
  const color = meta.hue === "gray" ? theme.colors.foregroundMuted : hue(theme, meta.hue);
  const tile = <View style={{ width: size, height: size, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(color.startsWith("#") ? color : "#888888", isDarkTheme(theme) ? 0.2 : 0.13) }}>
    <Icon name={icon ?? meta.icon} size={Math.round(size * 0.62)} color={color} />
  </View>;
  return live ? <Breathe>{tile}</Breathe> : tile;
}

/** 本地补丁：语言或工具的小色标（TS、PY、git、npm……），纯色块加字母，原生端也能画。 */
export function BrandChip({ badge }: { badge: Badge }) {
  return <View style={{ height: 16, minWidth: 16, paddingHorizontal: 4, borderRadius: 4, justifyContent: "center", alignItems: "center", backgroundColor: badge.color, flexShrink: 0 }}>
    <Text numberOfLines={1} style={{ color: badgeInk(badge), fontSize: 9.5, fontWeight: "800", letterSpacing: 0.2, lineHeight: 12 }}>{badge.label}</Text>
  </View>;
}

/** "+3 −2" as two tiny tinted pills. */
export function DiffPills({ theme, additions, deletions }: { theme: PluginTheme; additions: number; deletions: number }) {
  const pill = (text: string, name: Hue) => <View style={{ paddingHorizontal: 5, height: 18, borderRadius: 9, justifyContent: "center", backgroundColor: hue(theme, name, "soft") }}>
    <Text style={{ color: hue(theme, name, "text"), fontSize: 11, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{text}</Text>
  </View>;
  return <View style={{ flexDirection: "row", gap: 3, flexShrink: 0 }}>
    {additions > 0 ? pill(`+${additions}`, "green") : null}
    {deletions > 0 ? pill(`−${deletions}`, "red") : null}
  </View>;
}

const frameStyles = StyleSheet.create({
  // pointerEvents only works from StyleSheet.create on RN-web.
  edge: { position: "absolute", left: 0, top: 4, bottom: 4, width: 3, borderRadius: 2, pointerEvents: "none" },
  sweep: { position: "absolute", left: 8, right: 8, bottom: 0, pointerEvents: "none" },
});

/**
 * The tinted row frame: a coloured left edge and wash for live/attention states, a sweep while running,
 * and a one-off green flash when a row finishes while you watch.
 */
export function RowFrame({ theme, status, compact, children }: { theme: PluginTheme; status: RowStatus; compact: boolean; children: ReactNode }) {
  const wash = washAlpha(status, isDarkTheme(theme));
  const finishes = useChangeCount(status === "completed" ? "done" : status);
  const motion = rowMotion({ status, statusChanges: 0, finishes, live: false });
  const color = statusColor(theme, status);
  return <View style={{ borderRadius: 8, overflow: "hidden", backgroundColor: wash ? withAlpha(color, wash) : "transparent", paddingLeft: compact ? 6 : 8 }}>
    {wash ? <View style={[frameStyles.edge, { backgroundColor: color }]} /> : null}
    {children}
    {motion.sweep ? <View style={frameStyles.sweep}><Sweep color={color} track="transparent" height={2} /></View> : null}
    {motion.flash ? <Flash count={finishes} color={withAlpha(hue(theme, "green"), 0.22)} radius={8} /> : null}
  </View>;
}

/** Short state pill shown on wide layouts next to the glyph for states that need words. */
export function StatusPill({ theme, status, text }: { theme: PluginTheme; status: RowStatus; text?: string }) {
  useI18n();
  const color = statusColor(theme, status, "text");
  return <View style={{ height: 18, paddingHorizontal: 6, borderRadius: 9, justifyContent: "center", backgroundColor: statusColor(theme, status, "soft") }}>
    <Text numberOfLines={1} style={{ color, fontSize: 11, fontWeight: "700" }}>{text ?? statusLooks[status].label}</Text>
  </View>;
}

/** How much more readily the summary gives way than the title (flexShrink weights; Yoga and CSS weight them by size too). */
const GIVE_WAY = 1000;
/** A title longer than this (an unknown tool's own name) ends in an ellipsis even on a wide row, so the summary keeps room. */
const TITLE_MAX = 240;

export function useVividText(theme: PluginTheme, lineHeight = 18) {
  const type = useTypography();
  return useMemo(() => typeset({
    // 0.6.0-local.2 (codex-vivid-F3): title, summary and meta share the row's one area that gives way (VividHeader). The
    // summary gives way first (GIVE_WAY), then the meta, the title last: 「命令」 keeps its words while a summary is left.
    // A long title (an unknown tool's own name) still stops at half of that area. Native Text does not shrink by default.
    label: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600", lineHeight, flexShrink: 1, minWidth: 0, maxWidth: TITLE_MAX } satisfies TextStyle,
    summary: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight, fontFamily: "monospace", flexShrink: GIVE_WAY, minWidth: 0 } satisfies TextStyle,
    fileDir: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight, fontFamily: "monospace", flexShrink: 1 } satisfies TextStyle,
    // The directory gives way first; a file name longer than the room left ends in an ellipsis instead of overflowing.
    fileBase: { color: theme.colors.foreground, fontSize: 12, lineHeight, fontFamily: "monospace", fontWeight: "600", flexShrink: 0, maxWidth: "100%" } satisfies TextStyle,
    // Proportional: 「2 步 · 约 22 token」 reads oddly spaced in a monospace face. Timing beside the status keeps its width.
    meta: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight, flexShrink: 0, fontVariant: ["tabular-nums"] } satisfies TextStyle,
    // The meta after a summary gives way after the summary and before the title.
    metaText: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight, flexShrink: 30, minWidth: 0, fontVariant: ["tabular-nums"] } satisfies TextStyle,
  }, type), [lineHeight, theme, type]);
}

export interface VividHeaderProps {
  theme: PluginTheme;
  compact: boolean;
  look: LookKey;
  title: string;
  summary?: string;
  /** 0.11.0:「命令着色」：摘要的语法色段（shell 行）。给出时优先于纯文本 summary 渲染。 */
  summaryNode?: ReactNode;
  fileDisplay?: { dir?: string; base: string };
  status?: RowStatus;
  /** Words for the state pill on wide layouts, e.g. 「退出码 1」. */
  statusText?: string;
  stats?: { additions: number; deletions: number };
  meta?: string;
  live?: boolean;
  /** File-type icon for file rows (upstream's extension map), drawn in the category colour. */
  icon?: string;
  /** 本地补丁：行密度（client/density.ts）。缺省为标准。 */
  metrics?: { rowMinHeight: number; rowPaddingVertical: number; tile: number; gap: number; lineHeight: number };
  /** 本地补丁：耗时（「4.2 秒」），运行中为实时计时。 */
  timing?: string | null;
  stamp?: string | null;
  expanded: boolean;
  expandable: boolean;
  chevronColor: string;
  onPress: () => void;
  /** Rendered by the caller so the Pressable stays the only button in the row. */
  Pressable: (props: { children: ReactNode; style: ViewStyle; onPress: () => void; label: string; expanded: boolean; disabled: boolean }) => ReactNode;
  dirText: (dir: string) => string;
}

/** One compact, coloured activity row: tile · 中文动作 · 摘要 · 改动 · 状态 · 展开. */
export function VividHeader(props: VividHeaderProps) {
  useI18n();
  const { theme, compact, look, title, summary, summaryNode, fileDisplay, status, statusText, stats, meta, live, icon, expanded, expandable, chevronColor, onPress, metrics, timing, stamp } = props;
  const text = useVividText(theme, metrics?.lineHeight ?? 18);
  // Attention states get words on phones too (「等你批准」「退出码 1」); quieter states only on wide layouts.
  const showPill = status === "waiting" || status === "question" || status === "failed" || (!compact && (status === "canceled" || (status === "running" && !!statusText)));
  const gap = metrics?.gap ?? (compact ? 6 : 8);
  const row = (
    <>
      <CategoryTile theme={theme} look={look} live={live} icon={icon} size={metrics?.tile ?? 20} />
      {/* 0.6.0-local.2 (codex-vivid-F3): the words share one area that takes the room left and gives way; the pills, timing,
          state mark and chevron after it keep their width, so a narrow phone row never pushes them out of the card. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={text.label}>{title}</Text>
        {summaryNode ? <Text numberOfLines={1} style={text.summary}>{summaryNode}</Text> : fileDisplay ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexShrink: GIVE_WAY, minWidth: 0 }}>
            {fileDisplay.dir ? <Text numberOfLines={1} style={text.fileDir}>{props.dirText(fileDisplay.dir)}/</Text> : null}
            <Text numberOfLines={1} style={text.fileBase}>{fileDisplay.base}</Text>
          </View>
        ) : summary ? <Text numberOfLines={1} style={text.summary}>{summary}</Text> : null}
        {meta ? <Text numberOfLines={1} style={text.metaText}>{meta}</Text> : null}
      </View>
      {stats && (stats.additions > 0 || stats.deletions > 0) ? <DiffPills theme={theme} additions={stats.additions} deletions={stats.deletions} /> : null}
      {showPill && status ? <StatusPill theme={theme} status={status} text={statusText} /> : null}
      {timing ? (
        <Text numberOfLines={1} style={status === "running" ? { ...text.meta, color: statusColor(theme, "running", "text") } : text.meta}>{timing}</Text>
      ) : null}
      {status ? <StatusMark theme={theme} status={status} /> : null}
      {stamp ? <Text numberOfLines={1} style={text.meta}>{stamp}</Text> : null}
      <Icon name={expandable ? (expanded ? "ChevronDown" : "ChevronRight") : "ChevronRight"} size={12} color={expandable ? chevronColor : "transparent"} />
    </>
  );
  const style: ViewStyle = {
    flexDirection: "row", alignItems: "center", gap, minHeight: metrics?.rowMinHeight ?? (compact ? 32 : 30),
    paddingRight: 6, paddingVertical: metrics?.rowPaddingVertical ?? 3, minWidth: 0,
  };
  return <RowFrame theme={theme} status={status ?? (live ? "running" : "completed")} compact={compact}>
    {props.Pressable({ children: row, style, onPress, label: rowLabel({ expanded, title, summary, fileDisplay, status }), expanded, disabled: !expandable })}
  </RowFrame>;
}
