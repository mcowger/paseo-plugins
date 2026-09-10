import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useRevealedText } from "@getpaseo/plugin/client/react-native";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Pressable,
  Text,
  View,
  type NativeScrollEvent,
  type ScrollView as NativeScrollView,
  type NativeSyntheticEvent,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type { z } from "zod";
import { useShikiTokens, isDarkSurface, type ShikiToken } from "./highlight";
import { PaseoToolDetail } from "./paseo";
import {
  diffLinesForDetail,
  fileIconForPath,
  formatUnknownValue,
  paseoToolLeafName,
  resolveActivityPalette,
  type ActivityPalette,
  type ActivityThemeColors,
  type DiffLine,
} from "../shared/presentation";
import { parseInlineMarkdown, parseReasoningMarkdown } from "../shared/markdown";
import { activitySettings, DEFAULT_PALETTE_MODE } from "../shared/settings";
import {
  getActivityExpansionState,
  getReasoningExpansionState,
  reasoningItemDataSchema,
  toolCallItemDataSchema,
  type ReasoningItemData,
  type ToolCallItemData,
} from "../shared/timeline";

const MAX_DETAIL_HEIGHT = 420;

type Theme = PluginTimelineItemProps["theme"];
type ReasoningData = z.output<typeof reasoningItemDataSchema>;
type ToolCallData = z.output<typeof toolCallItemDataSchema>;

const latestReasoningTimestamps = new Map<string, number>();
const latestReasoningListeners = new Set<() => void>();
const latestToolCallTimestamps = new Map<string, number>();
const latestToolCallListeners = new Set<() => void>();

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

function usePalette(theme: Theme): ActivityPalette {
  const settings = useSettings(activitySettings);
  const mode = settings.status === "ready" ? settings.values.palette : DEFAULT_PALETTE_MODE;
  return useMemo(
    () => resolveActivityPalette(mode, theme.colors as ActivityThemeColors),
    [mode, theme.colors],
  );
}

function useActivityStyles(theme: Theme, palette: ActivityPalette) {
  return useMemo(
    () => ({
      card: {
        marginHorizontal: -13,
        marginVertical: 2,
      } satisfies ViewStyle,
      headerButton: {
        alignItems: "center",
        borderRadius: 8,
        flexDirection: "row",
        gap: 7,
        minWidth: 0,
        outlineColor: "transparent",
        outlineStyle: "none" as unknown as ViewStyle["outlineStyle"],
        outlineWidth: 0,
        overflow: "hidden",
        paddingHorizontal: 9,
        paddingVertical: 5,
      } satisfies ViewStyle,
      headerButtonActive: {
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
      } satisfies ViewStyle,
      iconBadge: {
        alignItems: "center",
        borderRadius: 10,
        height: 20,
        justifyContent: "center",
        width: 20,
      } satisfies ViewStyle,
      title: {
        color: theme.colors.foreground,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 13,
        fontWeight: "600",
        lineHeight: 20,
      } satisfies TextStyle,
      summary: {
        color: theme.colors.foregroundMuted,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 13,
        lineHeight: 20,
        minWidth: 0,
      } satisfies TextStyle,
      status: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
        marginLeft: 3,
      } satisfies ViewStyle,
      stats: {
        alignItems: "center",
        flexDirection: "row",
        gap: 3,
        marginLeft: 3,
      } satisfies ViewStyle,
      additions: {
        color: theme.colors.statusSuccess,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 18,
      } satisfies TextStyle,
      deletions: {
        color: theme.colors.statusDanger,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 18,
      } satisfies TextStyle,
      details: {
        backgroundColor: theme.colors.surface1,
        borderBottomLeftRadius: 8,
        borderBottomRightRadius: 8,
        flexShrink: 1,
        minWidth: 0,
        overflow: "hidden",
      } satisfies ViewStyle,
      detailsScroll: {
        maxHeight: MAX_DETAIL_HEIGHT,
      } satisfies ViewStyle,
      detailsContent: {
        gap: 10,
        padding: 10,
      } satisfies ViewStyle,
      detailLabel: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 11,
        fontWeight: "600",
        letterSpacing: 0.5,
        lineHeight: 16,
        textTransform: "uppercase",
      } satisfies TextStyle,
      detailText: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 18,
      } satisfies TextStyle,
      mutedText: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 18,
      } satisfies TextStyle,
      pathRow: {
        alignItems: "center",
        flexDirection: "row",
        gap: 7,
        minWidth: 0,
      } satisfies ViewStyle,
      pathText: {
        color: theme.colors.foreground,
        flex: 1,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 18,
      } satisfies TextStyle,
      section: {
        gap: 5,
      } satisfies ViewStyle,
      codeSurface: {
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderRadius: 6,
        borderWidth: 1,
        minWidth: "100%",
        paddingHorizontal: 9,
        paddingVertical: 8,
      } satisfies ViewStyle,
      codeScroll: {
        maxWidth: "100%",
      } satisfies ViewStyle,
      codeLine: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 18,
        minHeight: 18,
      } satisfies TextStyle,
      diffSurface: {
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderRadius: 6,
        borderWidth: 1,
        minWidth: "100%",
        overflow: "hidden",
        paddingVertical: 4,
      } satisfies ViewStyle,
      diffLine: {
        flexDirection: "row",
        minHeight: 18,
        paddingHorizontal: 8,
      } satisfies ViewStyle,
      diffMarker: {
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 18,
        width: 14,
      } satisfies TextStyle,
      diffText: {
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 18,
      } satisfies TextStyle,
      diffAdded: {
        backgroundColor: palette.categoryBackgrounds.agent,
      } satisfies ViewStyle,
      diffRemoved: {
        backgroundColor: palette.statusBackgrounds.failed,
      } satisfies ViewStyle,
      diffMeta: {
        backgroundColor: palette.categoryBackgrounds.search,
      } satisfies ViewStyle,
      reasoningBody: {
        gap: 6,
        paddingHorizontal: 11,
        paddingVertical: 10,
      } satisfies ViewStyle,
      reasoningLine: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 13,
        lineHeight: 20,
      } satisfies TextStyle,
      reasoningHeading: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 14,
        fontWeight: "700",
        lineHeight: 21,
      } satisfies TextStyle,
      reasoningBullet: {
        color: theme.colors.accent,
        fontFamily: "monospace",
        fontSize: 13,
        lineHeight: 20,
        width: 20,
      } satisfies TextStyle,
      reasoningBulletRow: {
        alignItems: "flex-start",
        flexDirection: "row",
        gap: 4,
      } satisfies ViewStyle,
      reasoningQuote: {
        borderLeftColor: theme.colors.accent,
        borderLeftWidth: 2,
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 13,
        lineHeight: 20,
        paddingLeft: 8,
      } satisfies TextStyle,
      reasoningInlineCode: {
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 12,
        paddingHorizontal: 3,
      } satisfies TextStyle,
      reasoningSpacer: {
        height: 4,
      } satisfies ViewStyle,
      empty: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 18,
      } satisfies TextStyle,
      paseoStack: {
        gap: 10,
      } satisfies ViewStyle,
      paseoHero: {
        borderRadius: 8,
        gap: 7,
        padding: 10,
      } satisfies ViewStyle,
      paseoHeroRow: {
        alignItems: "center",
        flexDirection: "row",
        gap: 8,
      } satisfies ViewStyle,
      paseoHeroIcon: {
        alignItems: "center",
        borderRadius: 8,
        height: 28,
        justifyContent: "center",
        width: 28,
      } satisfies ViewStyle,
      paseoHeroTitle: {
        color: theme.colors.foreground,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 13,
        fontWeight: "700",
        lineHeight: 19,
      } satisfies TextStyle,
      paseoHeroSubtitle: {
        color: theme.colors.foregroundMuted,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      paseoRows: {
        gap: 5,
      } satisfies ViewStyle,
      paseoRow: {
        alignItems: "flex-start",
        flexDirection: "row",
        gap: 10,
        minWidth: 0,
      } satisfies ViewStyle,
      paseoKey: {
        color: theme.colors.foregroundMuted,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 18,
        minWidth: 105,
      } satisfies TextStyle,
      paseoValue: {
        color: theme.colors.foreground,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 18,
        minWidth: 0,
      } satisfies TextStyle,
      paseoPrompt: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 6,
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 18,
        paddingHorizontal: 9,
        paddingVertical: 8,
      } satisfies TextStyle,
      paseoList: {
        gap: 6,
      } satisfies ViewStyle,
      paseoListItem: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 6,
        gap: 3,
        paddingHorizontal: 9,
        paddingVertical: 7,
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
        fontSize: 12,
        fontWeight: "600",
        lineHeight: 18,
        minWidth: 0,
      } satisfies TextStyle,
      paseoListItemMeta: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      paseoChips: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 5,
      } satisfies ViewStyle,
      paseoChip: {
        borderRadius: 5,
        paddingHorizontal: 6,
        paddingVertical: 3,
      } satisfies ViewStyle,
      paseoChipText: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 15,
      } satisfies TextStyle,
      paseoStatus: {
        alignSelf: "flex-start",
        borderRadius: 5,
        paddingHorizontal: 6,
        paddingVertical: 2,
      } satisfies ViewStyle,
      paseoStatusText: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 10,
        fontWeight: "700",
        lineHeight: 15,
        textTransform: "uppercase",
      } satisfies TextStyle,
    }),
    [palette, theme],
  );
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
      <Icon name={icon} color={styles.pathText.color} size={15} />
      <Text selectable style={styles.pathText}>
        {path}
      </Text>
    </View>
  );
}

function TokenizedLines({
  lines,
  styles,
}: {
  lines: ShikiToken[][];
  styles: ReturnType<typeof useActivityStyles>;
}) {
  return (
    <View>
      {lines.map((line, lineIndex) => (
        <Text key={`line-${lineIndex}`} selectable style={styles.codeLine}>
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

function ShikiCodeBlock({
  code,
  language,
  theme,
  label,
  styles,
}: {
  code: string;
  language: string;
  theme: Theme;
  label?: string;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const tokens = useShikiTokens(code, language, isDarkSurface(theme.colors.surface0));
  return (
    <View style={styles.section}>
      {label ? <DetailLabel style={styles.detailLabel}>{label}</DetailLabel> : null}
      <ScrollView horizontal nestedScrollEnabled style={styles.codeScroll}>
        <View style={styles.codeSurface}>
          {tokens ? (
            <TokenizedLines lines={tokens} styles={styles} />
          ) : (
            <Text selectable style={styles.codeLine}>
              {code || " "}
            </Text>
          )}
        </View>
      </ScrollView>
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
  const lines = useMemo(() => diffLinesForDetail(detail), [detail]);
  return (
    <View style={styles.section}>
      <DetailLabel style={styles.detailLabel}>Diff</DetailLabel>
      <ScrollView horizontal nestedScrollEnabled style={styles.codeScroll}>
        <View style={styles.diffSurface}>
          {lines.length === 0 ? (
            <Text style={styles.empty}>No changed lines.</Text>
          ) : (
            lines.map((line, index) => <DiffRow key={`${line.kind}-${index}`} line={line} palette={palette} styles={styles} />)
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function DiffRow({
  line,
  palette,
  styles,
}: {
  line: DiffLine;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
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
      <Text selectable style={[styles.diffText, { color: line.kind === "meta" ? markerColor : styles.codeLine.color }]}>
        {line.text || " "}
      </Text>
    </View>
  );
}

function DetailBody({
  data,
  theme,
  palette,
  styles,
}: {
  data: ToolCallData;
  theme: Theme;
  palette: ActivityPalette;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const detail = asToolCallDetail(data.detail);
  if (!detail) return <Text style={styles.empty}>Tool details unavailable.</Text>;

  switch (detail.type) {
    case "shell":
      return (
        <>
          <ShikiCodeBlock
            code={`$ ${detail.command}`}
            language="bash"
            label="Command"
            styles={styles}
            theme={theme}
          />
          {detail.output ? (
            <ShikiCodeBlock
              code={detail.output}
              language="ansi"
              label="Output"
              styles={styles}
              theme={theme}
            />
          ) : null}
          {detail.exitCode !== undefined && detail.exitCode !== null ? (
            <Text style={styles.mutedText}>Exit code {detail.exitCode}</Text>
          ) : null}
        </>
      );
    case "read":
      return (
        <>
          <PathRow icon={data.presentation.fileIcon ?? "Eye"} path={detail.filePath} styles={styles} />
          {detail.content ? (
            <ShikiCodeBlock
              code={detail.content}
              language={data.presentation.language ?? "text"}
              label="Contents"
              styles={styles}
              theme={theme}
            />
          ) : (
            <Text style={styles.empty}>No file contents returned.</Text>
          )}
        </>
      );
    case "write":
      return (
        <>
          <PathRow icon={data.presentation.fileIcon ?? "Pencil"} path={detail.filePath} styles={styles} />
          {detail.content ? (
            <ShikiCodeBlock
              code={detail.content}
              language={data.presentation.language ?? "text"}
              label="Written contents"
              styles={styles}
              theme={theme}
            />
          ) : null}
        </>
      );
    case "edit":
      return (
        <>
          <PathRow icon={data.presentation.fileIcon ?? "Pencil"} path={detail.filePath} styles={styles} />
          <DiffBlock detail={detail} palette={palette} styles={styles} />
        </>
      );
    case "search":
      return (
        <>
          <Text style={styles.detailText}>Query: {detail.query}</Text>
          {detail.filePaths?.map((filePath) => (
            <PathRow key={filePath} icon={fileIconForPath(filePath)} path={filePath} styles={styles} />
          ))}
          {detail.content ? <ShikiCodeBlock code={detail.content} language="text" styles={styles} theme={theme} /> : null}
          {detail.webResults?.map((result) => (
            <View key={result.url} style={styles.section}>
              <Text selectable style={styles.detailText}>{result.title}</Text>
              <Text selectable style={styles.mutedText}>{result.url}</Text>
            </View>
          ))}
          {detail.annotations?.map((annotation, index) => (
            <Text key={`${annotation}-${index}`} selectable style={styles.mutedText}>{annotation}</Text>
          ))}
        </>
      );
    case "fetch":
      return (
        <>
          <Text selectable style={styles.detailText}>{detail.url}</Text>
          {detail.result ? <ShikiCodeBlock code={detail.result} language="text" label="Result" styles={styles} theme={theme} /> : null}
          {detail.code !== undefined ? <Text style={styles.mutedText}>HTTP {detail.code} {detail.codeText ?? ""}</Text> : null}
        </>
      );
    case "worktree_setup":
      return (
        <>
          <Text style={styles.detailText}>Branch: {detail.branchName}</Text>
          <Text style={styles.mutedText}>Path: {detail.worktreePath}</Text>
          {detail.log ? <ShikiCodeBlock code={detail.log} language="ansi" label="Setup log" styles={styles} theme={theme} /> : null}
        </>
      );
    case "sub_agent":
      return (
        <>
          {detail.subAgentType ? <Text style={styles.detailText}>{detail.subAgentType}</Text> : null}
          {detail.description ? <Text style={styles.mutedText}>{detail.description}</Text> : null}
          {detail.childSessionId ? <Text style={styles.mutedText}>Session {detail.childSessionId}</Text> : null}
          {detail.actions?.map((action) => (
            <Text key={`${action.index}-${action.toolName}`} style={styles.detailText}>
              [{action.toolName}] {action.summary ?? ""}
            </Text>
          ))}
          {detail.log ? <ShikiCodeBlock code={detail.log} language="ansi" label="Activity log" styles={styles} theme={theme} /> : null}
        </>
      );
    case "plain_text":
      return <Text selectable style={styles.detailText}>{detail.text ?? ""}</Text>;
    case "plan":
      return <Text selectable style={styles.detailText}>{detail.text}</Text>;
    case "unknown": {
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
      return (
        <>
          <DetailLabel style={styles.detailLabel}>Input</DetailLabel>
          <Text selectable style={styles.detailText}>{formatUnknownValue(detail.input)}</Text>
          <DetailLabel style={styles.detailLabel}>Output</DetailLabel>
          <Text selectable style={styles.detailText}>{formatUnknownValue(detail.output)}</Text>
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
    return (
      <Text key={`inline-${index}`} style={style}>
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

function ReasoningMarkdown({
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
    <View style={styles.reasoningBody}>
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        switch (block.type) {
          case "code":
            return (
              <ShikiCodeBlock
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
    </View>
  );
}

function ReasoningText({
  text,
  phase,
  theme,
  styles,
}: {
  text: string;
  phase: ReasoningData["phase"];
  theme: Theme;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  const revealedText = useRevealedText(text, phase);
  const scrollRef = useRef<NativeScrollView | null>(null);
  const isNearBottom = useRef(true);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    isNearBottom.current = layoutMeasurement.height + contentOffset.y >= contentSize.height - 32;
  }, []);
  const handleContentSizeChange = useCallback(() => {
    if (isNearBottom.current) scrollRef.current?.scrollToEnd({ animated: false });
  }, []);

  return (
    <ScrollView
      ref={scrollRef}
      nestedScrollEnabled
      onContentSizeChange={handleContentSizeChange}
      onScroll={handleScroll}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator
      style={styles.detailsScroll}
    >
      <ReasoningMarkdown text={revealedText} theme={theme} styles={styles} />
    </ScrollView>
  );
}

function ActivityHeader({
  icon,
  iconColor,
  iconBackground,
  title,
  summary,
  status,
  statusColor,
  stats,
  expanded,
  onPress,
  styles,
}: {
  icon: string;
  iconColor: string;
  iconBackground: string;
  title: string;
  summary?: string;
  status?: ToolCallData["status"];
  statusColor?: string;
  stats?: ToolCallData["presentation"]["diffStats"];
  expanded: boolean;
  onPress: () => void;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  return (
    <Pressable
      accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${title}`}
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.headerButton, { backgroundColor: iconBackground }, expanded && styles.headerButtonActive]}
    >
      <View style={[styles.iconBadge, { backgroundColor: iconBackground }]}>
        <Icon name={icon} color={iconColor} size={14} />
      </View>
      <Text numberOfLines={1} style={styles.title}>{title}</Text>
      {summary ? <Text numberOfLines={1} style={styles.summary}>{summary}</Text> : null}
      {stats ? (
        <View style={styles.stats}>
          <Text style={styles.additions}>+{stats.additions}</Text>
          <Text style={styles.deletions}>-{stats.deletions}</Text>
        </View>
      ) : null}
      {status ? (
        <View style={styles.status}>
          <Icon name={statusIcon(status)} color={statusColor ?? styles.title.color} size={14} />
        </View>
      ) : null}
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} color={styles.summary.color} size={15} />
    </Pressable>
  );
}

export function ColorfulReasoning({
  agentId,
  item,
  theme,
  timestamp,
}: PluginTimelineItemProps<ReasoningItemData>) {
  const palette = usePalette(theme);
  const styles = useActivityStyles(theme, palette);
  const isStreaming = item.data.phase === "streaming";
  const isLatest = useIsLatestReasoning(agentId, timestamp, isStreaming);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = getReasoningExpansionState(isStreaming, isLatest, userExpanded);
  const toggle = useCallback(() => {
    setUserExpanded(!expanded);
  }, [expanded]);
  return (
    <View style={styles.card}>
      <ActivityHeader
        icon="Sparkles"
        iconColor={palette.categoryColors.reasoning}
        iconBackground={palette.categoryBackgrounds.reasoning}
        title="Thought Process"
        expanded={expanded}
        onPress={toggle}
        styles={styles}
      />
      {expanded ? (
        <View style={styles.details}>
          <ReasoningText text={item.data.text} phase={item.data.phase} theme={theme} styles={styles} />
        </View>
      ) : null}
    </View>
  );
}

export function ColorfulToolCall({
  agentId,
  item,
  theme,
  timestamp,
}: PluginTimelineItemProps<ToolCallItemData>) {
  const palette = usePalette(theme);
  const styles = useActivityStyles(theme, palette);
  const isRunning = item.data.status === "running";
  const isLatest = useIsLatestToolCall(agentId, timestamp, isRunning);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = getActivityExpansionState(isRunning, isLatest, userExpanded);
  const toggle = useCallback(() => {
    if (!isRunning) setUserExpanded(!expanded);
  }, [expanded, isRunning]);
  const categoryColor = palette.categoryColors[item.data.presentation.category];
  const categoryBackground = palette.categoryBackgrounds[item.data.presentation.category];
  const statusColor = palette.statusColors[item.data.status];
  return (
    <View style={styles.card}>
      <ActivityHeader
        icon={item.data.presentation.icon}
        iconColor={categoryColor}
        iconBackground={categoryBackground}
        title={item.data.presentation.label}
        summary={item.data.presentation.summary}
        status={item.data.status}
        statusColor={statusColor}
        stats={item.data.presentation.diffStats}
        expanded={expanded}
        onPress={toggle}
        styles={styles}
      />
      {expanded ? (
        <View style={styles.details}>
          <ScrollView style={styles.detailsScroll} contentContainerStyle={styles.detailsContent} nestedScrollEnabled showsVerticalScrollIndicator>
            <DetailBody data={item.data} theme={theme} palette={palette} styles={styles} />
            {item.data.errorText ? (
              <View style={styles.section}>
                <DetailLabel style={styles.detailLabel}>Error</DetailLabel>
                <Text selectable style={{ ...styles.detailText, color: theme.colors.statusDanger }}>{item.data.errorText}</Text>
              </View>
            ) : null}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
