import { t } from "../shared/text";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useAgent, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useRevealedText } from "@getpaseo/plugin/client/react-native";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, Text, View, type ScrollView as NativeScrollView, type TextStyle } from "react-native";
import { commandBadge, fileBadge, type Badge } from "../shared/brand";
import { extractCodeModeCode, isCodeModeTool } from "../shared/codemode";
import { exaToolKind } from "../shared/exa";
import { githubToolKind } from "../shared/github";
import { parseInlineMarkdown, parseReasoningMarkdown, type ReasoningMarkdownBlock } from "../shared/markdown";
import { isMcpTool, mcpResultText } from "../shared/mcp-result";
import { ompMcpResultRpc } from "../shared/omp-mcp-result";
import { isOmpFindTool } from "../shared/omp-find";
import { parseSearchDisplay } from "../shared/omp-search";
import { isOmpGlobTool, isOmpGrepTool } from "../shared/omp-search";
import { isOmpEvalTool, isOmpWebSearchTool } from "../shared/omp-tools";
import { parsePiSubagentCall, piSubagentOperation } from "../shared/pi-subagents";
import { askContent, compactText, diffLinesForDetail, editDiffContentSize, effectiveUnifiedDiff, extractCodeInput, fileIconForPath, formatUnknownValue, hasMeaningfulUnknownValue, isAskTool, isBgWaitTool, isOmpTaskTool, isOmpWaitTool, isOpencodeSubagentTool, isSkillTool, isSubagentSupervisorTool, isTodoTool, MAX_DIFF_CHARS, notInHeader, outputView, parseOpencodeSearchContent, parsePiLsOutput, paseoToolLeafName, PREVIEW_LINES, previewText, readErrorMessage, relativeToRoot, resolveSearchCounts, skillNameForDetail, splitReasoningSteps, splitStepTitle, stripAnsi, subAgentLogFullyShown, tailLinesOf, type ActivityPalette, type AskContent, type DiffLine } from "../shared/presentation";
import { readImageRpc, shouldAttemptImageLoad } from "../shared/read-image";
import { noticeSections, type NoticeState } from "../shared/notice";
import { PI_NOTICE_BODY_CHARS, type PiNoticeData, type ReasoningItemData, type ToolCallItemData } from "../shared/timeline";
import { formatDuration } from "../shared/timing";
import { CodeModeToolDetail } from "./codemode";
import { CopyButton, OutputCopyButtons } from "./copy-button";
import { GithubToolDetail } from "./github";
import { useHighlightTokens, type HighlightToken } from "./highlight";
import { aria, vividSyntaxColors } from "./kit";
import { useFollowBottom, useWrapLines } from "./settings-hooks";
import { Breathe } from "./motion";
import { OmpFindToolDetail } from "./omp-find";
import { OmpGlobToolDetail, OmpGrepToolDetail, SearchDisplay } from "./omp-search";
import { OmpEvalToolDetail, OmpWebSearchToolDetail } from "./omp-tools";
import { OmpWaitToolDetail } from "./omp-wait";
import { parseOmpWaitText } from "../shared/omp-wait-text";
import { OmpWaitTextDetail } from "./omp-wait-text";
import { ompBashWait } from "../shared/omp-bash-wait";
import { OmpTaskToolDetail } from "./omp-task";
import { OpencodeSubagentToolDetail } from "./opencode-subagent";
import { ExaToolDetail, PaseoToolDetail } from "./paseo";
import { BgWaitToolDetail, PiSubagentToolDetail, SupervisorToolDetail } from "./pi-subagents";
import { TodoToolDetail } from "./todo";
import { BrandChip, zh } from "./vivid";
import { cmonoTextEscape, cmonoViewEscape, cuiViewEscape } from "./web";
import { activitySettings } from "../shared/settings";
import type { useActivityStyles } from "./activity";

type Theme = PluginTimelineItemProps["theme"];
type ToolCallData = ToolCallItemData;
type ReasoningData = ReasoningItemData;

function asToolCallDetail(value: ToolCallData["detail"]): ToolCallDetail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = Reflect.get(value, "type");
  if (typeof type !== "string") return null;
  return value as unknown as ToolCallDetail;
}

function DetailLabel({ children, style }: { children: ReactNode; style: TextStyle }) {
  return <Text style={style}>{typeof children === "string" ? zh(children) : children}</Text>;
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

/** 本地补丁：文件标题行：语言色标 + 路径（相对 Agent 工作目录）。 */
function FileTitle({ path, styles }: { path: string; styles: ReturnType<typeof useActivityStyles> }) {
  const chip = fileBadge(path);
  return (
    <View style={styles.pathRow}>
      {chip ? <BrandChip badge={chip} /> : <Icon name="File" color={styles.pathText.color} size={12} />}
      <Text selectable numberOfLines={2} style={styles.pathText}>
        {path}
      </Text>
    </View>
  );
}

function TokenizedLines({
  lines,
  styles,
  numbersFrom,
  wrapLines,
}: {
  lines: HighlightToken[][];
  styles: ReturnType<typeof useActivityStyles>;
  /** 「长行折行」时的内联行号（替代行号槽；折行后续行自然流下，行号仍对逻辑行）。 */
  numbersFrom?: number;
  /** 「长行折行」：行内允许折行（flexShrink），配合父级去掉横向滚动。 */
  wrapLines?: boolean;
}) {
  return (
    <View>
      {lines.map((line, lineIndex) => (
        <Text key={`line-${lineIndex}`} selectable style={[styles.codeLine, wrapLines || numbersFrom !== undefined ? { flexShrink: 1 } : null]}>
          {numbersFrom !== undefined ? <Text style={styles.gutterText}>{String(numbersFrom + lineIndex)} </Text> : null}
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
      ))}
    </View>
  );
}

function LineGutter({ start, count, styles }: { start: number; count: number; styles: ReturnType<typeof useActivityStyles> }) {
  const numbers = useMemo(() => Array.from({ length: count }, (_, index) => String(start + index)), [count, start]);
  return (
    <View style={styles.gutter}>
      {numbers.map((number) => (
        <Text key={number} style={styles.gutterText}>
          {number}
        </Text>
      ))}
    </View>
  );
}

/**
 * 本地补丁（吸收 beautiful-chat）：代码框。标题栏在框内：语言色标、标题（文件路径或小节名）、附加信息、复制；
 * 正文可带行号。长内容先显示前 20 行。
 */
function HighlightedCodeBlock({
  code,
  language,
  theme,
  label,
  styles,
  chip,
  title,
  lineStart,
  extra,
  copyLabel = t("ui.copyCode"),
  copyRaw,
  follow,
}: {
  code: string;
  language: string;
  theme: Theme;
  label?: string;
  styles: ReturnType<typeof useActivityStyles>;
  chip?: Badge | null;
  /** Shown instead of the label, e.g. the file path. */
  title?: string;
  /** First line number; omit for no gutter. */
  lineStart?: number;
  extra?: ReactNode;
  copyLabel?: string;
  copyRaw?: string;
  /** 0.11.0:「跟随最新输出」——跟随域开启时输出块显示尾窗（最后 N 行），最新行始终可见。 */
  follow?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  // 0.11.0:「长行折行·代码与文件」：折行时去掉横向滚动、行号内联到行首（悬挂语义，行号仍对逻辑行）。
  const wrap = useWrapLines("code");
  // 0.5.0: terminal escape sequences never show (shared/presentation.ts stripAnsi); 「复制原文」 keeps them.
  const clean = useMemo(() => stripAnsi(code), [code]);
  // A file's final newline is not a line of its own (no empty numbered line at the end); copying keeps it.
  // 0.11.0:「跟随最新输出」尾窗：行在运行中且跟随域开启、内容被截断时，从全文取最后 PREVIEW_LINES 行
  // （最新行始终可见），高亮同一段，行号跟随偏移；「展开全部」仍可看到全部。其余情况维持头部预览（现状）。
  const view = useMemo(() => outputView(code, clean, showAll, language === "ansi", true, follow), [clean, code, follow, language, showAll]);
  const { preview, shown: displayCode, start: tailStart } = view;
  // 0.11.0:命令详情体（bash）与行头共用同一 vivid 派生映射——同一命令两处同色同构；其余语言不受影响。
  const tokens = useHighlightTokens(view.highlight, language, language === "bash" ? { ...theme.colors, ...vividSyntaxColors(theme) } : theme.colors);
  const lineCount = useMemo(() => (lineStart === undefined ? 0 : displayCode.split("\n").length), [displayCode, lineStart]);
  const codeLines = useMemo(() => (wrap ? displayCode.split("\n") : null), [wrap, displayCode]);

  return (
    <View {...cmonoViewEscape} style={styles.frame}>
      <View style={styles.frameHeader}>
        <View style={styles.frameTitleRow}>
          {chip ? <BrandChip badge={chip} /> : null}
          {title ? (
            <Text selectable numberOfLines={1} style={styles.frameTitle}>
              {title}
            </Text>
          ) : label ? (
            <DetailLabel style={styles.detailLabel}>{label}</DetailLabel>
          ) : null}
        </View>
        {extra}
        <OutputCopyButtons clean={copyRaw ?? clean} raw={copyRaw ?? code} label={copyLabel} theme={theme} styles={styles} />
      </View>
      {wrap ? (
        <View style={styles.frameBodyWrap}>
          {tokens ? (
            <TokenizedLines lines={tokens} styles={styles} numbersFrom={lineStart !== undefined ? lineStart + tailStart : undefined} wrapLines />
          ) : codeLines ? (
            codeLines.map((line, index) => (
              <Text key={`code-${index}`} selectable style={[styles.codeLine, { flexShrink: 1 }]}>
                {lineStart !== undefined ? (
                  <Text style={styles.gutterText}>{String(lineStart + tailStart + index)} </Text>
                ) : null}
                {line || " "}
              </Text>
            ))
          ) : null}
        </View>
      ) : (
        <ScrollView horizontal nestedScrollEnabled style={styles.codeScroll}>
          <View style={styles.frameBody}>
            {lineStart !== undefined ? <LineGutter start={lineStart + tailStart} count={lineCount} styles={styles} /> : null}
            <View>
              {tokens ? (
                <TokenizedLines lines={tokens} styles={styles} />
              ) : (
                <Text selectable style={styles.codeLine}>
                  {displayCode || " "}
                </Text>
              )}
            </View>
          </View>
        </ScrollView>
      )}
      {preview.truncated ? (
        <Pressable
          accessibilityRole="button"
          {...aria({ expanded: showAll })}
          onPress={() => setShowAll(!showAll)}
          style={styles.showMoreButton}
        >
          <Text style={styles.showMoreText}>
            {showAll
              ? t("ui.collapse")
              : t("ui.expandAllLinesCharacters", { count: preview.totalLines, lines: preview.totalLines, characters: preview.totalChars.toLocaleString() })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Exit code of a shell call: the detail's own, else Claude Code's 「Exit code N」 error text. */
function shellExitCode(detail: { exitCode?: number | null }, errorText: string | undefined): number | null {
  if (typeof detail.exitCode === "number") return detail.exitCode;
  const fromText = /^\s*Exit code (\d+)\b/i.exec(errorText ?? "")?.[1];
  return fromText ? Number(fromText) : null;
}

/** 本地补丁（吸收 beautiful-chat）：终端框。标题栏：程序色标、退出码、复制命令；`$ 命令` 高亮；输出在下层。 */
export function TerminalBlock({
  command,
  output: rawOutput,
  errorOutput,
  exitCode,
  theme,
  palette,
  styles,
  follow,
}: {
  command: string;
  output: string | undefined;
  /** Claude Code puts a failed command's output in the error text: shown here, in red, when there is no output. */
  errorOutput?: string;
  exitCode: number | null;
  theme: Theme;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
  /** 0.11.0:「跟随最新输出」——跟随域开启时输出尾窗（最后 N 行），最新行始终可见。 */
  follow?: boolean;
}) {
  const brand = useMemo(() => commandBadge(command), [command]);
  const commandTokens = useHighlightTokens(`$ ${command}`, "bash", theme.colors);
  const [showAll, setShowAll] = useState(false);
  const isError = !rawOutput && Boolean(errorOutput);
  // 「Exit code 1」 opens Claude Code's error text; the chip already says it.
  const output = rawOutput || (errorOutput ? errorOutput.replace(/^\s*Exit code \d+\s*\n?/i, "").replace(/^\s*\n/, "") : undefined) || undefined;
  // 0.5.0: shown without terminal escape sequences, the preview and 「展开全部」 both cut from the cleaned whole output;
  // colours still reach the "ansi" highlighter. The raw output stays for 「复制原文」.
  const clean = useMemo(() => stripAnsi(output ?? ""), [output]);
  // 0.11.0:「跟随最新输出」尾窗：行在运行中且跟随域开启、输出被截断时，从全文取最后 PREVIEW_LINES 行
  // （最新行始终可见），颜色序列一并保留给高亮；其余情况维持头部预览。
  const view = useMemo(() => outputView(output ?? "", clean, showAll, !isError, true, follow), [clean, follow, isError, output, showAll]);
  const { preview, shown: shownOutput } = view;
  const outputTokens = useHighlightTokens(isError ? "" : view.highlight, "ansi", theme.colors);
  const failed = exitCode !== null && exitCode !== 0;
  const failedColor = palette.statusColors.failed;
  // 0.11.0:「长行折行·命令行与输出」：折行时去横向滚动，长命令/长输出折到可用宽度。
  const wrap = useWrapLines("output");
  const exitColor = failed ? failedColor : palette.statusColors.completed;
  return (
    <View {...cmonoViewEscape} style={styles.frame}>
      <View style={styles.frameHeader}>
        <View style={styles.frameTitleRow}>
          {brand ? <BrandChip badge={brand} /> : <Icon name="SquareTerminal" size={13} color={styles.copyText.color} />}
          <DetailLabel style={styles.detailLabel}>{t("ui.command")}</DetailLabel>
        </View>
        {exitCode !== null ? (
          <View style={{ height: 16, paddingHorizontal: 5, borderRadius: 8, justifyContent: "center", borderWidth: 1, borderColor: exitColor }}>
            <Text style={{ color: exitColor, fontSize: 10, fontWeight: "700", lineHeight: 12 }}>{t("ui.exitCode", { code: exitCode })}</Text>
          </View>
        ) : null}
        <CopyButton value={command} label={t("ui.copyCommand")} theme={theme} styles={styles} />
      </View>
      {wrap ? (
        <View style={styles.frameBodyWrap}>
          {commandTokens ? (
            <TokenizedLines lines={commandTokens} styles={styles} wrapLines />
          ) : (
            <Text selectable style={[styles.codeLine, { flexShrink: 1 }]}>{`$ ${command}`}</Text>
          )}
        </View>
      ) : (
        <ScrollView horizontal nestedScrollEnabled style={styles.codeScroll}>
          <View style={styles.frameBody}>
            {commandTokens ? <TokenizedLines lines={commandTokens} styles={styles} /> : <Text selectable style={styles.codeLine}>{`$ ${command}`}</Text>}
          </View>
        </ScrollView>
      )}
      {output ? (
        <View style={styles.termOutput}>
          <View style={styles.termOutputHeader}>
            <DetailLabel style={isError ? { ...styles.detailLabel, color: failedColor } : styles.detailLabel}>{isError ? t("ui.errorOutput") : t("ui.output")}</DetailLabel>
            <OutputCopyButtons clean={clean} raw={output} label={t("ui.copyOutput")} theme={theme} styles={styles} />
          </View>
          {wrap ? (
            <View style={styles.frameBodyWrap}>
              {outputTokens && !isError ? (
                <TokenizedLines lines={outputTokens} styles={styles} wrapLines />
              ) : (
                <Text selectable style={[isError ? { ...styles.codeLine, color: failedColor } : styles.codeLine, { flexShrink: 1 }]}>{shownOutput || " "}</Text>
              )}
            </View>
          ) : (
            <ScrollView horizontal nestedScrollEnabled style={styles.codeScroll}>
              <View style={styles.frameBody}>
                {outputTokens && !isError ? (
                  <TokenizedLines lines={outputTokens} styles={styles} />
                ) : (
                  <Text selectable style={isError ? { ...styles.codeLine, color: failedColor } : styles.codeLine}>{shownOutput || " "}</Text>
                )}
              </View>
            </ScrollView>
          )}
          {preview.truncated ? (
            <Pressable accessibilityRole="button" {...aria({ expanded: showAll })} onPress={() => setShowAll(!showAll)} style={styles.showMoreButton}>
              <Text style={styles.showMoreText}>
                {showAll ? t("ui.collapse") : t("ui.expandAllLinesCharacters", { count: preview.totalLines, lines: preview.totalLines, characters: preview.totalChars.toLocaleString() })}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

type ReadImageState =
  | { status: "loading" }
  | { status: "ok"; uri: string }
  | { status: "fallback"; note?: string };

// 本地补丁：预览只读 Agent 工作目录和临时目录（见 server/read-image.ts），其他位置给出原因。
const IMAGE_NOTES: Partial<Record<string, string>> = {
  get outside() { return t("ui.theImageIsOutsideThe"); },
  get "too-large"() { return t("ui.theImageIsLargerThan"); },
};

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
          const note = IMAGE_NOTES[result.status];
          setImage(note ? { status: "fallback", note } : { status: "fallback" });
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

  if (image.status === "fallback") {
    return image.note ? <>
      <Text style={styles.mutedText}>{image.note}</Text>
      {fallback}
    </> : <>{fallback}</>;
  }
  if (image.status === "loading") return <Text style={styles.mutedText}>{t("ui.loadingImage")}</Text>;
  return (
    <View style={styles.section}>
      <DetailLabel style={styles.detailLabel}>{t("ui.image")}</DetailLabel>
      <Pressable
        accessibilityLabel={expanded ? t("ui.shrinkImage") : t("ui.enlargeImage")}
        accessibilityRole="button"
        {...aria({ expanded })}
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

/** 0.11.0:「思考行实时跟随」：开 = 展开后的思考框展示最新 N 行并跟随输出（shared/settings.ts thoughtTail*）。 */
function useThoughtTail(): { follow: boolean; lines: number } {
  const settings = useSettings(activitySettings);
  if (settings.status !== "ready") return { follow: false, lines: 20 };
  return { follow: settings.values.thoughtTailFollow, lines: settings.values.thoughtTailLines };
}

export function DiffBlock({
  detail,
  palette,
  styles,
}: {
  detail: Extract<ToolCallDetail, { type: "edit" }>;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const [showAll, setShowAll] = useState(false);
  const wrap = useWrapLines("diff");
  const lines = useMemo(() => diffLinesForDetail(detail), [detail]);
  const isTruncated = lines.length > PREVIEW_LINES;
  const displayLines = showAll || !isTruncated ? lines : lines.slice(0, PREVIEW_LINES);

  return (
    <View style={styles.section}>
      <DetailLabel style={styles.detailLabel}>{t("ui.changes")}</DetailLabel>
      {wrap ? (
        <View style={styles.diffSurface}>
          {displayLines.length === 0 ? (
            <Text style={styles.empty}>{t("ui.noChangesToShow")}</Text>
          ) : (
            displayLines.map((line, index) => <DiffRow key={`${line.kind}-${index}`} line={line} palette={palette} styles={styles} wrap />)
          )}
        </View>
      ) : (
        <ScrollView horizontal nestedScrollEnabled style={styles.codeScroll}>
          <View style={styles.diffSurface}>
            {displayLines.length === 0 ? (
              <Text style={styles.empty}>{t("ui.noChangesToShow")}</Text>
            ) : (
              displayLines.map((line, index) => <DiffRow key={`${line.kind}-${index}`} line={line} palette={palette} styles={styles} />)
            )}
          </View>
        </ScrollView>
      )}
      {isTruncated ? (
        <Pressable
          accessibilityRole="button"
          {...aria({ expanded: showAll })}
          onPress={() => setShowAll(!showAll)}
          style={styles.showMoreButton}
        >
          <Text style={styles.showMoreText}>
            {showAll ? t("ui.collapse") : t("ui.expandAllLines", { lines: lines.length })}
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
  wrap = false,
}: {
  line: DiffLine;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
  /** 「折行 diff 行」：文字折到可用宽度（horizontal 滚动关闭时）。 */
  wrap?: boolean;
}) {
  const rowStyle =
    line.kind === "add"
      ? styles.diffAdded
      : line.kind === "remove"
        ? styles.diffRemoved
        : line.kind === "meta"
          ? styles.diffMeta
          : undefined;
  const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : line.kind === "meta" ? "" : " ";
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
      <Text selectable style={[styles.diffText, wrap ? { flexShrink: 1, minWidth: 0 } : null, { color: line.kind === "meta" ? markerColor : styles.codeLine.color }]}>
        {line.text || " "}
      </Text>
    </View>
  );
}

/**
 * 0.6.0 (opus-F52): plain text (a tool's text result, a sub-agent's report) wraps like prose and shows its first 20 lines or
 * 4,000 characters, with 「展开全部」 and a copy button. ACP providers return most MCP results this way and the newest row
 * opens by itself, so a 100 KB result used to be laid out whole in the phone's row.
 */
function PlainTextBlock({
  text,
  label,
  color,
  theme,
  styles,
}: {
  text: string;
  label: string;
  /** Text colour, e.g. the failed red. */
  color?: string;
  theme: Theme;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const [showAll, setShowAll] = useState(false);
  const clean = useMemo(() => stripAnsi(text), [text]);
  const view = useMemo(() => outputView(text, clean, showAll, false), [clean, showAll, text]);
  return (
    <View style={styles.section}>
      <View style={styles.codeHeader}>
        <DetailLabel style={styles.detailLabel}>{label}</DetailLabel>
        <OutputCopyButtons clean={clean} raw={text} label={t("ui.copy", { label: label })} theme={theme} styles={styles} />
      </View>
      <Text selectable style={color ? { ...styles.detailText, color } : styles.detailText}>{view.shown || " "}</Text>
      {view.preview.truncated ? (
        <Pressable accessibilityRole="button" {...aria({ expanded: showAll })} onPress={() => setShowAll(!showAll)} style={styles.showMoreButton}>
          <Text style={styles.showMoreText}>
            {showAll ? t("ui.collapse") : t("ui.expandAllLinesCharacters", { count: view.preview.totalLines, lines: view.preview.totalLines, characters: view.preview.totalChars.toLocaleString() })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const NOTICE_STATE_LABEL: Record<NoticeState, string> = { get done() { return t("ui.completed"); }, get failed() { return t("ui.failed"); }, get stopped() { return t("ui.stopped"); }, get blocked() { return t("ui.blocked"); }, get info() { return t("ui.notice"); } };

/** A notice's usage line: 「48,213 token · 17 次工具调用 · 2 分 11 秒」. */
function noticeUsageText(usage: ReturnType<typeof noticeSections>["usage"]): string | null {
  if (!usage) return null;
  const parts = [
    usage.tokens !== null ? t("ui.tokens", { count: usage.tokens.toLocaleString() }) : null,
    usage.toolUses !== null ? t("ui.toolCalls", { count: usage.toolUses }) : null,
    usage.durationMs !== null ? formatDuration(usage.durationMs) : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(t("ui.metaSeparator")) : null;
}

/**
 * 本地补丁：后台任务通知只列说明、状态、输出文件和任务（原文是给模型看的 <task-notification> 标签）。0.6.0 加上子 Agent
 * 交回的结论（`<result>`，先显示前 20 行）、用量，以及监控事件的内容。
 */
function NoticeDetail({ data, raw, theme, palette, styles }: { data: ToolCallData; raw: string | undefined; theme: Theme; palette: ActivityPalette; styles: ReturnType<typeof useActivityStyles> }) {
  const notice = data.notice!;
  const sections = useMemo(() => noticeSections(raw), [raw]);
  const usage = noticeUsageText(sections.usage);
  const fields: Array<[string, string, boolean, string?]> = [
    [t("ui.description"), notice.text, false],
    [t("ui.status"), NOTICE_STATE_LABEL[notice.state], false, "status"],
    ...(usage ? ([[t("ui.usage"), usage, false]] as Array<[string, string, boolean, string?]>) : []),
    ...(notice.outputFile ? ([[t("ui.outputFile"), notice.outputFile, true]] as Array<[string, string, boolean, string?]>) : []),
    ...(notice.taskId ? ([[t("ui.task"), notice.taskId, true]] as Array<[string, string, boolean, string?]>) : []),
  ];
  const stateColor = notice.state === "failed" || notice.state === "blocked" ? palette.statusColors.failed : notice.state === "done" ? palette.statusColors.completed : undefined;
  return (
    <>
      {fields.map(([label, value, mono, id]) => (
        <View key={label} style={styles.section}>
          <DetailLabel style={styles.detailLabel}>{label}</DetailLabel>
          <Text selectable style={{ ...styles.detailText, ...(mono ? {} : { fontFamily: undefined }), ...(id === "status" && stateColor ? { color: stateColor, fontWeight: "600" as const } : {}) }}>{value}</Text>
        </View>
      ))}
      {sections.event ? <PlainTextBlock text={sections.event} label={t("ui.event")} theme={theme} styles={styles} /> : null}
      {sections.result ? <PlainTextBlock text={sections.result} label={notice.kind === "agent" ? t("ui.subagentConclusion") : t("ui.result")} theme={theme} styles={styles} /> : null}
    </>
  );
}

/**
 * 0.6.0 (opus-B30): a Pi extension's notice in Chinese: its fields (task, state, exit code, error, output file…) and, when
 * there is one, the longer text (result preview, error output, the sub-agents' outputs). What the notice tells the model to
 * do next is not shown; the raw message is still in the Agent's history.
 */
function PiNoticeDetail({ pi, theme, palette, styles }: { pi: PiNoticeData; theme: Theme; palette: ActivityPalette; styles: ReturnType<typeof useActivityStyles> }) {
  const stateColor = pi.state === "failed" ? palette.statusColors.failed : pi.state === "done" ? palette.statusColors.completed : undefined;
  return (
    <>
      {pi.fields.map((field) => (
        <View key={field.label} style={styles.section}>
          <DetailLabel style={styles.detailLabel}>{field.label}</DetailLabel>
          <Text selectable style={{ ...styles.detailText, ...(field.mono ? {} : { fontFamily: undefined }), ...(field.id === "status" && stateColor ? { color: stateColor, fontWeight: "600" as const } : {}) }}>{field.value}</Text>
        </View>
      ))}
      {/* 0.6.0-local.5 (codex-vivid-merge-F2): drawn without the reader, the body is the message as sent. */}
      {pi.body ? <PlainTextBlock text={pi.body} label={pi.reader ? t("ui.originalText") : t("ui.content")} theme={theme} styles={styles} /> : null}
      {pi.cut ? <Text style={styles.mutedText}>{t("ui.thisContentIsLongOnly", { count: PI_NOTICE_BODY_CHARS })}</Text> : null}
    </>
  );
}

/**
 * 0.6.0 (opus-F54): an ask tool shows its questions and options, and once answered what you picked (the picked option in
 * green). Claude's AskUserQuestion used to show as raw JSON, Codex's request_user_input as plain text.
 */
function AskDetail({ content, palette, styles }: { content: AskContent; palette: ActivityPalette; styles: ReturnType<typeof useActivityStyles> }) {
  const picked = new Set(content.answers.flatMap((answer) => answer.answer.split(/,\s*/)));
  const prose = { ...styles.detailText, fontFamily: undefined };
  return (
    <>
      {content.questions.map((question, index) => (
        <View key={`${index}-${question.question}`} style={styles.section}>
          <DetailLabel style={styles.detailLabel}>{question.header ? t("ui.question3", { header: question.header }) : content.questions.length > 1 ? t("ui.question2", { number: index + 1 }) : t("ui.question")}</DetailLabel>
          <Text selectable style={prose}>{question.question}</Text>
          {question.options.length > 0 ? (
            <View style={styles.paseoChips}>
              {question.options.map((option) => {
                const chosen = picked.has(option);
                return (
                  <View key={option} style={chosen ? [styles.paseoChip, { borderColor: palette.statusColors.completed }] : styles.paseoChip}>
                    <Text style={chosen ? [styles.paseoChipText, { color: palette.statusColors.completed, fontWeight: "700" }] : styles.paseoChipText}>{chosen ? `✓ ${option}` : option}</Text>
                  </View>
                );
              })}
            </View>
          ) : null}
          {question.multiSelect ? <Text style={styles.mutedText}>{t("ui.selectAllThatApply")}</Text> : null}
        </View>
      ))}
      {content.answers.length > 0 ? (
        <View style={styles.section}>
          <DetailLabel style={styles.detailLabel}>{t("ui.answer")}</DetailLabel>
          {content.answers.map((answer, index) => (
            <Text key={`${index}-${answer.answer}`} selectable style={prose}>
              {answer.question && content.questions.length > 1 ? t("ui.answerPair", { question: answer.question, answer: answer.answer }) : answer.answer}
            </Text>
          ))}
        </View>
      ) : null}
    </>
  );
}

function PendingOutput({ styles }: { styles: ReturnType<typeof useActivityStyles> }) {
  return (
    <View style={styles.pendingRow}>
      <ActivityIndicator size="small" color={styles.mutedText.color} />
      <Text style={styles.mutedText}>{t("ui.waitingForOutput")}</Text>
    </View>
  );
}

function SearchDetail({
  detail,
  headerSummary,
  agentId,
  theme,
  styles,
  recoveredText,
  recovering,
}: {
  detail: Extract<ToolCallDetail, { type: "search" }>;
  headerSummary: string | undefined;
  agentId: string;
  theme: Theme;
  styles: ReturnType<typeof useActivityStyles>;
  recoveredText?: string | null;
  recovering?: boolean;
}) {
  const cwd = useAgent(agentId, (agent) => agent.cwd);
  const annotated = detail.content ? parseSearchDisplay(detail.content).some((line) => line.kind === "file") : false;
  const parsed = useMemo(() => annotated ? undefined : parseOpencodeSearchContent(detail.content), [annotated, detail.content]);
  const displayPath = useCallback(
    (filePath: string) => (cwd ? relativeToRoot(filePath, cwd) : filePath),
    [cwd],
  );
  const { matchCount, fileCount } = resolveSearchCounts(detail, parsed);
  const meta = [
    matchCount !== undefined ? t("ui.matches", { count: matchCount }) : undefined,
    fileCount !== undefined ? t("ui.files", { count: fileCount }) : undefined,
  ]
    .filter(Boolean)
    .join(t("ui.metaSeparator"));

  return (
    <>
      {notInHeader(detail.query, headerSummary) ? (
        <Text style={styles.detailText}>{t("ui.queryValue", { value: detail.query })}</Text>
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
          {detail.content && (annotated || matchCount !== 0) ? (
            annotated ? <SearchDisplay content={detail.content} styles={styles} theme={theme} />
              : <HighlightedCodeBlock code={detail.content} language="text" styles={styles} theme={theme} />
          ) : null}
        </>
      )}
      {detail.webResults?.map((result) => (
        <View key={result.url} style={styles.section}>
          <Text selectable style={styles.detailText}>{result.title}</Text>
          <Text selectable style={styles.mutedText}>{result.url}</Text>
        </View>
      ))}
      {detail.annotations?.map((annotation, index) => (
        <Text key={`${annotation}-${index}`} selectable style={styles.mutedText}>{annotation}</Text>
      ))}
      {recovering ? <ActivityIndicator size="small" color={styles.mutedText.color} /> : null}
      {recoveredText ? <Text selectable style={styles.mutedText}>{recoveredText}</Text> : null}
      {recoveredText === null ? <Text style={styles.empty}>{t("modelStatus.unavailable")}</Text> : null}
    </>
  );
}

export function DetailBody({
  data,
  agentId,
  theme,
  palette,
  styles,
  follow,
}: {
  data: ToolCallData;
  agentId: string;
  theme: Theme;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
  /** 0.11.0:「跟随最新输出」：该行的跟随域开启且在流式中（输出块显示尾窗）。 */
  follow?: boolean;
}) {
  const detail = asToolCallDetail(data.detail);
  const loadOmpMcpResult = useRpc(ompMcpResultRpc);
  const provider = useAgent(agentId, (agent) => agent.provider);
  const directMcpText = detail?.type === "plain_text" && isMcpTool(data.name)
    ? detail.text || (mcpResultText((detail as unknown as Record<string, unknown>).output) ?? mcpResultText((detail as unknown as Record<string, unknown>).result) ?? mcpResultText(detail))
    : undefined;
  const missingSearchResult = detail?.type === "search" && isOmpGrepTool(data.name) &&
    !detail.content && !detail.filePaths?.length && !detail.webResults?.length && !detail.annotations?.length &&
    detail.numMatches === undefined && detail.numFiles === undefined;
  const shouldRecoverMcpResult = Boolean(
    provider === "omp" && data.status !== "running" && data.callId &&
    ((detail?.type === "plain_text" && !detail.text && !directMcpText) || missingSearchResult),
  );
  const [recoveredMcpResult, setRecoveredMcpResult] = useState<{ key: string; text: string | null } | null>(null);
  const recoveryKey = shouldRecoverMcpResult ? `${agentId}\u0000${data.callId}` : "";
  useEffect(() => {
    if (!recoveryKey) return;
    let live = true;
    setRecoveredMcpResult(null);
    void loadOmpMcpResult({ agentId, callId: data.callId! }).then(
      (result) => { if (live) setRecoveredMcpResult({ key: recoveryKey, text: result.text }); },
      () => { if (live) setRecoveredMcpResult({ key: recoveryKey, text: null }); },
    );
    return () => { live = false; };
  }, [agentId, data.callId, loadOmpMcpResult, recoveryKey]);
  const recoveredText = recoveredMcpResult?.key === recoveryKey ? recoveredMcpResult.text : undefined;
  const cwd = useAgent(agentId, (agent) => agent.cwd);
  const shownPath = (path: string) => (cwd ? relativeToRoot(path, cwd) : path);
  if (data.notice) {
    return <NoticeDetail data={data} raw={detail?.type === "plain_text" ? detail.text : undefined} theme={theme} palette={palette} styles={styles} />;
  }
  if (data.pi) return <PiNoticeDetail pi={data.pi} theme={theme} palette={palette} styles={styles} />;
  if (!detail) return <Text style={styles.empty}>{t("ui.noToolDetails")}</Text>;
  if (isAskTool(data.name) && (detail.type === "unknown" || detail.type === "plain_text")) {
    const content = askContent(detail);
    if (content.questions.length > 0 || content.answers.length > 0) return <AskDetail content={content} palette={palette} styles={styles} />;
  }

  if (isSkillTool(data.name)) {
    const skillName = skillNameForDetail(detail);
    if (!skillName) return <Text style={styles.empty}>{t("ui.noSkillDetails")}</Text>;
    return (
      <Text selectable style={styles.detailText}>
        {skillName}
      </Text>
    );
  }

  switch (detail.type) {
    case "shell": {
      const shell = detail as typeof detail & { truncated?: boolean; fullOutputPath?: string };
      return (
        <>
          <TerminalBlock
            follow={follow}
            command={detail.command}
            output={detail.output}
            errorOutput={data.errorText}
            exitCode={shellExitCode(detail, data.errorText)}
            styles={styles}
            theme={theme}
            palette={palette}
          />
          {shell.truncated === true ? (
            <Text selectable style={styles.mutedText}>
              {shell.fullOutputPath
                ? t("ui.outputTruncatedFullOutputAt", { path: compactText(shell.fullOutputPath, 160) })
                : t("ui.outputTruncated")}
            </Text>
          ) : null}
        </>
      );
    }
    case "read":
      if (readErrorMessage(detail.content) && data.errorText) {
        return <FileTitle path={shownPath(detail.filePath)} styles={styles} />;
      }
      if (!shouldAttemptImageLoad(detail.filePath, detail.content)) {
        return detail.content ? (
          <HighlightedCodeBlock
            code={detail.content}
            language={data.presentation.language ?? "text"}
            chip={fileBadge(detail.filePath)}
            title={shownPath(detail.filePath)}
            lineStart={typeof detail.offset === "number" && detail.offset > 0 ? detail.offset : 1}
            copyLabel={t("ui.copyContent")}
            styles={styles}
            theme={theme}
          />
        ) : (
          <FileTitle path={shownPath(detail.filePath)} styles={styles} />
        );
      }
      return (
        <>
          <FileTitle path={shownPath(detail.filePath)} styles={styles} />
          <ReadImageBlock
            filePath={detail.filePath}
            agentId={agentId}
            styles={styles}
            fallback={
              detail.content ? (
                <HighlightedCodeBlock
                  code={detail.content}
                  language={data.presentation.language ?? "text"}
                  label={t("ui.content")}
                  styles={styles}
                  theme={theme}
                />
              ) : null
            }
          />
        </>
      );
    case "write":
      return detail.content ? (
        <HighlightedCodeBlock
          code={detail.content}
          language={data.presentation.language ?? "text"}
          chip={fileBadge(detail.filePath)}
          title={shownPath(detail.filePath)}
          lineStart={1}
          copyLabel={t("ui.copyWrittenContent")}
          styles={styles}
          theme={theme}
        />
      ) : (
        <FileTitle path={shownPath(detail.filePath)} styles={styles} />
      );
    case "edit": {
      const isOversized = editDiffContentSize(detail) > MAX_DIFF_CHARS;

      if (isOversized && effectiveUnifiedDiff(detail) === undefined) {
        return (
          <>
            <FileTitle path={shownPath(detail.filePath)} styles={styles} />
            {detail.oldString ? (
              <HighlightedCodeBlock
                code={detail.oldString}
                language={data.presentation.language ?? "text"}
                label={t("ui.before")}
                styles={styles}
                theme={theme}
              />
            ) : null}
            {detail.newString ? (
              <HighlightedCodeBlock
                code={detail.newString}
                language={data.presentation.language ?? "text"}
                label={t("ui.after")}
                styles={styles}
                theme={theme}
              />
            ) : null}
          </>
        );
      }

      return (
        <>
          <FileTitle path={shownPath(detail.filePath)} styles={styles} />
          <DiffBlock detail={detail} palette={palette} styles={styles} />
        </>
      );
    }
    case "search":
      return (
        <SearchDetail
          detail={detail}
          headerSummary={data.presentation.summary}
          agentId={agentId}
          theme={theme}
          styles={styles}
          recoveredText={missingSearchResult ? recoveredText : undefined}
          recovering={missingSearchResult && recoveredText === undefined}
        />
      );
    case "fetch":
      return (
        <>
          {notInHeader(detail.url, data.presentation.summary) ? (
            <Text selectable style={styles.detailText}>{detail.url}</Text>
          ) : null}
          {detail.result ? <HighlightedCodeBlock code={detail.result} language="text" label={t("ui.result")} styles={styles} theme={theme} /> : null}
          {detail.code !== undefined ? <Text style={styles.mutedText}>{t("ui.httpStatus", { code: detail.code, status: detail.codeText ?? "" })}</Text> : null}
        </>
      );
    case "worktree_setup":
      return (
        <>
          <Text style={styles.detailText}>{t("ui.branchValue", { value: detail.branchName })}</Text>
          <Text style={styles.mutedText}>{t("ui.pathValue", { value: detail.worktreePath })}</Text>
          {detail.log ? <HighlightedCodeBlock code={detail.log} language="ansi" label={t("ui.setupLog")} styles={styles} theme={theme} follow={follow} /> : null}
        </>
      );
    case "sub_agent":
      if (piSubagentOperation(data.name) && parsePiSubagentCall(undefined, detail.log).lifecycle) {
        return <PiSubagentToolDetail toolName={data.name} input={undefined} output={detail.log}
          agentType={detail.subAgentType} description={detail.description} childSessionId={detail.childSessionId}
          theme={theme} palette={palette} styles={styles} />;
      }
      return (
        <>
          {notInHeader(detail.subAgentType, data.presentation.summary) ? <Text style={styles.detailText}>{detail.subAgentType}</Text> : null}
          {notInHeader(detail.description, data.presentation.summary) ? <Text style={styles.mutedText}>{detail.description}</Text> : null}
          {detail.childSessionId ? <Text style={styles.mutedText}>{t("ui.sessionValue", { value: detail.childSessionId })}</Text> : null}
          {detail.log && !subAgentLogFullyShown(detail) ? <HighlightedCodeBlock code={detail.log} language="ansi" label={t("ui.activityLog")} styles={styles} theme={theme} follow={follow} /> : null}
        </>
      );
    case "plain_text": {
      const text = detail.text || directMcpText || recoveredText;
      const bash = ompBashWait(data.name, detail);
      if (bash) {
        let json: string | undefined;
        if (text && text.length <= 200_000) {
          try { json = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Keep non-JSON output as terminal text. */ }
        }
        return <>
          <TerminalBlock command={bash.command} output={json === undefined ? text ?? undefined : undefined} errorOutput={data.errorText} exitCode={null} theme={theme} palette={palette} styles={styles} follow={follow} />
          {json !== undefined && text ? <HighlightedCodeBlock code={json} copyRaw={text} language="json" label={t("ui.result")} theme={theme} styles={styles} follow={follow} /> : null}
        </>;
      }
      const wait = isOmpWaitTool(data.name) && text ? parseOmpWaitText(text) : null;
      if (wait) return <OmpWaitTextDetail model={wait} theme={theme} palette={palette} styles={styles} />;
      if (text) return <PlainTextBlock text={text} label={t("ui.result")} theme={theme} styles={styles} />;
      if (shouldRecoverMcpResult && recoveredText === undefined) return <ActivityIndicator size="small" color={styles.mutedText.color} />;
      return <Text style={styles.empty}>{t("ui.noTextReturned")}</Text>;
    }
    case "plan":
      return <Text selectable style={styles.detailText}>{detail.text}</Text>;
    case "unknown": {
      if (isOmpGrepTool(data.name)) return <OmpGrepToolDetail input={detail.input} output={detail.output} running={data.status === "running"} styles={styles} />;
      if (isOmpGlobTool(data.name)) return <OmpGlobToolDetail input={detail.input} output={detail.output} running={data.status === "running"} styles={styles} />;
      if (isOmpEvalTool(data.name)) return <OmpEvalToolDetail input={detail.input} output={detail.output} running={data.status === "running"} styles={styles} />;
      if (isOmpWebSearchTool(data.name)) return <OmpWebSearchToolDetail input={detail.input} output={detail.output} running={data.status === "running"} styles={styles} />;
      if (piSubagentOperation(data.name)) {
        return <PiSubagentToolDetail toolName={data.name} input={detail.input} output={detail.output}
          theme={theme} palette={palette} styles={styles} />;
      }
      if (isOmpTaskTool(data.name, detail.input)) {
        return <OmpTaskToolDetail input={detail.input} output={detail.output} errorText={data.errorText}
          status={data.status} theme={theme} palette={palette} styles={styles} />;
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
          return <CodeModeToolDetail code={code} output={detail.output} theme={theme} styles={styles} />;
        }
      }
      if (data.name.trim().toLowerCase() === "ls") {
        const entries = parsePiLsOutput(detail.output);
        if (entries !== null) {
          return (
            <View style={styles.section}>
              <DetailLabel style={styles.detailLabel}>{t("ui.file")}</DetailLabel>
              {entries.length === 0 ? (
                <Text style={styles.empty}>{t("ui.noFilesReturned")}</Text>
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
        return (
          <OmpFindToolDetail
            input={detail.input}
            output={detail.output}
            styles={styles}
          />
        );
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
      const codeInput = extractCodeInput(data.name, detail.input);
      if (codeInput) {
        return (
          <>
            <HighlightedCodeBlock
              code={codeInput.code}
              language={codeInput.language}
              label={t("ui.input")}
              styles={styles}
              theme={theme}
            />
            {hasMeaningfulUnknownValue(detail.output) ? (
              <HighlightedCodeBlock
                code={formatUnknownValue(detail.output)}
                language="json"
                label={t("ui.output")}
                styles={styles}
                theme={theme}
                follow={follow}
              />
            ) : data.status === "running" ? (
              <PendingOutput styles={styles} />
            ) : null}
          </>
        );
      }
      const mcpText = isMcpTool(data.name) ? mcpResultText(detail.output) : undefined;
      return (
        <>
          {hasMeaningfulUnknownValue(detail.input) ? (
            <HighlightedCodeBlock
              code={formatUnknownValue(detail.input)}
              language="json"
              label={t("ui.input")}
              styles={styles}
              theme={theme}
            />
          ) : null}
          {mcpText ? (
            <PlainTextBlock text={mcpText} label={t("ui.result")} theme={theme} styles={styles} />
          ) : hasMeaningfulUnknownValue(detail.output) ? (
            <HighlightedCodeBlock
              code={formatUnknownValue(detail.output)}
              language="json"
              label={t("ui.output")}
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

function renderInlineReasoning(text: string, styles: ReturnType<typeof useActivityStyles>): ReactNode[] {
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
  inRow = false,
}: {
  text: string;
  styles: ReturnType<typeof useActivityStyles>;
  /** Next to a list marker: shrinks to the row (opus-F49). */
  inRow?: boolean;
}) {
  return <Text style={inRow ? [styles.reasoningLine, styles.reasoningBulletText] : styles.reasoningLine}>{renderInlineReasoning(text, styles)}</Text>;
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
                <InlineReasoning text={block.text} styles={styles} inRow />
              </View>
            );
          case "ordered":
            return (
              <View key={key} style={styles.reasoningBulletRow}>
                <Text style={styles.reasoningBullet}>{block.marker}</Text>
                <InlineReasoning text={block.text} styles={styles} inRow />
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
  last,
  theme,
  palette,
  styles,
}: {
  index: number;
  text: string;
  active: boolean;
  last: boolean;
  theme: Theme;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const { title, body } = useMemo(() => splitStepTitle(text), [text]);
  const blocks = useMemo(() => parseReasoningMarkdown(body), [body]);
  const color = active ? palette.statusColors.running : palette.statusColors.completed;
  const dot = (
    <View style={[styles.stepDot, { borderColor: color, backgroundColor: active ? "transparent" : color }]}>
      {active ? null : <Icon name="Check" size={9} color="#ffffff" />}
    </View>
  );
  return (
    <View style={styles.stepRow}>
      <View style={styles.stepRail}>
        {active ? <Breathe>{dot}</Breathe> : dot}
        {last ? null : <View style={styles.stepLine} />}
      </View>
      <View style={styles.stepContent}>
        <Text style={styles.stepTitle}>{title ? t("ui.numberedStep", { number: index + 1, title }) : t("ui.step", { number: index + 1 })}</Text>
        {blocks.length > 0 ? (
          <ReasoningBlockList blocks={blocks} keyPrefix={`step-${index}`} theme={theme} styles={styles} />
        ) : null}
      </View>
    </View>
  );
}

export function ReasoningText({
  text,
  phase,
  theme,
  palette,
  styles,
}: {
  text: string;
  phase: ReasoningData["phase"];
  theme: Theme;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const [showAll, setShowAll] = useState(false);
  const tail = useThoughtTail();
  const preview = useMemo(() => previewText(text), [text]);
  // 跟随模式吃全量文本（头部预览截断会让「尾窗」错切到头 20 行的尾巴）；窗口只裁剪渲染。
  const targetText = showAll || tail.follow ? text : preview.text;
  const revealedText = useRevealedText(targetText, phase);
  const allSteps = useMemo(() => splitReasoningSteps(revealedText), [revealedText]);
  // 0.11.0:「思考行实时跟随」：窗口只裁剪渲染，揭示与打字机始终吃全量。步骤模式按步保号，块模式按行；
  // 用户点开的「展开全部」（showAll）压过窗口。流式时 revealedText 每 tick 变化，窗口随之滑动。
  const windowed = tail.follow && !showAll
    ? allSteps.length > 1
      ? { kind: "steps" as const, steps: allSteps.slice(Math.max(0, allSteps.length - tail.lines)), start: Math.max(0, allSteps.length - tail.lines) }
      : { kind: "block" as const, block: tailLinesOf(revealedText, tail.lines) }
    : null;
  const stepStart = windowed?.kind === "steps" ? windowed.start : 0;
  const shownSteps = windowed?.kind === "steps" ? windowed.steps : allSteps;
  const blockText = windowed?.kind === "block" ? windowed.block : revealedText;
  // 窗口确实裁掉了内容（或用户已展开）才给按钮；OFF 时沿用头部预览的截断判定。
  const windowTruncated = tail.follow && !showAll && (allSteps.length > 1 ? allSteps.length > tail.lines : revealedText.split("\n").length > tail.lines);
  const showExpandButton = showAll || windowTruncated || (!tail.follow && preview.truncated);
  const isStreaming = phase === "streaming";
  const scrollRef = useRef<NativeScrollView | null>(null);
  const isNearBottom = useRef(true);
  // 窗口饱和后内容高度近似不变（旧的从顶上裁掉、新的接在底下），onContentSizeChange 不再触发，
  // 跟随就此停摆——共享回底钩子把回底挂在尾窗内容本身（tailHead 一变就回底），直到用户上滚离底。
  const tailHead = shownSteps.length > 1 ? shownSteps[shownSteps.length - 1] : blockText;
  const { onScroll: onTailScroll, onContentSizeChange: onTailContentSizeChange } = useFollowBottom(scrollRef, isNearBottom, tailHead, true);

  return (
    <View>
      <ScrollView
        ref={scrollRef}
        nestedScrollEnabled
        onContentSizeChange={onTailContentSizeChange}
        onScroll={onTailScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator
        style={styles.detailsScroll}
      >
        {shownSteps.length <= 1 ? (
          <ReasoningMarkdown text={blockText} theme={theme} styles={styles} />
        ) : (
          <View {...cuiViewEscape} style={styles.stepList}>
            {shownSteps.map((step, index) => (
              <ReasoningStep
                key={`step-${stepStart + index}`}
                index={stepStart + index}
                text={step}
                active={isStreaming && stepStart + index === allSteps.length - 1}
                last={stepStart + index === allSteps.length - 1}
                theme={theme}
                palette={palette}
                styles={styles}
              />
            ))}
          </View>
        )}
      </ScrollView>
      {showExpandButton ? (
        <Pressable
          accessibilityRole="button"
          {...aria({ expanded: showAll })}
          onPress={() => setShowAll(!showAll)}
          style={styles.showMoreButton}
        >
          <Text style={styles.showMoreText}>
            {showAll
              ? t("ui.collapse")
              : t("ui.expandAllLinesCharacters", { count: preview.totalLines, lines: preview.totalLines, characters: preview.totalChars.toLocaleString() })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
