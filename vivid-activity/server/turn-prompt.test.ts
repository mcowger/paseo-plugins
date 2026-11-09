import { describe, expect, it } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { MAX_PROMPT_CHARS } from "../shared/prompt-pin";
import { handleTurnPrompt, PROMPT_DEADLINE_MS, PROMPT_SCAN_PAGES } from "./turn-prompt";

type Entry = { seqStart: number; seqEnd: number; turnId?: string; item: Record<string, unknown> };
type Cursor = { epoch: string; seq: number };
type Options = { direction: "tail" | "before"; cursor?: Cursor; limit: number; projection: string };

/**
 * A projected timeline paged the way Paseo 0.11.1 pages it: `tail` gives the newest `limit` entries, `before` the newest
 * `limit` entries that start before the cursor's seq; `startCursor` is the first entry's seq.
 */
function timeline(entries: Entry[], epoch = "e1") {
  const calls: Options[] = [];
  const page = (subset: Entry[], hasOlder: boolean) => ({
    epoch,
    entries: subset.map((entry) => ({ provider: "claude", timestamp: "2026-10-12T00:00:00.000Z", ...entry })),
    startCursor: subset.length ? { epoch, seq: subset[0]!.seqStart } : null,
    endCursor: subset.length ? { epoch, seq: subset.at(-1)!.seqEnd } : null,
    hasOlder,
    hasNewer: false,
    error: null,
  });
  const refetch = async (options: Options) => {
    calls.push(options);
    const end = options.direction === "tail" ? Infinity : options.cursor!.seq;
    const before = entries.filter((entry) => entry.seqStart < end);
    const subset = before.slice(Math.max(0, before.length - options.limit));
    return page(subset, before.length > subset.length);
  };
  const context = { paseo: { agents: { ref: () => ({ timeline: { refetch } }) } } } as unknown as PluginHandlerContext;
  return { context, calls };
}

const user = (seq: number, text: string, turnId?: string): Entry => ({ seqStart: seq, seqEnd: seq, ...(turnId ? { turnId } : {}), item: { type: "user_message", text, messageId: `m${seq}` } });
const tool = (seq: number): Entry => ({ seqStart: seq, seqEnd: seq + 1, item: { type: "tool_call", callId: `c${seq}`, name: "Bash", status: "completed", detail: { type: "shell", command: "ls" } } });
const said = (seq: number): Entry => ({ seqStart: seq, seqEnd: seq, item: { type: "assistant_message", text: "好的" } });

describe("turn-prompt RPC (grok-B2)", () => {
  it("reads the question at the position the client knows, one entry, from inside the daemon", async () => {
    const { context, calls } = timeline([user(1, "先看看日志", "t1"), tool(2), said(4), user(5, "再把测试修好", "t2"), tool(6)]);
    const out = await handleTurnPrompt({ agentId: "a1", at: { epoch: "e1", seq: 5 } }, context);
    expect(out).toEqual({ status: "ok", text: "再把测试修好", seq: 5, turnId: "t2", truncated: false });
    expect(calls).toEqual([{ direction: "before", cursor: { epoch: "e1", seq: 6 }, limit: 1, projection: "projected" }]);
  });

  it("looks for the newest question when the position is not a question any more (the history changed)", async () => {
    const { context, calls } = timeline([user(1, "第一问", "t1"), tool(2), said(4), user(5, "第二问", "t2"), tool(6)]);
    const out = await handleTurnPrompt({ agentId: "a1", at: { epoch: "e1", seq: 4 } }, context);
    expect(out).toMatchObject({ status: "ok", text: "第二问", seq: 5 });
    expect(calls.map((call) => call.direction)).toEqual(["before", "tail"]);
  });

  it("pages back for a question older than the newest page, and stops after PROMPT_SCAN_PAGES pages", async () => {
    const busy = [user(1, "很早以前的问题", "t1")];
    for (let seq = 2; seq < 2 + 450; seq++) busy.push(said(seq));
    const near = timeline(busy);
    const found = await handleTurnPrompt({ agentId: "a1", at: null }, near.context);
    expect(found).toMatchObject({ status: "ok", text: "很早以前的问题", seq: 1, turnId: "t1" });
    expect(near.calls.map((call) => [call.direction, call.cursor?.seq ?? null])).toEqual([["tail", null], ["before", 252], ["before", 52]]);

    const long = [user(1, "太早了")];
    for (let seq = 2; seq < 2 + 200 * PROMPT_SCAN_PAGES; seq++) long.push(said(seq));
    const far = timeline(long);
    expect(await handleTurnPrompt({ agentId: "a1", at: null }, far.context)).toEqual({ status: "none", text: "", seq: null, turnId: null, truncated: false });
    expect(far.calls).toHaveLength(PROMPT_SCAN_PAGES);
  });

  it("answers none for a history without questions, unavailable when the daemon cannot read it", async () => {
    expect((await handleTurnPrompt({ agentId: "a1", at: null }, timeline([said(1), tool(2)]).context)).status).toBe("none");
    const failing = { paseo: { agents: { ref: () => ({ timeline: { refetch: async () => ({ entries: [], error: "agent not found" }) } }) } } } as unknown as PluginHandlerContext;
    expect((await handleTurnPrompt({ agentId: "a1", at: null }, failing)).status).toBe("unavailable");
    const throwing = { paseo: { agents: { ref: () => ({ timeline: { refetch: async () => { throw new Error("closed"); } } }) } } } as unknown as PluginHandlerContext;
    expect((await handleTurnPrompt({ agentId: "a1", at: { epoch: "e1", seq: 1 } }, throwing)).status).toBe("unavailable");
  });

  it("gives up after its deadline and answers unavailable with no text (codex-vivid 待核实 2)", async () => {
    expect(PROMPT_DEADLINE_MS).toBe(10_000);
    // A daemon that never answers: the RPC still ends, empty, soon after the deadline.
    const stuck = { paseo: { agents: { ref: () => ({ timeline: { refetch: () => new Promise(() => {}) } }) } } } as unknown as PluginHandlerContext;
    const started = Date.now();
    expect(await handleTurnPrompt({ agentId: "a1", at: { epoch: "e1", seq: 3 } }, stuck, 40)).toEqual({ status: "unavailable", text: "", seq: null, turnId: null, truncated: false });
    expect(Date.now() - started).toBeLessThan(1_000);
    // A slow one: no page is asked for once the deadline has passed.
    const busy = [user(1, "很早以前的问题")];
    for (let seq = 2; seq < 2 + 200 * PROMPT_SCAN_PAGES; seq++) busy.push(said(seq));
    const { context, calls } = timeline(busy);
    const refetch = context.paseo.agents.ref("a1").timeline.refetch;
    const slow = { paseo: { agents: { ref: () => ({ timeline: { refetch: async (options: Options) => (await new Promise((done) => setTimeout(done, 30)), refetch(options as never)) } }) } } } as unknown as PluginHandlerContext;
    expect((await handleTurnPrompt({ agentId: "a1", at: null }, slow, 45)).status).toBe("unavailable");
    await new Promise((done) => setTimeout(done, 120));
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("sends at most MAX_PROMPT_CHARS characters and says when it cut", async () => {
    const huge = "问".repeat(MAX_PROMPT_CHARS + 10);
    const out = await handleTurnPrompt({ agentId: "a1", at: null }, timeline([user(1, huge)]).context);
    expect(out.text).toHaveLength(MAX_PROMPT_CHARS);
    expect(out).toMatchObject({ truncated: true, turnId: null });
  });
});
