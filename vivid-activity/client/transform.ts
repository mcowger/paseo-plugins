import { onTextChange } from "../shared/i18n";
import type { PluginTimelineTransformResult } from "@getpaseo/plugin";
import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import type { ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import { HIDE, reasoningKey, SHOW, toolKey, type FoldRole } from "../shared/fold";
import { claimsToolCall } from "../shared/fold-index";
import { comparableResult, isForegroundNotice, readTaskNotice, rowResultText, type ComparableResult } from "../shared/notice";
import { isPiNotice } from "../shared/pi-notice";
import {
  createReasoningData,
  createToolCallData,
  FOLD_RENDERER_KIND,
  hasPiNoticeReader,
  setPiNoticePhase,
  setPiNoticeReader,
  type PiNoticeReader,
  type PiNoticeReaderPhase,
  FOLD_RENDERER_VERSION,
  REASONING_RENDERER_KIND,
  REASONING_RENDERER_VERSION,
  TOOL_CALL_RENDERER_KIND,
  TOOL_CALL_RENDERER_VERSION,
} from "../shared/timeline";
import { extractApplyPatchEdits, isApplyPatchTool } from "../shared/presentation";
import { foldRuntime } from "./fold-runtime";

type ReasoningTransformer = PluginTimelineTransformerContribution<"reasoning">["transform"];
type ToolCallTransformer = PluginTimelineTransformerContribution<"tool_call">["transform"];
type ToolCallItem = Extract<ToolCallTimelineItem, { type: "tool_call" }>;

// 本地补丁：不再注册 todo 转换器，任务清单交还 Paseo。0.11 把 Claude Code 的 TodoWrite 变成
// 「已创建/已添加/已完成」一行一事件的原生任务行；上游 HEAD 返回空数组会把它们整条吞掉，审核版则每次重复整张清单。

/**
 * 本地补丁：折叠。Paseo 每次重新投影都会把每一行再交给转换器；已结束的行内容不会再变，按内容指纹缓存转换结果，
 * 长对话重投影时省掉一半时间（实测 464 行 17 → 8.5 ms）。运行中的行不缓存。
 */
const MEMO_LIMIT = 1500;
const memo = new Map<string, PluginTimelineTransformResult>();
// Completed projections contain display text; rebuild them after a catalog change.
onTextChange(() => memo.clear());
function remember(key: string, build: () => PluginTimelineTransformResult): PluginTimelineTransformResult {
  const cached = memo.get(key);
  if (cached) return cached;
  const value = build();
  memo.set(key, value);
  if (memo.size > MEMO_LIMIT) {
    let drop = MEMO_LIMIT / 2;
    for (const old of memo.keys()) {
      if (drop-- <= 0) break;
      memo.delete(old);
    }
  }
  return value;
}

/** Cheap content fingerprint (two levels, strings by length and edges): tells two finished rows with one call id apart. */
export function fingerprint(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "_";
  if (typeof value === "string") return `${value.length}:${value.slice(0, 24)}${value.length > 32 ? value.slice(-8) : ""}`;
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return depth >= 2 ? `a${value.length}` : `[${value.map((entry) => fingerprint(entry, depth + 1)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>);
  if (depth >= 2) return `o${entries.length}`;
  return `{${entries.map(([key, entry]) => `${key}=${fingerprint(entry, depth + 1)}`).join(";")}}`;
}

/**
 * Applies the row's fold role: hidden rows vanish (no host spacing either), a segment's first row becomes its summary.
 * `record: false` leaves the key out of the drawn keys (0.5.0: streaming reasoning, whose key changes with every
 * chunk; recording each one filled the bounded set of drawn keys with keys nothing would ask about again).
 */
function withRole(key: string, live: boolean, normal: () => PluginTimelineTransformResult, record = true): PluginTimelineTransformResult {
  // Live rows are never folded away, whatever an index that lags behind says.
  const role: FoldRole = live ? SHOW : foldRuntime.roleFor(key);
  if (record) foldRuntime.markProjected(key, role);
  if (role.kind === "hide") return { items: [] };
  if (role.kind === "fold") {
    const fold = { type: "plugin" as const, kind: FOLD_RENDERER_KIND, version: FOLD_RENDERER_VERSION, data: { ...role.summary } };
    return { items: role.summary.expanded ? [fold, ...normal().items] : [fold] };
  }
  return normal();
}

export const transformReasoning: ReasoningTransformer = ({ item, phase }) => {
  const build = () => ({
    items: [
      {
        type: "plugin" as const,
        kind: REASONING_RENDERER_KIND,
        version: REASONING_RENDERER_VERSION,
        data: createReasoningData(item, phase),
      },
    ],
  });
  const key = reasoningKey(item.text);
  const streaming = phase === "streaming";
  return withRole(key, streaming, () => (streaming ? build() : remember(`r|${key}|${item.text.slice(0, 64)}`, build)), !streaming);
};

function transformApplyPatch(item: ToolCallItem) {
  const edits = extractApplyPatchEdits(
    item.detail,
    item.detail.type === "unknown" ? item.detail.output : undefined,
    item.metadata,
  );
  if (edits.length === 0) return undefined;

  return {
    items: edits.map((edit, index) => {
      const data = createToolCallData({
        ...item,
        name: "apply_patch",
        detail: {
          type: "edit",
          filePath: edit.filePath,
          unifiedDiff: edit.unifiedDiff,
        },
      });
      const label = edit.operation === "add" ? "Add" : edit.operation === "delete" ? "Delete" : "Edit";
      return {
        type: "plugin" as const,
        id: `${item.callId}:apply-patch:${index}`,
        kind: TOOL_CALL_RENDERER_KIND,
        version: TOOL_CALL_RENDERER_VERSION,
        data: {
          ...data,
          ...(index > 0 ? { part: index } : {}),
          presentation: { ...data.presentation, label },
        },
      };
    }),
  };
}

function toolRows(item: ToolCallItem): PluginTimelineTransformResult {
  if (isApplyPatchTool(item.name)) {
    const transformed = transformApplyPatch(item);
    if (transformed) return transformed;
  }
  return {
    items: [
      {
        type: "plugin",
        kind: TOOL_CALL_RENDERER_KIND,
        version: TOOL_CALL_RENDERER_VERSION,
        data: createToolCallData(item),
      },
    ],
  };
}

/**
 * 0.6.0-local.3: finished tool rows by key, newest kept, so a later notice can tell whether it only repeats one of them
 * (Paseo hands a transformer one item at a time). 0.6.0-local.4 (codex-vivid-F7): with the row's result as compared, read
 * once for all the notices that repeat it, and again only when the row's result changes.
 */
type FinishedRow = { item: ToolCallItem; compared?: { raw: string | null; result: ComparableResult | null } };
const finishedRows = new Map<string, FinishedRow>();
const FINISHED_ROWS_LIMIT = 500;
function rememberFinished(key: string, item: ToolCallItem): void {
  const known = finishedRows.get(key);
  finishedRows.delete(key);
  finishedRows.set(key, { item, compared: known?.compared });
  if (finishedRows.size <= FINISHED_ROWS_LIMIT) return;
  let drop = finishedRows.size - FINISHED_ROWS_LIMIT / 2;
  for (const old of finishedRows.keys()) {
    if (drop-- <= 0) break;
    finishedRows.delete(old);
  }
}

/**
 * 0.6.0-local.5: Pi notice rows need the Pi notice reader from its own lazy chunk (shared/timeline.ts). The first such row
 * asks for it; meanwhile the rows are neutral 「正在读取」 rows, and when it arrives every row is drawn again with it (cached
 * transforms dropped, then `redraw`).
 * codex-vivid-merge-F2: a failed download draws them as neutral 「没能读取」 rows with the message as sent, never as ordinary
 * tool rows (the host marks every Pi custom message completed). The download is tried again by itself after 30 s, 1, 2
 * and then every 5 minutes while the plugin runs, whether or not another Pi row is drawn, and at once from a row's
 * 「重新读取」 (`retryPiNotices`).
 */
interface PiNoticeLoader {
  load(): Promise<PiNoticeReader>;
  redraw(): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}
const PI_READER_RETRY_MS = [30_000, 60_000, 120_000, 300_000];
let piLoader: PiNoticeLoader | null = null;
let piPhase: PiNoticeReaderPhase = "idle";
let piLoading = false;
let piFailures = 0;
let piRetry: unknown = null;
function stopPiRetry(loader: PiNoticeLoader | null): void {
  if (piRetry === null) return;
  if (loader?.clearTimer) loader.clearTimer(piRetry);
  else clearTimeout(piRetry as ReturnType<typeof setTimeout>);
  piRetry = null;
}
/** Rows drawn from now on say this; with `redraw`, the rows already drawn too. */
function showPiPhase(phase: PiNoticeReaderPhase, loader: PiNoticeLoader | null): void {
  if (piPhase === phase) return;
  piPhase = phase;
  setPiNoticePhase(phase);
  if (!loader) return;
  memo.clear();
  loader.redraw();
}
export function configurePiNotices(loader: PiNoticeLoader | null): void {
  stopPiRetry(piLoader);
  piLoader = loader;
  piLoading = false;
  piFailures = 0;
  showPiPhase("idle", null);
}
function loadPiReader(loader: PiNoticeLoader): void {
  piLoading = true;
  loader.load().then(
    (reader) => {
      if (piLoader !== loader) return;
      piLoading = false;
      piFailures = 0;
      setPiNoticeReader(reader);
      memo.clear();
      loader.redraw();
    },
    () => {
      if (piLoader !== loader) return;
      piLoading = false;
      const wait = PI_READER_RETRY_MS[Math.min(piFailures, PI_READER_RETRY_MS.length - 1)]!;
      piFailures += 1;
      const retry = () => {
        piRetry = null;
        if (piLoader === loader && !piLoading && !hasPiNoticeReader()) loadPiReader(loader);
      };
      piRetry = loader.setTimer ? loader.setTimer(retry, wait) : setTimeout(retry, wait);
      // A retry of its own keeps the rows as they are (「没能读取」) until it succeeds.
      showPiPhase("failed", loader);
    },
  );
}
function askForPiReader(): void {
  const loader = piLoader;
  // After a failure the retry timer, or a row's 「重新读取」, asks again.
  if (!loader || piLoading || hasPiNoticeReader() || piFailures > 0) return;
  // The row being drawn now is the first to say so; no other row needs drawing again.
  showPiPhase("loading", null);
  loadPiReader(loader);
}
/** 0.6.0-local.5 (codex-vivid-merge-F2): a Pi notice row's 「重新读取」: try the download again now. */
export function retryPiNotices(): void {
  const loader = piLoader;
  if (!loader || piLoading || hasPiNoticeReader()) return;
  stopPiRetry(loader);
  showPiPhase("loading", loader);
  loadPiReader(loader);
}

/** 0.8.0: the finished tool call last drawn for `key` (an expanded fold summary names its file or command); null when not kept. */
export function finishedToolItem(key: string): ToolCallItem | null {
  return finishedRows.get(key)?.item ?? null;
}

function finishedResult(key: string): ComparableResult | null {
  const row = finishedRows.get(key);
  if (!row) return null;
  const raw = rowResultText(row.item);
  if (row.compared?.raw !== raw) row.compared = { raw, result: comparableResult(raw) };
  return row.compared.result;
}

export const transformToolCall: ToolCallTransformer = ({ item }) => {
  // 本地补丁：计划（Claude ExitPlanMode / plan_approval 等 detail.type === "plan"）交给 Paseo 的
  // 审批卡和「已批准/已拒绝的计划」卡。接管会在审批时重复显示一份原始 Markdown，批准后丢掉结果标记。
  // Paseo renders the `speak` shape as a SpeakMessage, not an ordinary tool card.
  if (!claimsToolCall(item)) return undefined;
  const key = toolKey(item.callId);
  // 本地补丁：前台调用的任务通知只是把那一行重复一遍时，折进那一行。0.6.0-local.3：通知自带结果时，只在那一行已经显示了
  // 这个结果时才折。0.6.0-local.4：只认「读起来相同」（shared/notice.ts comparableResult），不再认「包含」；那一行只有占位、
  // 内容不同、超过比较上限或还没见过，就单独成行，不丢结果。
  const notice = readTaskNotice(item);
  if (notice?.kind === "repeat" && notice.ref !== null) {
    const ref = toolKey(notice.ref);
    const merged = foldRuntime.hasSeen(ref) && isForegroundNotice(notice, finishedResult(ref));
    foldRuntime.noteNotice(key, merged);
    if (merged) {
      foldRuntime.markProjected(key, HIDE);
      return { items: [] };
    }
  }
  if (!notice && !hasPiNoticeReader() && isPiNotice(item)) askForPiReader();
  const running = item.status === "running";
  if (!running && !notice) rememberFinished(key, item);
  return withRole(key, running, () =>
    running
      ? toolRows(item)
      : remember(`t|${key}|${item.status}|${item.name}|${fingerprint(item.detail)}|${fingerprint(item.error)}|${fingerprint(item.metadata)}`, () => toolRows(item)),
  );
};

/**
 * 本地补丁：观察 Agent 文字、用户消息、任务行等「段的边界」。不接管（返回 undefined），只提醒折叠索引读一次增量：
 * 一段工具行后面来了文字，这段就结束了，可以折叠。
 */
/** A boundary's first appearance and completion matter; intermediate stream chunks and re-projections do not. */
const boundaries = new Map<string, "streaming" | "complete">();
export function observeBoundary(input?: { item: { type: string; messageId?: string; [key: string]: unknown }; phase: "streaming" | "complete" }): undefined {
  if (!input) return undefined;
  // Message rows have stable messageIds. Other supported boundaries normally arrive complete; if a host streams one
  // without an id, coalesce its stream by type and still observe its completed content separately.
  const key = `${input.item.type}|${input.item.messageId ?? (input.phase === "streaming" ? "stream" : fingerprint(input.item))}`;
  const previous = boundaries.get(key);
  if (previous === "complete" || previous === input.phase) return undefined;
  boundaries.set(key, input.phase);
  if (boundaries.size > MEMO_LIMIT) boundaries.delete(boundaries.keys().next().value!);
  foldRuntime.poke();
  return undefined;
}

/** Item types Paseo 0.11.1 lets a transformer watch besides ours (it rejects "notification" and "plugin"; 0.13 accepts "notification", see index.client.tsx). */
export const BOUNDARY_ITEM_TYPES = ["assistant_message", "user_message", "todo", "error", "compaction"] as const;
