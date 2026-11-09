import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { FoldPlan, IndexRow } from "./fold";

/**
 * 0.6.0（grok-B2，借鉴 lyhu/paseo-plugin-chat-view 的「提问吸顶」思路，代码是自己写的）：长对话里，把你这一轮问的话钉在
 * 活动区上方。chat-view 靠网页 DOM 做吸顶，原生 App 用不了；Paseo 也不把时间线的滚动位置交给插件。所以这里不吸顶，
 * 而是把提问画在「最新一段活动」的第一行上方：Agent 干了很久、中间说过几段话之后，你在底部看最新动态时，问题就在
 * 眼前，不用往上翻。默认显示三行，点开看全文，可以复制。
 *
 * 什么时候钉：只钉最新一段，并且提问离它够远，大概已经滚出一屏：中间隔着至少 PIN_MIN_BLOCKS 块。一段连续的思考和工具行
 * 算一块（不管几行，完成后它收成一行），Agent 的一段文字按长度算（每 TEXT_LINES_PER_BLOCK 行一块，至少一块），别的卡片
 * 算一块。提问就在附近时不重复；提问早于插件读到的那页索引时算够远。
 */
export const PIN_MIN_BLOCKS = 6;
const TEXT_LINES_PER_BLOCK = 8;
/** An Agent text whose length the index does not know counts as this many lines. */
const DEFAULT_TEXT_LINES = 2;

/** How far the question is from `start` (the newest segment's first seq), in blocks (see above). */
function blocksBetween(rows: readonly IndexRow[], from: number, start: number): number {
  let blocks = 0;
  let inRun = false;
  for (let index = from; index < rows.length && rows[index]!.seq < start; index++) {
    const row = rows[index]!;
    if (row.kind === "skip") continue;
    if (row.kind === "tool" || row.kind === "reasoning") {
      if (!inRun) blocks += 1;
      inRun = true;
      continue;
    }
    inRun = false;
    blocks += row.what === "assistant_message" ? Math.max(1, Math.ceil((row.lines ?? DEFAULT_TEXT_LINES) / TEXT_LINES_PER_BLOCK)) : 1;
  }
  return blocks;
}

/** Where the pinned question goes: above the row drawn for `key` (the segment's summary row when `fold`). */
export interface PromptPin {
  /** First row of the newest segment that is on screen. */
  key: string;
  /** The segment (its first row's seq), for the summary row that stands for it. */
  segment: string;
  /** The summary row is what is drawn for `key`. */
  fold: boolean;
  /** The question's seq, or null when it is older than the rows the index holds (the server looks it up). */
  promptSeq: number | null;
  /** The question opened the turn the segment belongs to (本轮提问), rather than an earlier one (Claude Code woke up on its own). */
  sameTurn: boolean;
  /** The segment's turn, to compare with a question looked up by the server (`promptSeq` null). */
  turn: string | null;
}

/**
 * Where to pin the latest question of an Agent, from its index rows (seq order) and fold plan; null for no pin.
 * `drawn` tells which keys Paseo has drawn; `hasOlder`: the index does not reach the start of the history.
 */
export function promptPin(rows: readonly IndexRow[], plan: FoldPlan | null, options: { drawn: (key: string) => boolean; hasOlder: boolean }): PromptPin | null {
  if (!plan || plan.segments.length === 0) return null;
  let promptIndex = -1;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (row.kind === "boundary" && row.what === "user_message") {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex < 0 && !options.hasOlder) return null;
  const prompt = promptIndex >= 0 ? rows[promptIndex]! : null;
  const segment = plan.segments.at(-1)!;
  const start = Number(segment.id);
  if (prompt && start <= prompt.seq) return null;
  if (prompt && blocksBetween(rows, promptIndex + 1, start) < PIN_MIN_BLOCKS) return null;
  for (const key of segment.keys) {
    const role = plan.roles.get(key);
    if (role?.kind === "hide" || !options.drawn(key)) continue;
    const first = rows.find((row) => String(row.seq) === segment.id);
    return {
      key,
      segment: segment.id,
      fold: role?.kind === "fold",
      promptSeq: prompt ? prompt.seq : null,
      sameTurn: Boolean(prompt && first && prompt.turn !== undefined && prompt.turn === first.turn),
      turn: first?.turn ?? null,
    };
  }
  return null;
}

/** Whether two pins put the same question on the same row. */
export function samePin(left: PromptPin | null, right: PromptPin | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.key === right.key && left.segment === right.segment && left.fold === right.fold && left.promptSeq === right.promptSeq && left.sameTurn === right.sameTurn && left.turn === right.turn;
}

/** Lines the pinned question shows until tapped. */
export const PIN_COLLAPSED_LINES = 3;

const wide = (code: number) =>
  (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x1f300;

/**
 * About how many lines `text` takes at `width` px (CJK and emoji one em, the rest a little over half). Only used to
 * decide whether 「展开全部」 has more to show, so it errs towards more lines. Without a width, counts line breaks.
 */
export function estimateLines(text: string, width: number, fontSize: number): number {
  const lines = text.split("\n");
  if (!(width > 0)) return lines.length;
  let count = 0;
  for (const line of lines) {
    let used = 0;
    for (const char of line) used += wide(char.codePointAt(0)!) ? fontSize : fontSize * 0.6;
    count += Math.max(1, Math.ceil(used / width));
  }
  return count;
}

/** What the strip is called: the question that opened this turn, or the latest one (the Agent started the turn itself). */
export function pinTitle(pin: PromptPin, answer: { seq: number | null; turnId: string | null }): string {
  const sameTurn = pin.promptSeq !== null ? pin.sameTurn : answer.turnId !== null && answer.turnId === pin.turn;
  return t(sameTurn ? "sharedPrompt.current" : "sharedPrompt.recent");
}

/** The pinned question is at most this long (characters); a longer one says it was cut. */
export const MAX_PROMPT_CHARS = 20_000;

const cursorSchema = z.object({ epoch: z.string().min(1).max(200), seq: z.number().int().nonnegative() });

/**
 * The text of the question to pin. With `at`, the user message at that position; without, the newest user message within
 * the last PROMPT_SCAN_PAGES pages of the timeline. Read in the daemon by the plugin server; only the text crosses the relay.
 */
export const turnPromptRpc = defineRpc({
  name: "turn-prompt",
  input: z.object({
    agentId: z.string().min(1).max(256),
    at: cursorSchema.nullable(),
  }),
  output: z.object({
    status: z.enum(["ok", "none", "unavailable"]),
    text: z.string(),
    seq: z.number().int().nonnegative().nullable(),
    /** The user message's turn (Paseo's turnId), when it has one. */
    turnId: z.string().max(200).nullable(),
    truncated: z.boolean(),
  }),
});
export type TurnPromptInput = z.input<typeof turnPromptRpc.input>;
export type TurnPromptOutput = z.output<typeof turnPromptRpc.output>;
