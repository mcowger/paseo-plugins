import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { hashText } from "./fold";
import {
  diffStatsFromUnifiedDiff,
  exactDiffStatsForDetail,
  extractApplyPatchEdits,
  formatError,
  hasEditDiffContent,
  isApplyPatchTool,
  isHostTruncatedDiff,
  MAX_DIFF_CHARS,
  normalizeToolCallDetail,
  withMetadataEditDiff,
} from "./presentation";
import { exitCodeOf } from "./vivid-model";

/**
 * Adapted from lthieu96/paseo-chat-polish/shared/recap.ts (MIT, see NOTICE): `changeSummary` counts each finished edit's
 * lines per file (paths relative to the Agent's directory), reads Claude Code's exit code from "Exit code N" in the error
 * and lists a failed command by its first line.
 *
 * 0.8.0：一段改了哪些文件、各加删几行，哪些命令失败了（折叠摘要行的「N 个文件 +A −R」和展开后的清单）。
 * 插件服务端读折叠索引时顺带记下每个工具行的数字（文件的短哈希、加删行数、失败命令的退出码），不带文件名和命令；
 * 客户端按段汇总（shared/fold.ts），展开时再从自己画过的行里找文件名和命令。
 *
 * 只记确定的行数，判断不了就记成「未计行数」的一处改动，不猜，也不让它混进数字里：
 * - 编辑：和这一行自己的 +N/−M 同一套算法（exactDiffStatsForDetail）；Paseo 截断过的 diff、太大比不了的、没有 diff 的，未计。
 * - 写入：不知道是新建还是覆盖、覆盖了多少，未计。
 * - 补丁（apply_patch）：OpenCode 在 metadata 里给出每个文件的 diff，逐个计；完整的补丁原文（`*** Begin Patch` … `*** End Patch`）
 *   逐段严格解析，Add 计加行、Update 计加删、Delete（原文里没有被删的行）未计；原文残缺、超长、格式不对，整次未计。
 *   其余情况（Paseo 把 Codex 的多文件补丁只留成第一个文件的编辑，ACP 只留第一个 diff）看不出还有没有别的文件，整次未计。
 */

/** Most files one call may report; a call over more files counts as one change without line counts. */
export const MAX_CALL_FILES = 64;
/** Longest patch text parsed; a longer one counts as one change without line counts. */
export const MAX_PATCH_CHARS = 200_000;

/** [file id, lines added, lines removed] of one call. */
export type FileChange = readonly [file: string, added: number, removed: number];

/** What one finished call changed: files whose lines are known exactly, and changes whose lines are not. */
export interface CallChanges {
  files: FileChange[];
  uncounted: number;
}

/** A path as the index compares it: relative to the Agent's directory when inside it, without a leading `./`. */
export function changePath(path: string, cwd?: string | null): string {
  let relative = path.trim();
  const root = cwd ? cwd.trim().replace(/\/+$/, "") : "";
  if (root && relative.startsWith(`${root}/`)) relative = relative.slice(root.length + 1);
  while (relative.startsWith("./")) relative = relative.slice(2);
  return relative;
}

/** A file's id in the fold index: a short hash of its path (never the path itself). */
export function fileId(path: string, cwd?: string | null): string {
  return hashText(changePath(path, cwd));
}

type ToolLike = { name: string; status?: unknown; detail: ToolCallDetail; metadata?: Record<string, unknown>; error?: unknown };

const ONE_UNCOUNTED: CallChanges = { files: [], uncounted: 1 };

/** Collects files (merging a file changed twice, first appearance first) and changes without line counts. */
function collector(cwd: string | null | undefined) {
  const files = new Map<string, [number, number]>();
  let uncounted = 0;
  return {
    add(path: string, added: number, removed: number): void {
      const id = fileId(path, cwd);
      const known = files.get(id);
      if (known) {
        known[0] += added;
        known[1] += removed;
      } else {
        files.set(id, [added, removed]);
      }
    },
    skip(): void {
      uncounted += 1;
    },
    result(): CallChanges | null {
      if (files.size > MAX_CALL_FILES) return ONE_UNCOUNTED;
      if (files.size === 0 && uncounted === 0) return null;
      return { files: [...files].map(([file, [added, removed]]) => [file, added, removed] as const), uncounted };
    },
  };
}

/** One file of a patch text: its lines, or `null` lines when the text does not hold them (a deleted file). */
export interface PatchFile {
  path: string;
  lines: { added: number; removed: number } | null;
}

/**
 * The files of an apply_patch text (`*** Begin Patch`, then `*** Add File:` / `*** Update File:` (with an optional
 * `*** Move to:`) / `*** Delete File:` sections, then `*** End Patch`), read strictly line by line without regular
 * expressions; null when the text is too long, cut short (no `*** End Patch` at the end) or has a line no section allows.
 */
export function parsePatchText(text: string): PatchFile[] | null {
  if (text.length > MAX_PATCH_CHARS) return null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let first = 0;
  while (first < lines.length && lines[first]!.trim() === "") first++;
  let last = lines.length - 1;
  while (last >= first && lines[last]!.trim() === "") last--;
  if (last <= first || lines[first]!.trim() !== "*** Begin Patch" || lines[last]!.trim() !== "*** End Patch") return null;
  const files: PatchFile[] = [];
  let current: (PatchFile & { kind: "add" | "update" | "delete"; moved: boolean }) | null = null;
  const header = (line: string, prefix: string): string | null => {
    if (!line.startsWith(prefix)) return null;
    const path = line.slice(prefix.length).trim();
    return path || null;
  };
  for (let index = first + 1; index < last; index++) {
    const line = lines[index]!;
    const added = header(line, "*** Add File: ");
    const deleted = header(line, "*** Delete File: ");
    const updated = header(line, "*** Update File: ");
    if (added !== null || deleted !== null || updated !== null) {
      if (files.length >= MAX_CALL_FILES) return null;
      current = added !== null
        ? { path: added, kind: "add", lines: { added: 0, removed: 0 }, moved: false }
        : deleted !== null
          ? { path: deleted, kind: "delete", lines: null, moved: false }
          : { path: updated!, kind: "update", lines: { added: 0, removed: 0 }, moved: false };
      files.push(current);
      continue;
    }
    if (line.startsWith("*** ")) {
      const moveTo = header(line, "*** Move to: ");
      if (moveTo !== null && current?.kind === "update" && !current.moved && current.lines!.added + current.lines!.removed === 0) {
        current.path = moveTo;
        current.moved = true;
        continue;
      }
      if (line.trim() === "*** End of File" && current?.kind === "update") continue;
      return null;
    }
    if (!current) {
      if (line.trim() === "") continue;
      return null;
    }
    if (current.kind === "delete") {
      if (line.trim() === "") continue;
      return null;
    }
    if (current.kind === "add") {
      if (line.startsWith("+")) current.lines!.added += 1;
      else if (line !== "") return null;
      continue;
    }
    // Update: hunk headers, context, added and removed lines.
    if (line.startsWith("@@") || line.startsWith(" ") || line === "") continue;
    if (line.startsWith("+")) current.lines!.added += 1;
    else if (line.startsWith("-")) current.lines!.removed += 1;
    else return null;
  }
  if (files.length === 0) return null;
  return files.map(({ path, lines }) => ({ path, lines }));
}

/** The raw text a patch call carries (`*** Begin Patch` …), looked up a few levels into its input; null when none. */
function patchTextOf(value: unknown): string | null {
  let current = value;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current === "string") {
      const start = current.trimStart();
      if (start.startsWith("*** Begin Patch")) return current;
      if (!start.startsWith("{") || current.length > MAX_PATCH_CHARS) return null;
      try {
        current = JSON.parse(current);
      } catch {
        return null;
      }
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    const record = current as Record<string, unknown>;
    current = record.input ?? record.patch ?? record.patchText;
  }
  return null;
}

/** A patch call: every file when the whole patch is known, else one change without line counts. */
function patchChanges(item: ToolLike, cwd: string | null | undefined): CallChanges | null {
  const changes = collector(cwd);
  // OpenCode's patch tool: one entry per file, each with its own diff.
  const fromMetadata = extractApplyPatchEdits(undefined, undefined, item.metadata);
  if (fromMetadata.length > 0) {
    if (fromMetadata.length > MAX_CALL_FILES) return ONE_UNCOUNTED;
    for (const edit of fromMetadata) {
      if (!edit.unifiedDiff.trim() || edit.unifiedDiff.length > MAX_DIFF_CHARS || isHostTruncatedDiff(edit.unifiedDiff)) {
        changes.skip();
        continue;
      }
      const stats = diffStatsFromUnifiedDiff(edit.unifiedDiff);
      changes.add(edit.filePath, stats.additions, stats.deletions);
    }
    return changes.result() ?? ONE_UNCOUNTED;
  }
  // The patch text itself, read strictly.
  const text = item.detail?.type === "unknown" ? patchTextOf(item.detail.input) : null;
  const files = text === null ? null : parsePatchText(text);
  if (!files) return ONE_UNCOUNTED;
  for (const file of files) {
    if (file.lines) changes.add(file.path, file.lines.added, file.lines.removed);
    else changes.skip();
  }
  return changes.result() ?? ONE_UNCOUNTED;
}

/**
 * Lines a finished call added and removed per file, and its changes whose lines are not known; null when it is not a
 * change (not finished, not an edit, write or patch, or an edit that changed nothing). `normalized`: the call's detail
 * after `withMetadataEditDiff` and `normalizeToolCallDetail`, when the caller has it already.
 */
export function toolChanges(item: ToolLike, cwd?: string | null, normalized?: ToolCallDetail): CallChanges | null {
  if (item.status !== "completed") return null;
  if (isApplyPatchTool(item.name)) return patchChanges(item, cwd);
  const detail = normalized ?? normalizeToolCallDetail(withMetadataEditDiff(item).detail, item.name);
  if (detail.type === "write") return ONE_UNCOUNTED;
  if (detail.type !== "edit" || !detail.filePath) return null;
  if (!hasEditDiffContent(detail)) return ONE_UNCOUNTED;
  const stats = exactDiffStatsForDetail(detail);
  if (!stats) return ONE_UNCOUNTED;
  if (stats.additions + stats.deletions === 0) return null;
  return { files: [[fileId(detail.filePath, cwd), stats.additions, stats.deletions]], uncounted: 0 };
}

/** A failed command's exit code when the call reports one, else null (also for every other kind of call). */
export function toolExitCode(item: ToolLike, normalized?: ToolCallDetail): number | null {
  if (item.status !== "failed") return null;
  const detail = normalized ?? normalizeToolCallDetail(item.detail, item.name);
  if (detail.type !== "shell") return null;
  return exitCodeOf(detail, formatError(item.error));
}

/** The first line of a command, as the expanded summary lists a failed one. */
export function commandHead(command: string): string {
  const text = command.trim();
  const end = text.indexOf("\n");
  return (end < 0 ? text : text.slice(0, end)).trim();
}
