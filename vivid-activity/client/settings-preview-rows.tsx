import type { PluginTheme } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { ScrollView, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { STRENGTH_OPACITY, activitySettings, type LoaderKind, type PaletteMode } from "../shared/settings";
import { PIN_COLLAPSED_LINES } from "../shared/prompt-pin";
import { densityMetrics, type DensityMetrics } from "../shared/density";
import { looks, type LookKey } from "../shared/vivid-model";
import type { ActivityPalette } from "../shared/presentation";
import { buildActivityStyles, type ActivityStyles } from "./activity-styles";
import { DiffBlock, ReasoningMarkdown } from "./activity-details";
import { hue, isDarkTheme, vividSyntaxColors, withAlpha } from "./kit";
import { emphasizeShellHead, highlightCodeSync, type HighlightToken } from "./highlight";
import type { SettingsActions } from "./settings";
import { typesetStyle, useTypography } from "./typography";
import { t } from "../shared/text";

/**
 * 0.11.0：设置页右侧的全量实时预览——一段模拟回合的高保真静态副本（展示态固定并标注，不可交互）。
 * 结构镜像真实行头（tile/动词/计数/状态丸/时长/勾叉/chevron），样式全部来自 buildActivityStyles
 * （与真实行同一构建器，零漂移由构造保证）；淡出豁免谓词与真实行同构（运行中不淡；展开不淡；
 * 失败行同样淡出——failures 档只让它初始展开；折叠摘要跟随档位、含失败自动展开为全强度）。
 * 样本结构是行组件的轻量副本，不引用常驻行组件（fold-runtime/prompt-pin/attention 的状态不得
 * 被假 agent 污染）。命令着色（Prism，fx chunk）在预览内：命令段、运行中行的着色跟随与真实行
 * 同一规则（always，或 shell 展开为 always/latest）；fx 改动清单（fold-changes）仍以纯文本示意。
 */

type Typography = ReturnType<typeof useTypography>;

export interface PreviewPanelProps {
  theme: PluginTheme;
  paletteFor: (theme: PluginTheme, mode: PaletteMode) => ActivityPalette;
  actions: SettingsActions;
  compact: boolean;
  /** 宿主表面平台（layout.platform !== "web"）——密度指标的 native 分支与真实行同参。 */
  native?: boolean;
}

const SAMPLE_COMMAND = 'echo "$(git rev-parse --short HEAD)" && npm ci --omit=dev || true # smoke';
// 第二个样本：heredoc（青绿）、boolean（青柠）、flag（靛）与斜体注释挤在一行短命令里，
// 让「命令着色」的全部新增语法在预览里一屏可见（第一个样本展示子壳嵌套，太长会被截断）。
const SAMPLE_HEREDOC_COMMAND = 'cat <<CFG && npm ci --omit=dev || true # demo';
const SAMPLE_QUESTION = () => t("settings.previewQuestion");
const reasoningSample = () => t("settings.previewReasoning").split("\n");

interface PreviewValues {
  strength: "dim" | "faded" | "soft" | "full";
  thoughtExpansion?: "always" | "latest" | "never" | "failures";
  tailFollow?: boolean;
  tailLines?: number;
  fold?: boolean;
}

function Dot({ color, size = 12 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

/** 类别 tile：淡色调底 + lucide 图标（镜像真实行的 CategoryTile）。 */
function Tile({ theme, look, size }: { theme: PluginTheme; look: LookKey; size: number }) {
  const meta = looks[look];
  const color = meta.hue === "gray" ? theme.colors.foregroundMuted : hue(theme, meta.hue);
  return (
    <View style={{ width: size, height: size, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(color.startsWith("#") ? color : "#888888", isDarkTheme(theme) ? 0.2 : 0.13) }}>
      <Icon name={meta.icon} size={Math.round(size * 0.62)} color={color} />
    </View>
  );
}

/** 软色状态丸（镜像真实行的 StatusPill）。 */
function Pill({ color, soft, text }: { color: string; soft: string; text: string }) {
  return (
    <View style={{ height: 18, paddingHorizontal: 6, borderRadius: 9, justifyContent: "center", backgroundColor: soft, flexShrink: 0 }}>
      <Text numberOfLines={1} style={{ color, fontSize: 11, fontWeight: "700" }}>{text}</Text>
    </View>
  );
}

/** 行头命令的语法色段（真 Prism bash 语法；vivid 派生 12 色 + 首词粗体/注释斜体；整行一色或超长时返回 null 走纯文本）。 */
function shellSegments(command: string, theme: PluginTheme): ReactNode | null {
  const lines = highlightCodeSync(command, "shell", vividSyntaxColors(theme));
  const line = lines && emphasizeShellHead(lines)?.[0];
  if (!line || line.length <= 1) return null;
  return (
    <>
      {line.map((token, index) => (
        <Text key={index} style={shellTokenStyle(token)}>{token.content}</Text>
      ))}
    </>
  );
}

/** 0.11.0:与 fx 真实行同构的 token 样式（颜色 + 1 斜体 / 2 粗体）。 */
function shellTokenStyle(token: HighlightToken) {
  if (!token.color && !token.fontStyle) return null;
  return {
    ...(token.color ? { color: token.color } : null),
    ...(token.fontStyle && token.fontStyle & 1 ? { fontStyle: "italic" as const } : null),
    ...(token.fontStyle && token.fontStyle & 2 ? { fontWeight: "700" as const } : null),
  };
}

function RowText({ style, children }: { style: TextStyle; children: string }) {
  return <Text numberOfLines={1} style={style}>{children}</Text>;
}

/** 迷你行头：类别色点 + 动作词（可带语法色段）+ 命令/摘要 + 右侧注记。 */
function MiniHeader({ theme, styles, dotColor, title, summary, summaryNode, right }: { theme: PluginTheme; styles: ActivityStyles; dotColor: string; title: string; summary?: string; summaryNode?: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.headerButton}>
      <Dot color={dotColor} />
      <RowText style={styles.title}>{title}</RowText>
      {summaryNode ? <Text numberOfLines={1} style={styles.summary}>{summaryNode}</Text> : summary ? <RowText style={styles.summary}>{summary}</RowText> : null}
      {right ?? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 0 }}>›</Text>}
    </View>
  );
}

/** 淡出豁免谓词的预览版：与 client/activity.tsx、fold-row.tsx 的真实规则同构。运行中不淡；展开不淡；
 * 失败行同样淡出（failures 档只让它初始展开——经 expanded 豁免，与真实点击收起后的行为一致）。 */
function idleOpacity(values: PreviewValues, opts: { expanded?: boolean } = {}): number | null {
  if (values.strength === "full") return null;
  if (opts.expanded) return null;
  return STRENGTH_OPACITY[values.strength];
}

function card(children: ReactNode, opacity: number | null, styles: ActivityStyles): ReactNode {
  return <View style={[styles.card, opacity != null ? { opacity } : null]}>{children}</View>;
}

/** 思考行副本：always/latest 展开正文（跟随模式取尾窗 N 行，否则头 20 行）；failures/never 收起并淡出（与真实行为一致）。 */
function ReasoningReplica({ theme, styles, values, palette, metrics }: { theme: PluginTheme; styles: ActivityStyles; values: PreviewValues; palette: ActivityPalette; metrics: DensityMetrics }) {
  const mode = values.thoughtExpansion ?? "latest";
  const expanded = mode === "always" || mode === "latest";
  const opacity = values.strength === "full" || expanded ? null : STRENGTH_OPACITY[values.strength];
  const lines = reasoningSample();
  const body = values.tailFollow
    ? lines.slice(Math.max(0, lines.length - (values.tailLines ?? 20))).join("\n")
    : lines.slice(0, 20).join("\n");
  const tag = values.tailFollow ? `${t("settings.previewWindow")} ${values.tailLines ?? 20}` : t("settings.previewHead20");
  return card(
    <>
      <View style={styles.headerButton}>
        <Tile theme={theme} look="think" size={metrics.tile} />
        <RowText style={{ ...styles.title, color: hue(theme, "violet", "text") }}>{t("modelLook.think")}</RowText>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginLeft: "auto", flexShrink: 0 }}>{expanded ? tag : "…"}</Text>
      </View>
      {expanded ? (
        <View style={styles.details}>
          <ReasoningMarkdown text={body} theme={theme} styles={styles} />
        </View>
      ) : null}
    </>,
    opacity,
    styles,
  );
}

/** 工具行副本：state/expanded 驱动（failures 档 = 失败行展开全强度红态，完成行收起淡出）。 */
function ToolReplica({ theme, styles, palette, values, metrics, look, label, command, commandNode, state, expanded, diff, errorLine, expandedBody, chip }: {
  theme: PluginTheme;
  styles: ActivityStyles;
  palette: ActivityPalette;
  values: PreviewValues;
  metrics: DensityMetrics;
  look: LookKey;
  label: string;
  command: string;
  /** 0.11.0:「命令着色」——命令的语法色段（给出时替代纯文本摘要）。 */
  commandNode?: ReactNode;
  state: "completed" | "failed" | "running";
  expanded?: boolean;
  diff?: ReactNode;
  errorLine?: ReactNode;
  /** 0.11.0:「长行折行/跟随」演示——展开区里的附加内容行（长输出等）。 */
  expandedBody?: ReactNode;
  /** 0.11.0:「跟随最新输出」的静态标注徽标（运行中行）。 */
  chip?: ReactNode;
}) {
  const running = state === "running";
  const open = expanded === true;
  const opacity = running ? null : idleOpacity(values, { expanded: open });
  const meta = looks[look];
  const color = meta.hue === "gray" ? theme.colors.foregroundMuted : hue(theme, meta.hue);
  return card(
    <>
      <View style={styles.headerButton}>
        <Tile theme={theme} look={look} size={metrics.tile} />
        <RowText style={{ ...styles.title, color }}>{label}</RowText>
        {commandNode ? <Text numberOfLines={1} style={styles.summary}>{commandNode}</Text> : <RowText style={styles.summary}>{command}</RowText>}
        {state === "failed" ? <Pill color={hue(theme, "red", "text")} soft={hue(theme, "red", "soft")} text={t("ui.failed2", { count: 1 })} /> : null}
        {chip}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 0 }}>{running ? "…" : "›"}</Text>
      </View>
      {open && errorLine ? <View style={styles.details}>{errorLine}</View> : null}
      {open && diff ? <View style={styles.details}>{diff}</View> : null}
      {open && expandedBody ? <View style={styles.details}>{expandedBody}</View> : null}
    </>,
    opacity,
    styles,
  );
}

/** 折叠摘要副本：done 段（绿 tile/勾/时长），跟随淡出档位；含失败 → 自动展开明细（全强度）。
 * 明细字号走 typeset（与真实 FoldChangeList 的 mono 同基，随字号/行距缩放）。 */
function FoldReplica({ theme, styles, values, palette, metrics, failed, type, wrapOutput }: { theme: PluginTheme; styles: ActivityStyles; values: PreviewValues; palette: ActivityPalette; metrics: DensityMetrics; failed: boolean; type: Typography; wrapOutput?: boolean }) {
  if (!values.fold) return null;
  const expanded = failed;
  const opacity = values.strength === "full" || expanded ? null : STRENGTH_OPACITY[values.strength];
  const green = hue(theme, "green");
  const noteStyle = typesetStyle<TextStyle>({ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 12, lineHeight: 16 }, type);
  // 失败命令行随「长行折行·命令行与输出」折/省略（与真实 FoldChangeList 同规则）。
  const failedStyle = typesetStyle<TextStyle>({ color: hue(theme, "red", "text"), fontFamily: "monospace", fontSize: 11, lineHeight: 16, fontWeight: "700", ...(wrapOutput ? { flexShrink: 1 } : null) }, type);
  return card(
    <>
      <View style={styles.headerButton}>
        <View style={{ width: metrics.tile, height: metrics.tile, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(green, isDarkTheme(theme) ? 0.2 : 0.13) }}>
          <Icon name="Check" size={Math.round(metrics.tile * 0.62)} color={hue(theme, "green", "text")} />
        </View>
        <RowText style={{ ...styles.title, color: theme.colors.foreground }}>{t("settings.previewFoldTitle")}</RowText>
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16, flexShrink: 1, minWidth: 0 }}>{t("settings.previewFoldCounts")}</Text>
        <Pill color={hue(theme, "red", "text")} soft={hue(theme, "red", "soft")} text={t("ui.failed2", { count: 1 })} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"], flexShrink: 0 }}>38 s</Text>
        <Text style={{ color: hue(theme, "green", "text"), fontSize: 12, flexShrink: 0 }}>✓</Text>
      </View>
      {expanded ? (
        <View style={styles.details}>
          <Text style={noteStyle}>{t("settings.previewFoldAuto")}</Text>
          <Text numberOfLines={wrapOutput ? undefined : 1} style={failedStyle}>npm ci --omit=dev && npm run lint && npm test -- --watch=false && npm run build && pnpm -r --filter @app/web e2e --headed — Exit code 1</Text>
        </View>
      ) : null}
    </>,
    opacity,
    styles,
  );
}

function LoaderMarkNode(mark: SettingsActions["LoaderMark"], loader: LoaderKind, color: string, theme: PluginTheme): ReactNode {
  if (!mark) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingLeft: 5 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>…</Text>
      </View>
    );
  }
  const Mark = mark;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingLeft: 5 }}>
      <Mark kind={loader} size={16} color={color} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>npm ci --omit=dev</Text>
    </View>
  );
}

function TokensReplica({ theme, indent }: { theme: PluginTheme; indent: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingLeft: indent, paddingRight: 6, paddingBottom: 2, minWidth: 0 }}>
      <Dot color={hue(theme, "amber")} size={10} />
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15, flexShrink: 1, minWidth: 0 }}>
        {t("settings.previewTokens")}
      </Text>
    </View>
  );
}

function PanelLabel({ theme, children }: { theme: PluginTheme; children: string }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, letterSpacing: 0.5 }}>{children.toUpperCase()}</Text>;
}

/** 0.11.0:「跟随最新输出」状态行的域清单（预览跟随徽标与设置矩阵共用同一判定）。 */
export function followStatusDomains(values: { followOutput?: Record<string, boolean> }): Array<{ area: string; label: string; on: boolean }> {
  return [
    { area: "shell", label: t("settings.followShell"), on: values.followOutput?.shell ?? true },
    { area: "logs", label: t("settings.followLogs"), on: values.followOutput?.logs ?? true },
    { area: "todo", label: t("settings.followTodo"), on: values.followOutput?.todo ?? true },
    { area: "browser", label: t("settings.followBrowser"), on: values.followOutput?.browser ?? true },
  ];
}

export function PreviewPanel({ theme, paletteFor, actions, compact, native }: PreviewPanelProps) {
  const settings = useSettings(activitySettings);
  const type = useTypography();
  const ready = settings.status === "ready";
  const values = ready ? settings.values : null;
  const metrics = densityMetrics(values?.density ?? "compact", compact, native ?? false);
  if (!ready || !values) {
    return (
      <View style={{ gap: 6 }}>
        <PanelLabel theme={theme}>{t("settings.preview")}</PanelLabel>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{t("settings.readingSettings")}</Text>
      </View>
    );
  }
  if (values.takeover === "off") {
    return (
      <View style={{ gap: 6 }}>
        <PanelLabel theme={theme}>{t("settings.preview")}</PanelLabel>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{t("settings.previewTakeoverOff")}</Text>
      </View>
    );
  }
  const palette = paletteFor(theme, values.palette);
  const styles = buildActivityStyles(theme, palette, metrics, type);
  // buildActivityStyles 的 card 外边距是负值（真实聊天里抵消 Paseo 列表的 16px 行距）；预览容器没有
  // 这份行距可抵消，负值会让样本行互相叠压——钳为固定正间距。
  styles.card = { ...styles.card, marginTop: 6, marginBottom: 6 };
  const failuresMode = values.expansion.shell === "failures";
  const shellAlways = values.expansion.shell === "always";
  const colored = values.commandColors === "always" || (failuresMode && values.commandColors === "expanded");
  const wrapCode = values.wrapLines?.code ?? false;
  const wrapOutput = values.wrapLines?.output ?? false;
  const followShell = values.followOutput?.shell ?? true;
  // 「长行折行」演示：样本约两倍面板宽，开=有界折行（明显多行），关=真实单行横滚（与 DetailBody 同构），
  // 差异在任何面板宽度下都一目了然。
  const longCode = "export function renderApp(root: HTMLElement) { mount(<Application theme={theme} routes={routes} store={store} middlewares={[logger, router]} />, root); } // app bootstrap entry point";
  const longOutput = "error: command failed after 3 retries — ELIFECYCLE Command failed with exit code 1 in ./packages/vivid-activity (webpack compile step overflow) at runCommand (node:internal/cli/run.ts:214:5)";
  const longSnapshot = "page snapshot: heading vivid-activity · button new workspace · button settings · textbox window size · button reload · link pull request 1 · 86 more nodes...";
  const monoMuted = { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11, lineHeight: 16 };
  const longLine = (text: string, wrap: boolean, extra?: TextStyle) => wrap ? (
    <Text selectable style={[monoMuted, { flexShrink: 1 }, extra]}>{text}</Text>
  ) : (
    <ScrollView horizontal nestedScrollEnabled style={styles.codeScroll}>
      <Text selectable style={monoMuted}>{text}</Text>
    </ScrollView>
  );
  // 运行中行的着色与真实行同规则（activity.tsx:561 always 或该行展开）：shell=always/latest 时运行行是展开的。
  const runningColored = values.commandColors === "always" || shellAlways || values.expansion.shell === "latest";
  const shellCommandNode = colored ? shellSegments(SAMPLE_COMMAND, theme) : null;
  const heredocCommandNode = colored ? shellSegments(SAMPLE_HEREDOC_COMMAND, theme) : null;
  const runningShellNode = runningColored ? shellSegments(SAMPLE_COMMAND, theme) : null;
  // 失败明细行与折叠明细的字号走 typeset（与真实 codeLine/fold-changes mono 同基），随字号/行距缩放。
  const failedErrorStyle = typesetStyle({ color: hue(theme, "red", "text"), fontFamily: "monospace", fontSize: 11, lineHeight: 16 }, type);
  const indent = (compact ? 6 : 8) + metrics.tile + metrics.gap;
  const toolValues = { strength: values.strength };
  const diffDetail = { type: "edit", filePath: "/demo/src/app.ts", oldString: `const a = ${"lorem-ipsum-dolor.".repeat(16)}\nconst b = 1;`, newString: "const a = 1;\nconst b = 2;" } as const;
  return (
    <View>
      {values.pinPrompt ? (
        <View style={[styles.section, { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: theme.colors.surface1, marginBottom: metrics.marginTop + 4 }]}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>{t("settings.previewPinned")}</Text>
          {/* 与真实钉住行同行数（PIN_COLLAPSED_LINES，shared/prompt-pin.ts）。 */}
          <Text numberOfLines={PIN_COLLAPSED_LINES} style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 17, marginTop: 2 }}>{SAMPLE_QUESTION()}</Text>
        </View>
      ) : null}
      <ReasoningReplica theme={theme} styles={styles} values={{ strength: values.strength, thoughtExpansion: values.expansion.thinking, tailFollow: values.thoughtTailFollow, tailLines: values.thoughtTailLines, fold: values.fold }} palette={palette} metrics={metrics} />
      {values.takeover === "reasoning" ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t("settings.previewThinkingOnly")}</Text>
      ) : (
        <View>
          <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="read" label={t("modelLook.read")} command="/demo/src/app.ts" state="completed" expanded expandedBody={longLine(longCode, wrapCode)} />
          <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="edit" label={t("modelLook.edit")} command="/demo/src/app.ts" state="completed" expanded diff={<DiffBlock detail={diffDetail} palette={palette} styles={styles} />} />
          <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="search" label={t("modelLook.search")} command="vivid preview coverage" state="completed" />
          <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="browser" label={t("modelPaseo.navigateBrowser")} command="https://app.paseo.sh/workspace" state="completed" expanded expandedBody={longLine(longSnapshot, wrapCode)} />
          {failuresMode ? (
            <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="shell" label={t("modelLook.shell")} command={SAMPLE_COMMAND} commandNode={shellCommandNode} state="failed" expanded errorLine={<><Text style={failedErrorStyle}>{t("ui.error")}: Exit code 1</Text>{longLine(longOutput, wrapOutput, { color: hue(theme, "red", "text") })}</>} />
          ) : (
            <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="shell" label={t("modelLook.shell")} command={SAMPLE_COMMAND} commandNode={shellCommandNode} state="completed" />
          )}
          <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="shell" label={t("modelLook.shell")} command={SAMPLE_HEREDOC_COMMAND} commandNode={heredocCommandNode} state="completed" />
          <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="shell" label={t("modelLook.shell")} command={SAMPLE_COMMAND} commandNode={runningShellNode} state="running" chip={followShell ? <Pill color={hue(theme, "blue", "text")} soft={hue(theme, "blue", "soft")} text={t("settings.previewFollow")} /> : null} />
          {actions.LoaderMark ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: metrics.gap, minHeight: metrics.rowMinHeight, paddingLeft: 5 }}>
              {(() => { const Mark = actions.LoaderMark; return Mark ? <Mark kind={values.loader} size={16} color={palette.statusColors.running} /> : null; })()}
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{t("modelLook.shell")} · {SAMPLE_COMMAND}</Text>
            </View>
          ) : null}
          {/* 「跟随最新输出」状态行：每个域一枚徽标，随各自开关即时出现/消失（全关时整行隐藏）。 */}
          {(() => {
            const domains: Array<{ area: "shell" | "logs" | "todo" | "browser"; label: string; on: boolean }> = [
              { area: "shell", label: t("settings.followShell"), on: values.followOutput?.shell ?? true },
              { area: "logs", label: t("settings.followLogs"), on: values.followOutput?.logs ?? true },
              { area: "todo", label: t("settings.followTodo"), on: values.followOutput?.todo ?? true },
              { area: "browser", label: t("settings.followBrowser"), on: values.followOutput?.browser ?? true },
            ];
            const active = domains.filter((domain) => domain.on);
            if (active.length === 0) return null;
            return (
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingLeft: indent, paddingRight: 6, paddingTop: 6 }}>
                <Text style={{ color: hue(theme, "blue", "text"), fontSize: 11, fontWeight: "700" }}>{t("settings.previewFollow")}:</Text>
                {active.map((domain) => (
                  <Pill key={domain.area} color={hue(theme, "blue", "text")} soft={hue(theme, "blue", "soft")} text={domain.label} />
                ))}
              </View>
            );
          })()}
          <FoldReplica theme={theme} styles={styles} values={{ strength: values.strength, fold: values.fold }} palette={palette} metrics={metrics} failed={failuresMode} type={type} wrapOutput={values.wrapLines?.output ?? false} />
          <TokensReplica theme={theme} indent={indent} />
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center", paddingLeft: indent, paddingTop: 6 }}>
            {Object.entries(palette.categoryColors).map(([category, color]) => <Dot key={category} color={color} size={12} />)}
          </View>
        </View>
      )}
    </View>
  );
}
