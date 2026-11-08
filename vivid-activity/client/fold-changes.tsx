import { t } from "../shared/text";
import { useWrapLines } from "./settings-hooks";
import type { PluginTheme } from "@getpaseo/plugin";
import type { ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import { useMemo } from "react";
import { Text, View, type TextStyle, type ViewStyle } from "react-native";
import { changePath, commandHead, fileId } from "../shared/changes";
import type { FoldFail, FoldFile } from "../shared/fold";
import { extractApplyPatchEdits, isApplyPatchTool, normalizeToolCallDetail, splitFileDisplay, stripLeadingCwdCd, truncateDirFront } from "../shared/presentation";
import { DiffBlocks, Glyph } from "./diffstat";
import { hue } from "./kit";
import { cuiTextEscape } from "./web";
import { typesetStyle, useTypography } from "./typography";

type Item = Extract<ToolCallTimelineItem, { type: "tool_call" }>;

/** What the resident fold row hands over (client/fold-row.tsx): the summary's numbers and a lookup of the rows it drew. */
export interface FoldChangesProps {
  theme: PluginTheme;
  lineHeight: number;
  indent: number;
  cwd: string | null;
  files: number;
  /** Changes whose lines are not known (shared/changes.ts): said as a count, never added in. */
  uncounted?: number;
  changed: readonly FoldFile[];
  fails: readonly FoldFail[];
  /** The finished call last drawn for a fold key (client/transform.ts finishedToolItem); null when not kept. */
  item: (key: string) => Item | null;
}

/** The path of `file` in a call drawn earlier, relative to the Agent's directory; null when the call is not kept. */
export function changedPath(item: Item | null, file: string, cwd: string | null): string | null {
  if (!item) return null;
  if (isApplyPatchTool(item.name)) {
    const edits = extractApplyPatchEdits(item.detail, item.detail.type === "unknown" ? item.detail.output : undefined, item.metadata);
    const edit = edits.find((each) => fileId(each.filePath, cwd) === file);
    if (edit) return changePath(edit.filePath, cwd);
  }
  const detail = normalizeToolCallDetail(item.detail, item.name);
  return detail.type === "edit" && detail.filePath && fileId(detail.filePath, cwd) === file ? changePath(detail.filePath, cwd) : null;
}

/** The first line of a failed call's command; null when the call is not kept. */
export function failedCommand(item: Item | null, cwd: string | null): string | null {
  if (!item) return null;
  const detail = normalizeToolCallDetail(item.detail, item.name);
  return detail.type === "shell" && detail.command ? commandHead(stripLeadingCwdCd(detail.command, cwd)) : null;
}

/**
 * 0.8.0（fx 懒加载块）：展开的折叠摘要下面列出每个文件的 +/−、失败命令的首行和退出码。文件名和命令来自这台设备画过的行，
 * 折叠索引里只有数字。
 */
export function FoldChanges({ theme, lineHeight, indent, cwd, files: fileCount, uncounted = 0, changed, fails: failed, item }: FoldChangesProps) {
  // The resident row redraws this view when the language changes; its text follows the row's (fx-chunk.client.tsx).
  const files = useMemo(() => changed.flatMap((change) => {
    const path = changedPath(item(change.key), change.file, cwd);
    if (!path) return [];
    const display = splitFileDisplay(path);
    return [{ ...change, dir: display.dir ? truncateDirFront(display.dir) : undefined, base: display.base }];
  }), [changed, cwd, item]);
  const fails = useMemo(() => failed.flatMap((fail) => {
    const command = failedCommand(item(fail.key), cwd);
    return command ? [{ ...fail, command }] : [];
  }), [cwd, failed, item]);
  const type = useTypography();
  const more = Math.max(0, fileCount - files.length);
  if (files.length === 0 && fails.length === 0 && more === 0 && uncounted === 0) return null;
  const line: ViewStyle = { flexDirection: "row", alignItems: "center", gap: 6, minHeight: lineHeight + 2, minWidth: 0 };
  const mono: TextStyle = typesetStyle({ fontFamily: "monospace", fontSize: 12, lineHeight }, type);
  // 0.11.0:「长行折行·命令行与输出」：失败命令行随矩阵折行（路径保持单行省略）。
  const wrapOutput = useWrapLines("output");
  const number: TextStyle = { fontSize: 12, lineHeight, fontWeight: "700", fontVariant: ["tabular-nums"], flexShrink: 0 };
  return (
    <View style={{ marginLeft: indent, marginRight: 6, marginTop: 2, marginBottom: 2, paddingVertical: 4, paddingHorizontal: 8, gap: 1, borderRadius: 8, backgroundColor: theme.colors.surface1, borderLeftWidth: 2, borderLeftColor: hue(theme, "green", "line") }}>
      {files.map((file) => (
        <View key={file.file} style={line}>
          <Glyph name="FilePen" color={hue(theme, "green")} />
          <View style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
            {file.dir ? <Text numberOfLines={1} style={[mono, { color: theme.colors.foregroundMuted, flexShrink: 1 }]}>{file.dir}/</Text> : null}
            <Text numberOfLines={1} style={[mono, { color: theme.colors.foreground, fontWeight: "600", flexShrink: 0, maxWidth: "100%" }]}>{file.base}</Text>
          </View>
          {file.added > 0 ? <Text style={[number, { color: hue(theme, "green", "text") }]}>+{file.added}</Text> : null}
          {file.removed > 0 ? <Text style={[number, { color: hue(theme, "red", "text") }]}>−{file.removed}</Text> : null}
          <DiffBlocks theme={theme} added={file.added} removed={file.removed} size={6} />
        </View>
      ))}
      {more > 0 ? <Text {...cuiTextEscape} style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight }}>{t("fold.moreFiles", { count: more })}</Text> : null}
      {uncounted > 0 ? <Text {...cuiTextEscape} style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight }}>{t("fold.uncountedNote", { count: uncounted })}</Text> : null}
      {fails.map((fail) => (
        <View key={fail.key} style={[line, wrapOutput ? { alignItems: "flex-start" } : null]}>
          <Glyph name="SquareTerminal" color={hue(theme, "red")} />
          <Text numberOfLines={wrapOutput ? undefined : 1} style={[mono, { color: theme.colors.foreground, flexGrow: 1, flexShrink: 1, minWidth: 0 }]}>$ {fail.command}</Text>
          <View style={{ height: 18, paddingHorizontal: 6, borderRadius: 9, justifyContent: "center", backgroundColor: hue(theme, "red", "soft"), flexShrink: 0 }}>
            <Text {...cuiTextEscape} numberOfLines={1} style={{ color: hue(theme, "red", "text"), fontSize: 11, fontWeight: "700" }}>
              {fail.exit !== null ? t("modelText.exitCode", { code: fail.exit }) : t("modelRowStatus.failed")}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}
