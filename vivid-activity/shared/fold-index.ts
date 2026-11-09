import { defineRpc } from "@getpaseo/plugin";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import { MAX_CALL_FILES, toolChanges, toolExitCode, type CallChanges } from "./changes";
import { reasoningKey, toolKey, type IndexRow, type StepStatus } from "./fold";
import { comparableResult, isForegroundNotice, noticeLook, readTaskNotice, rowResultText, TASK_NOTICE_TOOL, type ComparableResult } from "./notice";
import { piNoticeStatus, readPiNotice } from "./pi-notice";
import { extractApplyPatchEdits, isApplyPatchTool, normalizeToolCallDetail, resolveToolCallPresentation, withMetadataEditDiff } from "./presentation";
import { pluginCardOf } from "./plugin-cards";
import { TURN_TIME_RENDERER_KIND } from "./turn-time";
import { lookFor, type LookKey } from "./vivid-model";

/**
 * 本地补丁：折叠用的时间线索引。插件服务端在 daemon 本机读 Agent 的投影时间线（`timeline.refetch`），只回传每条的
 * 位置、时间、种类、折叠键、状态和类别，不回传工具输出——手机经 relay 时一页只有几 KB。
 */
const cursorSchema = z.object({ epoch: z.string().min(1).max(200), seq: z.number().int().nonnegative() });

export const LOOK_KEYS = [
  "think", "read", "list", "edit", "write", "shell", "search", "web", "browser", "agent", "plan", "mcp", "paseo", "ask", "skill", "other",
] as const satisfies readonly LookKey[];

const TEXT_LINES_CAP = 999;
/** About how many lines a text takes in the chat (40 characters a line, every line break a line); at most TEXT_LINES_CAP. */
export function textLines(text: string): number {
  let lines = 0;
  let start = 0;
  // Only counts: a huge text stops at the cap without splitting the whole string.
  while (start <= text.length && lines < TEXT_LINES_CAP) {
    const end = text.indexOf("\n", start);
    const length = (end < 0 ? text.length : end) - start;
    lines += Math.max(1, Math.ceil(length / 40));
    if (end < 0) break;
    start = end + 1;
  }
  return Math.min(TEXT_LINES_CAP, Math.max(1, lines));
}

/** Wire form of an IndexRow (short keys: a few hundred rows per page). */
export const wireRowSchema = z.object({
  s: z.number().int().nonnegative(),
  /** seqEnd when it differs from s (the entry was updated after it began). */
  e: z.number().int().nonnegative().optional(),
  at: z.number().nonnegative(),
  k: z.enum(["r", "t", "b", "x"]),
  key: z.string().max(400).optional(),
  st: z.enum(["running", "completed", "failed", "canceled"]).optional(),
  look: z.enum(LOOK_KEYS).optional(),
  ref: z.string().max(400).optional(),
  fg: z.boolean().optional(),
  w: z.string().max(40).optional(),
  /** Index of the entry's turn in the page's `turns` table (0.3.0-local.3). */
  u: z.number().int().nonnegative().optional(),
  /** 0.6.0: about how many lines an Agent's text takes (shared/prompt-pin.ts measures how far the question is). */
  ln: z.number().int().min(1).max(TEXT_LINES_CAP).optional(),
  /** 0.8.0: lines a finished call added and removed per file, [file id (a short hash of its path), added, removed] (shared/changes.ts). */
  ch: z.array(z.tuple([z.string().min(1).max(16), z.number().int().nonnegative(), z.number().int().nonnegative()])).min(1).max(MAX_CALL_FILES).optional(),
  /** 0.8.0: changes of the call whose lines are not known (a write, a deletion, a diff cut short, a patch Paseo kept only part of). */
  nc: z.number().int().min(1).max(MAX_CALL_FILES).optional(),
  /** 0.8.0: a failed command's exit code, when it reports one. */
  x: z.number().int().optional(),
});
export type WireRow = z.output<typeof wireRowSchema>;

/** A turn of the page: Paseo's `turnId` and its start when the plugin server knows it (`turn_started`, `activeTurn`). */
const turnSchema = z.object({ id: z.string().min(1).max(200), at: z.number().nonnegative().nullable() });
export type WireTurn = z.output<typeof turnSchema>;

const tokenCount = z.number().int().nonnegative();
/**
 * 0.8.0: the tokens of one turn the plugin server watched live (server/turn-usage.ts): fresh input, cache reads (null when
 * the provider does not say) and output. `live`: the turn is still running and the figures still grow.
 */
const turnTokensSchema = z.object({ id: z.string().min(1).max(200), i: tokenCount, c: tokenCount.nullable(), o: tokenCount, live: z.boolean().optional() });
export type WireTurnTokens = z.output<typeof turnTokensSchema>;
/** Most turns one answer reports tokens for. */
export const MAX_TOKEN_TURNS = 8;

export const foldIndexRpc = defineRpc({
  name: "fold-index",
  input: z.object({
    agentId: z.string().min(1).max(256),
    direction: z.enum(["tail", "after", "before"]),
    cursor: cursorSchema.nullable().optional(),
    limit: z.number().int().min(1).max(400).optional(),
  }),
  output: z.object({
    /** missing: the daemon has no such Agent (a provider subagent's own view, say); asking again will not help. */
    status: z.enum(["ok", "unavailable", "missing"]),
    epoch: z.string(),
    rows: z.array(wireRowSchema),
    startCursor: cursorSchema.nullable(),
    endCursor: cursorSchema.nullable(),
    hasOlder: z.boolean(),
    hasNewer: z.boolean(),
    /** The cursor was stale or the history was replaced: drop what you have and read the tail again. */
    reset: z.boolean(),
    /** The Agent's turn is running (from the snapshot that came with the page); null when unknown. */
    running: z.boolean().nullable(),
    /** The daemon's clock when it answered: live timers run on daemon time. */
    now: z.number().nonnegative().optional(),
    /** Turns of the rows (`u` indexes into it). */
    turns: z.array(turnSchema).max(1000).optional(),
    /** The turn running now, from the Agent snapshot; null when none is. */
    active: turnSchema.nullable().optional(),
    /** 0.8.0: tokens of the page's turns and the latest ones, where the server watched them live. */
    tok: z.array(turnTokensSchema).max(MAX_TOKEN_TURNS).optional(),
  }),
});
export type FoldIndexInput = z.input<typeof foldIndexRpc.input>;
export type FoldIndexOutput = z.output<typeof foldIndexRpc.output>;

type ToolItem = {
  type: "tool_call";
  callId: string;
  name: string;
  status: StepStatus;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
};

/**
 * Tool calls this plugin leaves to others, mirroring `client/transform.ts`: plans (Paseo's approval cards), the `speak`
 * shape Paseo renders as a spoken message, Paseo's own agent messages, and (0.5.0) the calls Bots turns into cards
 * (shared/plugin-cards.ts).
 */
export function claimsToolCall(item: { name: string; callId?: unknown; status?: unknown; detail?: { type?: unknown; input?: unknown } | null }): boolean {
  return disclaimed(item) === null;
}

/** Why the plugin leaves a tool call alone (the boundary kind the fold index records), or null when it draws it. */
function disclaimed(item: { name: string; callId?: unknown; status?: unknown; detail?: { type?: unknown; input?: unknown } | null }): string | null {
  if (item.detail?.type === "plan") return "plan";
  if (item.name === "speak" && item.detail?.type === "unknown" && typeof item.detail.input === "string" && item.detail.input.trim()) return "speak";
  // A report or finish notice from another agent (Paseo 0.13 delivers several together): Paseo's own row says who sent it
  // and why (finished, errored, waiting for approval), which a takeover loses, since the host keeps that part to itself.
  if (item.name === "agent_message" && typeof item.callId === "string" && item.callId.startsWith("paseo-agent-message:")) return "agent-message";
  // A schedule or heartbeat prompt: Paseo 0.14 records it as this row (0.13 dropped it), and the app starts a turn on it
  // (turn folding, history paging). Taken over, its turn would merge into the previous one.
  if (item.name === "heartbeat" && typeof item.callId === "string" && item.callId.startsWith("paseo-system:")) return "heartbeat";
  return pluginCardOf(item);
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
function isTodoInput(input: unknown): boolean {
  const todos = (input as { todos?: unknown } | null)?.todos;
  return Array.isArray(todos) && todos.every((todo) => {
    const entry = todo as { content?: unknown; status?: unknown } | null;
    return typeof entry?.content === "string" && TODO_STATUSES.has(String(entry.status));
  });
}
function isPlanInput(input: unknown): boolean {
  const plan = (input as { plan?: unknown } | null)?.plan;
  return Array.isArray(plan) && plan.every((step) => typeof (step as { step?: unknown } | null)?.step === "string");
}

/**
 * How Paseo 0.11.1 shows a tool call before any plugin sees it (`reduceTimelineToolCall`): task-list tools become the
 * native task rows (a boundary), Claude's TaskCreate/TaskUpdate/TaskList and unparsable Claude TodoWrite vanish (skip).
 * `provider` is the Agent's provider id. The host compares it with the literal built-in id "claude", so a custom provider
 * that extends claude is not special-cased by the host either; mirroring that keeps the fold index in step with what is
 * actually on screen. This is not a configuration default.
 */
export function hostToolDisposition(provider: string, item: { name: string; detail?: { type?: unknown; input?: unknown } | null }): "task" | "skip" | null {
  const name = item.name.trim().replace(/[.\s-]+/g, "_").toLowerCase();
  const input = item.detail?.type === "unknown" ? item.detail.input : null;
  const todo = name === "todowrite" || name === "todo_write";
  if (provider === "claude" && todo) return isTodoInput(input) ? "task" : "skip";
  if (provider === "claude" && (name === "taskcreate" || name === "taskupdate" || name === "tasklist")) return "skip";
  if (todo && isTodoInput(input)) return "task";
  if (name === "update_plan" && isPlanInput(input)) return "task";
  return null;
}

/**
 * 0.4.1: the most a tool call may hold (text of its detail and metadata, plus one per value) to be classified. The index
 * of an Agent on screen is read again every 15 s, and a bigger call would be parsed again each time; it is counted as
 * "other" instead. Ordinary calls stay far below it (Claude Code reads files up to 256 KB, MCP results stop near 100 000
 * characters), so this only changes the count in a fold summary for a call of more than a million characters.
 */
export const MAX_CLASSIFY_CHARS = 1_000_000;

/** Whether `value` holds more than `budget` characters of strings and keys, counting one per value. Stops once it does. */
export function exceedsTextBudget(value: unknown, budget: number): boolean {
  let left = budget - 1;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    if (left < 0) return true;
    const next = stack.pop();
    if (typeof next === "string") {
      left -= next.length;
    } else if (Array.isArray(next)) {
      for (const item of next) {
        if (--left < 0) return true;
        stack.push(item);
      }
    } else if (next !== null && typeof next === "object") {
      for (const key in next) {
        left -= key.length + 1;
        if (left < 0) return true;
        stack.push((next as Record<string, unknown>)[key]);
      }
    }
  }
  return left < 0;
}

/** The row look the client draws for a tool call (apply_patch rows draw as edits). */
export function toolLook(item: Pick<ToolItem, "name" | "detail" | "metadata">): LookKey {
  return toolFacts(item).look;
}

/**
 * The look of a tool call, and (0.8.0) the lines it changed per file and a failed command's exit code (shared/changes.ts).
 * The detail is normalized once for all three, after `withMetadataEditDiff` as the row itself does (createToolCallData).
 */
export function toolFacts(item: Pick<ToolItem, "name" | "detail" | "metadata"> & { status?: string; error?: unknown }, cwd?: string | null): { look: LookKey; changes: CallChanges | null; exit: number | null } {
  const notice = readTaskNotice(item);
  if (notice) return { look: noticeLook(notice.kind), changes: null, exit: null };
  const pi = readPiNotice(item);
  if (pi) return { look: pi.look, changes: null, exit: null };
  if (isApplyPatchTool(item.name)) {
    const edits = extractApplyPatchEdits(item.detail, item.detail?.type === "unknown" ? item.detail.output : undefined, item.metadata);
    if (edits.length > 0) return { look: edits.every((edit) => edit.operation === "add") ? "write" : "edit", changes: toolChanges(item, cwd), exit: null };
  }
  const detail = normalizeToolCallDetail(withMetadataEditDiff(item).detail, item.name);
  return {
    look: lookFor(item.name, detail, resolveToolCallPresentation({ name: item.name, detail })),
    changes: toolChanges(item, cwd, detail),
    exit: toolExitCode(item, detail),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * One projected timeline entry → its wire row. `rowResult` gives the final result of a tool row of the same page by call
 * id, as compared (`wirePageFromEntries`), so a notice that repeats the result its row already shows folds into that row.
 */
export function wireRowFromEntry(entry: unknown, rowResult?: (callId: string) => ComparableResult | null | undefined, cwd?: string | null): WireRow | null {
  const source = record(entry);
  const item = record(source.item);
  const type = typeof item.type === "string" ? item.type : null;
  const seq = typeof source.seqStart === "number" ? source.seqStart : null;
  if (type === null || seq === null || !Number.isInteger(seq) || seq < 0) return null;
  const parsedAt = typeof source.timestamp === "string" ? Date.parse(source.timestamp) : NaN;
  const at = Number.isFinite(parsedAt) && parsedAt > 0 ? parsedAt : 0;
  const seqEnd = typeof source.seqEnd === "number" && Number.isInteger(source.seqEnd) && source.seqEnd > seq ? source.seqEnd : null;
  // The plugin's own turn-end time row (server/turn-time.ts) is not part of the index at all: it is appended after the
  // turn ended, and the host may commit it among the next turn's rows. As a boundary it would split that turn's steps;
  // as a timed row of another turn it would shift that turn's timing. Leaving it out keeps the folds and timing exactly
  // as they are without the row, wherever it lands, also for rows written before this and after the switch is off.
  if (type === "plugin" && item.kind === TURN_TIME_RENDERER_KIND) return null;
  const base = { s: seq, ...(seqEnd !== null ? { e: seqEnd } : {}), at };
  if (type === "reasoning") {
    return typeof item.text === "string" ? { ...base, k: "r", key: reasoningKey(item.text) } : { ...base, k: "b", w: "reasoning" };
  }
  if (type === "assistant_message" && typeof item.text === "string") return { ...base, k: "b", w: type, ln: textLines(item.text) };
  if (type !== "tool_call") return { ...base, k: "b", w: type.slice(0, 40) };
  const tool = item as unknown as ToolItem;
  if (typeof tool.callId !== "string" || typeof tool.name !== "string") return { ...base, k: "b", w: "tool" };
  const provider = typeof source.provider === "string" ? source.provider : "";
  const host = hostToolDisposition(provider, tool);
  if (host === "skip") return { ...base, k: "x", w: "hidden-tool" };
  if (host === "task") return { ...base, k: "b", w: "task" };
  const other = disclaimed(tool);
  if (other !== null) return { ...base, k: "b", w: other };
  const notice = readTaskNotice(tool);
  const small = !exceedsTextBudget([tool.detail, tool.metadata], MAX_CLASSIFY_CHARS);
  // 0.6.0 (opus-B30): a Pi extension's notice counts as it ended (failed, stopped); events and reminders as finished.
  const pi = !notice && small ? readPiNotice(tool) : null;
  // 0.6.0: a notice's status is what Claude Code sent (the host records a stopped sub-agent as completed).
  const status: StepStatus = notice
    ? notice.status
    : pi
      ? piNoticeStatus(pi.state)
      : ["running", "completed", "failed", "canceled"].includes(tool.status) ? tool.status : "completed";
  let look: LookKey = pi ? pi.look : "other";
  let changes: CallChanges | null = null;
  let exit: number | null = null;
  if (small && !pi) {
    try {
      const facts = notice ? { look: noticeLook(notice.kind), changes: null, exit: null } : toolFacts(tool, cwd);
      look = facts.look;
      changes = facts.changes;
      exit = facts.exit;
    } catch {
      look = "other";
    }
  }
  return {
    ...base,
    k: "t",
    key: toolKey(tool.callId),
    st: status,
    look,
    ...(notice?.ref ? { ref: notice.ref } : {}),
    ...(notice ? { fg: isForegroundNotice(notice, notice.ref ? rowResult?.(notice.ref) : undefined) } : {}),
    ...(changes && changes.files.length > 0 ? { ch: changes.files.map(([file, added, removed]): [string, number, number] => [file, added, removed]) } : {}),
    ...(changes && changes.uncounted > 0 ? { nc: Math.min(changes.uncounted, MAX_CALL_FILES) } : {}),
    ...(exit !== null ? { x: exit } : {}),
  };
}

/**
 * 0.6.0-local.3: the final results of this page's tool rows that a notice with a result of its own repeats, by call id.
 * A row on an earlier page is not known here; its notice then stands on its own (nothing is lost). 0.6.0-local.4
 * (codex-vivid-F7): each row's result is read for comparing once per page, however many notices repeat it (400 notices
 * of one 200 000-character output read it 400 times, 3 s).
 */
function resultsForRepeats(entries: readonly unknown[]): Map<string, ComparableResult | null> {
  const wanted = new Set<string>();
  for (const entry of entries) {
    const item = record(record(entry).item);
    if (item.type !== "tool_call" || item.name !== TASK_NOTICE_TOOL) continue;
    const notice = readTaskNotice(item as unknown as ToolItem);
    if (notice?.kind === "repeat" && notice.ref && notice.result !== null) wanted.add(notice.ref);
  }
  const results = new Map<string, ComparableResult | null>();
  if (wanted.size === 0) return results;
  for (const entry of entries) {
    const item = record(record(entry).item);
    if (item.type === "tool_call" && typeof item.callId === "string" && wanted.has(item.callId) && item.status !== "running" && item.name !== TASK_NOTICE_TOOL) {
      results.set(item.callId, comparableResult(rowResultText(item)));
    }
  }
  return results;
}

/**
 * One page of projected entries → wire rows plus the table of their turns. `turnStart` gives the start the server knows
 * for a turn (null when unknown). `turnOf` names a row's turn from its turn id and when the row was written (a session
 * loaded again counts its turn ids from the start again, so the server tells those turns apart); the turn id by default.
 */
export function wirePageFromEntries(
  entries: readonly unknown[],
  turnStart: (turn: string) => number | null,
  cwd?: string | null,
  turnOf: (turnId: string, rowAt: number | null) => string = (turnId) => turnId,
): { rows: WireRow[]; turns: WireTurn[] } {
  const rows: WireRow[] = [];
  const turns: WireTurn[] = [];
  const index = new Map<string, number>();
  const results = resultsForRepeats(entries);
  for (const entry of entries) {
    const row = wireRowFromEntry(entry, (callId) => results.get(callId), cwd);
    if (!row) continue;
    const turnId = record(entry).turnId;
    const turn = typeof turnId === "string" && turnId ? turnOf(turnId, row.at > 0 ? row.at : null) : "";
    if (turn && turn.length <= 200) {
      let u = index.get(turn);
      if (u === undefined) {
        u = turns.length;
        index.set(turn, u);
        turns.push({ id: turn, at: turnStart(turn) });
      }
      row.u = u;
    }
    rows.push(row);
  }
  return { rows, turns };
}

/** Wire row → IndexRow (client). `turns`: the page's turn table. */
export function indexRowFromWire(row: WireRow, turns?: readonly WireTurn[]): IndexRow {
  const turn = row.u !== undefined ? turns?.[row.u]?.id : undefined;
  const kind = row.k === "r" ? "reasoning" : row.k === "t" ? "tool" : row.k === "x" ? "skip" : "boundary";
  return {
    seq: row.s,
    ...(row.e !== undefined ? { seqEnd: row.e } : {}),
    at: row.at,
    kind,
    ...(row.key ? { key: row.key } : {}),
    ...(row.st ? { status: row.st } : {}),
    ...(row.look ? { look: row.look } : {}),
    ...(row.fg !== undefined ? { notice: { ref: row.ref ?? null, foreground: row.fg } } : {}),
    ...(row.w ? { what: row.w } : {}),
    ...(row.ln !== undefined ? { lines: row.ln } : {}),
    ...(turn ? { turn } : {}),
    ...(row.ch ? { changes: row.ch.map(([file, added, removed]) => ({ file, added, removed })) } : {}),
    ...(row.nc ? { uncounted: row.nc } : {}),
    ...(row.x !== undefined ? { exit: row.x } : {}),
  };
}
