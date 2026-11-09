import { describe, expect, it } from "vitest";
import { planFolds, reasoningKey, toolKey, type FoldOptions, type IndexRow } from "./fold";
import { estimateLines, PIN_MIN_BLOCKS, pinTitle, promptPin, samePin, turnPromptRpc, type PromptPin } from "./prompt-pin";

const user = (seq: number, turn?: string): IndexRow => ({ seq, at: seq * 1000, kind: "boundary", what: "user_message", ...(turn ? { turn } : {}) });
const text = (seq: number, turn?: string): IndexRow => ({ seq, at: seq * 1000, kind: "boundary", what: "assistant_message", ...(turn ? { turn } : {}) });
const tool = (seq: number, turn?: string, status: IndexRow["status"] = "completed"): IndexRow => ({
  seq, at: seq * 1000, kind: "tool", key: toolKey(`call-${seq}`), status, look: "shell", ...(turn ? { turn } : {}),
});
const think = (seq: number, turn?: string): IndexRow => ({ seq, at: seq * 1000, kind: "reasoning", key: reasoningKey(`思考 ${seq}`), ...(turn ? { turn } : {}) });
const skip = (seq: number): IndexRow => ({ seq, at: seq * 1000, kind: "skip", what: "hidden-tool" });

const options = (overrides: Partial<FoldOptions> = {}): FoldOptions => ({ scope: "all", enabled: true, agentRunning: true, ...overrides });
const everything: { drawn: (key: string) => boolean; hasOlder: boolean } = { drawn: () => true, hasOlder: false };
const pinOf = (rows: IndexRow[], overrides: Partial<FoldOptions> = {}, extra: Partial<typeof everything> = {}) =>
  promptPin(rows, planFolds(rows, options(overrides)), { ...everything, ...extra });

describe("where the question is pinned (grok-B2)", () => {
  /** Three rounds of 「Agent 说一句、做一段」 after the question: six blocks, rows from seq `from`. */
  const rounds = (from: number, turn?: string): IndexRow[] => [tool(from, turn), text(from + 1, turn), tool(from + 2, turn), text(from + 3, turn), tool(from + 4, turn), text(from + 5, turn)];

  it("pins the question above the newest stretch of activity once it is about a screen away", () => {
    const rows = [user(1, "t1"), ...rounds(2, "t1"), tool(8, "t1"), tool(9, "t1", "running")];
    expect(pinOf(rows)).toEqual({ key: toolKey("call-8"), segment: "8", fold: false, promptSeq: 1, sameTurn: true, turn: "t1" });
  });

  it("does not repeat a question that is still close", () => {
    // 「先看一下」→ 读一个文件 →「改一下」→ 改文件：the question is still on screen.
    expect(pinOf([user(1), text(2), tool(3), text(4), tool(5, undefined, "running")])).toBeNull();
    // Five blocks: not yet. A stretch of many tool rows is one block (it folds into one row).
    const five = [user(1), text(2), tool(3), tool(4), tool(5), text(6), tool(7), text(8), tool(9, undefined, "running")];
    expect(pinOf(five)).toBeNull();
    // Rows Paseo never shows do not count, and do not split a stretch.
    expect(pinOf([user(1), skip(2), text(3), tool(4), skip(5), tool(6), text(7), tool(8), text(9), tool(10, undefined, "running")])).toBeNull();
    expect(pinOf([user(1), ...rounds(2), tool(8, undefined, "running")])).toMatchObject({ key: toolKey("call-8") });
    expect(PIN_MIN_BLOCKS).toBe(6);
  });

  it("counts a long text by its length: a long plan pushes the question off the screen by itself", () => {
    const plan = (lines: number): IndexRow => ({ ...text(2), lines });
    expect(pinOf([user(1), plan(3), tool(3, undefined, "running")])).toBeNull();
    // 40 lines: five blocks, plus the stretch before it.
    expect(pinOf([user(1), think(2), { ...text(3), lines: 40 }, tool(4, undefined, "running")])).toMatchObject({ key: toolKey("call-4"), promptSeq: 1 });
    expect(pinOf([user(1), { ...text(2), lines: 48 }, tool(3, undefined, "running")])).toMatchObject({ key: toolKey("call-3") });
    expect(pinOf([user(1), { ...text(2), lines: 40 }, tool(3, undefined, "running")])).toBeNull();
  });

  it("pins nothing before the Agent has started on a new question", () => {
    const rows = [user(1), ...rounds(2), tool(8), user(9)];
    expect(pinOf(rows)).toBeNull();
  });

  it("goes above the summary row when the newest stretch is folded, and skips rows that are hidden or not drawn", () => {
    const done = [user(1, "t1"), ...rounds(2, "t1"), tool(8, "t1"), tool(9, "t1"), tool(10, "t1"), text(11, "t1")];
    const folded = pinOf(done, { agentRunning: false });
    expect(folded).toMatchObject({ segment: "8", fold: true, promptSeq: 1 });
    // The summary is drawn for the segment's anchor row.
    const plan = planFolds(done, options({ agentRunning: false }));
    expect(plan.roles.get(folded!.key)?.kind).toBe("fold");
    // A running stretch: its first row not drawn yet (Paseo has not projected it) → the next one.
    const running = [user(1), ...rounds(2), tool(8), tool(9, undefined, "running")];
    expect(pinOf(running, {}, { drawn: (key) => key !== toolKey("call-8") })).toMatchObject({ key: toolKey("call-9"), segment: "8" });
    expect(pinOf(running, {}, { drawn: () => false })).toBeNull();
  });

  it("says when the Agent started the turn itself (a background task woke it), and leaves an older question to the server", () => {
    const rows = [user(1, "t1"), ...rounds(2, "t1"), tool(8, "t2", "running")];
    const pin = pinOf(rows);
    expect(pin).toMatchObject({ promptSeq: 1, sameTurn: false, turn: "t2" });
    expect(pinTitle(pin!, { seq: 1, turnId: "t1" })).toBe("最近的提问");
    expect(pinTitle({ ...pin!, sameTurn: true }, { seq: 1, turnId: "t1" })).toBe("本轮提问");
    // The index starts after the question: the server finds it, and its turn decides the title.
    const tail = [tool(40, "t9"), text(41, "t9"), tool(42, "t9", "running")];
    const older = pinOf(tail, {}, { hasOlder: true });
    expect(older).toMatchObject({ key: toolKey("call-42"), promptSeq: null, sameTurn: false, turn: "t9" });
    expect(pinTitle(older!, { seq: 3, turnId: "t9" })).toBe("本轮提问");
    expect(pinTitle(older!, { seq: 3, turnId: "t8" })).toBe("最近的提问");
    expect(pinTitle(older!, { seq: 3, turnId: null })).toBe("最近的提问");
    // A history that starts with no question at all.
    expect(pinOf(tail, {}, { hasOlder: false })).toBeNull();
  });

  it("follows the reasoning-only takeover: only thinking rows are the plugin's", () => {
    const rows = [user(1), think(2), tool(3), text(4), tool(5), text(6), tool(7), text(8), think(9), tool(10, undefined, "running")];
    expect(pinOf(rows, { scope: "reasoning" })).toMatchObject({ key: reasoningKey("思考 9"), fold: false });
  });

  it("compares pins by what they show", () => {
    const pin: PromptPin = { key: "t:a", segment: "4", fold: false, promptSeq: 1, sameTurn: true, turn: "x" };
    expect(samePin(pin, { ...pin })).toBe(true);
    expect(samePin(null, null)).toBe(true);
    expect(samePin(pin, null)).toBe(false);
    for (const change of [{ key: "t:b" }, { segment: "5" }, { fold: true }, { promptSeq: 2 }, { sameTurn: false }, { turn: "y" }]) {
      expect(samePin(pin, { ...pin, ...change })).toBe(false);
    }
  });
});

describe("pinned question text", () => {
  it("guesses lines generously: CJK takes a full em, line breaks always start a line", () => {
    expect(estimateLines("一二三四五六七八九十", 130, 13)).toBe(1);
    expect(estimateLines("一二三四五六七八九十一", 130, 13)).toBe(2);
    expect(estimateLines("a".repeat(16), 130, 13)).toBe(1);
    expect(estimateLines("a".repeat(17), 130, 13)).toBe(2);
    expect(estimateLines("一\n二\n三\n四", 300, 13)).toBe(4);
    expect(estimateLines("一\n二", 0, 13)).toBe(2);
  });

  it("asks the server with a bounded input and accepts only its own answer shape", () => {
    expect(turnPromptRpc.input.safeParse({ agentId: "a", at: { epoch: "e", seq: 3 } }).success).toBe(true);
    expect(turnPromptRpc.input.safeParse({ agentId: "a", at: null }).success).toBe(true);
    expect(turnPromptRpc.input.safeParse({ agentId: "", at: null }).success).toBe(false);
    expect(turnPromptRpc.input.safeParse({ agentId: "a", at: { epoch: "e", seq: -1 } }).success).toBe(false);
    expect(turnPromptRpc.output.safeParse({ status: "ok", text: "hi", seq: 1, turnId: null, truncated: false }).success).toBe(true);
    expect(turnPromptRpc.output.safeParse({ status: "maybe", text: "hi", seq: 1, turnId: null, truncated: false }).success).toBe(false);
  });
});
