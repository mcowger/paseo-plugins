import { describe, expect, it } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { forgetAgentTurns, forgetTurnStarts, handleFoldIndex, knownTurnStart, noteAgentClosed, noteTurnStarted, turnMemoSize, turnName } from "./fold-index";

function context(refetch: (options: unknown) => Promise<unknown>, calls: unknown[] = []): PluginHandlerContext {
  return {
    paseo: {
      agents: {
        ref: (agentId: string) => ({
          timeline: {
            refetch: (options: unknown) => {
              calls.push({ agentId, options });
              return refetch(options);
            },
          },
        }),
      },
    },
  } as unknown as PluginHandlerContext;
}

const payload = {
  epoch: "e1",
  entries: [
    { provider: "claude", item: { type: "user_message", text: "hi" }, timestamp: "2026-10-09T10:00:00.000Z", seqStart: 1, seqEnd: 1 },
    { provider: "claude", item: { type: "tool_call", callId: "c1", name: "Bash", status: "running", error: null, detail: { type: "shell", command: "npm run secret-build", output: "SECRET OUTPUT" } }, timestamp: "2026-10-09T10:00:01.000Z", seqStart: 2, seqEnd: 2 },
    { provider: "claude", item: { nope: true }, timestamp: "x", seqStart: 3, seqEnd: 3 },
  ],
  startCursor: { epoch: "e1", seq: 1 },
  endCursor: { epoch: "e1", seq: 3 },
  hasOlder: true,
  hasNewer: false,
  reset: false,
  staleCursor: false,
  gap: false,
  agent: { status: "running" },
  error: null,
};

describe("fold-index RPC", () => {
  it("reads the projected timeline inside the daemon and returns only the compact rows", async () => {
    const calls: unknown[] = [];
    const out = await handleFoldIndex({ agentId: "a1", direction: "after", cursor: { epoch: "e1", seq: 7 }, limit: 50 }, context(async () => payload, calls));
    expect(calls).toEqual([{ agentId: "a1", options: { direction: "after", cursor: { epoch: "e1", seq: 7 }, limit: 50, projection: "projected" } }]);
    expect(out.now).toBeGreaterThan(0);
    expect({ ...out, now: undefined }).toEqual({
      now: undefined,
      status: "ok",
      epoch: "e1",
      rows: [
        { s: 1, at: Date.parse("2026-10-09T10:00:00.000Z"), k: "b", w: "user_message" },
        { s: 2, at: Date.parse("2026-10-09T10:00:01.000Z"), k: "t", key: "t:c1", st: "running", look: "shell" },
      ],
      startCursor: { epoch: "e1", seq: 1 },
      endCursor: { epoch: "e1", seq: 3 },
      hasOlder: true,
      hasNewer: false,
      reset: false,
      running: true,
      turns: [],
      active: null,
    });
    expect(JSON.stringify(out)).not.toMatch(/secret-build|SECRET OUTPUT/);
  });

  it("adds lines changed, exit codes and the turns' tokens from the record that came with the page (0.8.0)", async () => {
    const cwd = "/home/user/demo-app";
    const page = {
      ...payload,
      entries: [
        { provider: "my-claude", turnId: "foreground-turn-1", item: { type: "tool_call", callId: "e1", name: "Edit", status: "completed", error: null, detail: { type: "edit", filePath: `${cwd}/src/a.ts`, oldString: "a", newString: "b\nc" } }, timestamp: "2026-10-09T10:00:01.000Z", seqStart: 4, seqEnd: 4 },
        { provider: "my-claude", turnId: "foreground-turn-1", item: { type: "tool_call", callId: "b1", name: "Bash", status: "failed", error: { type: "tool_result", content: "Exit code 2\nboom", is_error: true }, detail: { type: "shell", command: "npm run secret-build" } }, timestamp: "2026-10-09T10:00:02.000Z", seqStart: 5, seqEnd: 5 },
      ],
      agent: { status: "idle", cwd, provider: "my-claude", lastUsage: { inputTokens: 6, cachedInputTokens: 900, outputTokens: 40 }, activeTurn: null },
    };
    const seen: unknown[] = [];
    const usage = { observe: async (agentId: string, agent: unknown, turns: readonly string[]) => (seen.push({ agentId, agent, turns }), [{ id: "foreground-turn-1", i: 6, c: 900, o: 40 }]) };
    const out = await handleFoldIndex({ agentId: "a1", direction: "after" }, context(async () => page), usage as never);
    expect(out.rows).toEqual([
      expect.objectContaining({ key: "t:e1", ch: [[expect.any(String), 2, 1]] }),
      expect.objectContaining({ key: "t:b1", st: "failed", x: 2 }),
    ]);
    expect(out.tok).toEqual([{ id: "foreground-turn-1", i: 6, c: 900, o: 40 }]);
    expect(seen).toEqual([{ agentId: "a1", agent: page.agent, turns: ["foreground-turn-1"] }]);
    // Still no paths, commands or output on the wire.
    expect(JSON.stringify(out)).not.toMatch(/src\/a\.ts|secret-build|boom/);
    // A ledger that fails costs the tokens, never the page.
    const broken = { observe: async () => { throw new Error("nope"); } };
    expect(await handleFoldIndex({ agentId: "a1", direction: "after" }, context(async () => page), broken as never)).not.toHaveProperty("tok");
  });

  it("drops the cursor for tail reads and reports stale cursors and gaps as a reset", async () => {
    const calls: unknown[] = [];
    const out = await handleFoldIndex({ agentId: "a1", direction: "tail", cursor: { epoch: "e1", seq: 3 } }, context(async () => ({ ...payload, staleCursor: true, agent: null }), calls));
    expect(calls).toEqual([{ agentId: "a1", options: { direction: "tail", limit: 150, projection: "projected" } }]);
    expect(out).toMatchObject({ reset: true, running: null });
    expect((await handleFoldIndex({ agentId: "a1", direction: "after" }, context(async () => ({ ...payload, gap: true })))).reset).toBe(true);
  });

  it("answers unavailable when the daemon cannot read the timeline, and missing when it has no such Agent", async () => {
    expect((await handleFoldIndex({ agentId: "a1", direction: "tail" }, context(async () => { throw new Error("gone"); }))).status).toBe("unavailable");
    expect((await handleFoldIndex({ agentId: "a1", direction: "tail" }, context(async () => ({ ...payload, error: "timed out" })))).status).toBe("unavailable");
    // A provider subagent's own view (as seen in the live daemon log): the client must stop asking.
    const subagent = "provider:6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5:toolu_01ExampleSubagentCall";
    expect((await handleFoldIndex({ agentId: subagent, direction: "tail" }, context(async () => { throw new Error(`Agent not found: ${subagent}`); }))).status).toBe("missing");
    expect((await handleFoldIndex({ agentId: "a1", direction: "tail" }, context(async () => ({ ...payload, error: "Agent not found" })))).status).toBe("missing");
  });

  it("tells each row's turn and the turn starts it knows: turn_started, then the running turn's startedAt", async () => {
    forgetTurnStarts();
    const at = (time: string) => `2026-10-10T${time}.000Z`;
    const turns = {
      ...payload,
      entries: [
        { provider: "claude", item: { type: "user_message", text: "go" }, timestamp: at("03:51:48"), seqStart: 1, seqEnd: 1, turnId: "foreground-turn-31" },
        { provider: "claude", item: { type: "assistant_message", text: "ok" }, timestamp: at("03:53:30"), seqStart: 2, seqEnd: 2, turnId: "foreground-turn-31" },
        // Claude Code woke up by itself an hour later: no user message in this turn.
        { provider: "claude", item: { type: "reasoning", text: "ready" }, timestamp: at("04:52:53"), seqStart: 3, seqEnd: 3, turnId: "autonomous-turn-32" },
        { provider: "claude", item: { type: "reasoning", text: "next" }, timestamp: at("04:53:10"), seqStart: 4, seqEnd: 4, turnId: "autonomous-turn-33" },
      ],
      agent: { status: "running", activeTurn: { turnId: "autonomous-turn-33", startedAt: at("04:53:05") } },
    };
    noteTurnStarted("a1", "autonomous-turn-32", Date.parse(at("04:52:40")));
    noteTurnStarted("a1", null);
    const out = await handleFoldIndex({ agentId: "a1", direction: "tail" }, context(async () => turns));
    expect(out.turns).toEqual([
      { id: "foreground-turn-31", at: null },
      { id: "autonomous-turn-32", at: Date.parse(at("04:52:40")) },
      { id: "autonomous-turn-33", at: Date.parse(at("04:53:05")) },
    ]);
    expect(out.rows.map((row) => row.u)).toEqual([0, 0, 1, 2]);
    expect(out.active).toEqual({ id: "autonomous-turn-33", at: Date.parse(at("04:53:05")) });
    // Starts are per Agent.
    expect(knownTurnStart("a2", "autonomous-turn-32")).toBeNull();
    // A reopened session reusing an id: the newest start wins.
    noteTurnStarted("a1", "autonomous-turn-32", Date.parse(at("05:00:00")));
    expect(knownTurnStart("a1", "autonomous-turn-32")).toBe(Date.parse(at("05:00:00")));
    forgetTurnStarts();
  });
});

describe("turn starts of closed Agents (0.5.0)", () => {
  it("forgets only the closed Agent's turns", () => {
    forgetTurnStarts();
    noteTurnStarted("agent-a", "foreground-turn-1", 1_000);
    noteTurnStarted("agent-a", "autonomous-turn-2", 2_000);
    noteTurnStarted("agent-ab", "foreground-turn-1", 3_000);
    noteTurnStarted("agent-b", "foreground-turn-1", 4_000);
    forgetAgentTurns("agent-a");
    expect(knownTurnStart("agent-a", "foreground-turn-1")).toBeNull();
    expect(knownTurnStart("agent-a", "autonomous-turn-2")).toBeNull();
    // An id that merely starts with the closed one is another Agent.
    expect(knownTurnStart("agent-ab", "foreground-turn-1")).toBe(3_000);
    expect(knownTurnStart("agent-b", "foreground-turn-1")).toBe(4_000);
    expect(turnMemoSize()).toBe(2);
    forgetAgentTurns("");
    expect(turnMemoSize()).toBe(2);
    forgetTurnStarts();
  });

  it("keeps the turns when the session closes, forgets them when the Agent is archived, and stops listening on unload", () => {
    forgetTurnStarts();
    const handlers = new Map<string, (event: unknown) => void>();
    const removed: string[] = [];
    const server = {
      registerSettings: () => ({ read: async () => ({ status: "ready", values: { language: "zh-CN" } }), subscribe: () => () => undefined }),
      handle: () => undefined,
      on: (name: string, handler: (event: unknown) => void) => {
        handlers.set(name, handler);
        return () => void removed.push(name);
      },
    };
    const stop = contribute(server as never);
    handlers.get("agent.turn_started")!({ agent: { id: "agent-z" }, turnId: "foreground-turn-1" });
    expect(knownTurnStart("agent-z", "foreground-turn-1")).not.toBeNull();
    // Paseo 0.14 closes an idle session after an hour: the turn keeps its start, and the next session's turns get new names.
    handlers.get("agent.closed")!({ agent: { id: "agent-z" } });
    expect(knownTurnStart("agent-z", "foreground-turn-1")).not.toBeNull();
    expect(turnName("agent-z", "foreground-turn-1")).toBe("foreground-turn-1#1");
    handlers.get("agent.archived")!({ agent: { id: "agent-z" }, archivedAt: "2026-10-29T10:00:00.000Z" });
    expect(knownTurnStart("agent-z", "foreground-turn-1")).toBeNull();
    expect(turnName("agent-z", "foreground-turn-1")).toBe("foreground-turn-1");
    stop();
    expect(removed.sort()).toEqual(["agent.archived", "agent.closed", "agent.turn_ended", "agent.turn_started"]);
    forgetTurnStarts();
  });
});

describe("sessions loaded again (0.10.0-local.3)", () => {
  const at = (time: string) => `2026-10-29T${time}.000Z`;
  const ms = (time: string) => Date.parse(at(time));
  const row = (seq: number, time: string, turnId: string, item: Record<string, unknown> = { type: "reasoning", text: `r${seq}` }) => ({
    provider: "claude", item, timestamp: at(time), seqStart: seq, seqEnd: seq, turnId,
  });

  it("names a reused turn id after its generation, by when each row was written", async () => {
    forgetTurnStarts();
    noteTurnStarted("a1", "foreground-turn-1", ms("08:00:00"));
    noteTurnStarted("a1", "foreground-turn-2", ms("08:10:00"));
    // Released after an hour idle, loaded again for a new message: its ids start from 1 again.
    noteAgentClosed("a1", ms("09:15:00"));
    noteTurnStarted("a1", "foreground-turn-1", ms("10:00:00"));
    expect(turnName("a1", "foreground-turn-1", ms("08:00:05"))).toBe("foreground-turn-1");
    expect(turnName("a1", "foreground-turn-1", ms("10:00:05"))).toBe("foreground-turn-1#1");
    expect(turnName("a1", "foreground-turn-1")).toBe("foreground-turn-1#1");
    expect(knownTurnStart("a1", "foreground-turn-1")).toBe(ms("08:00:00"));
    expect(knownTurnStart("a1", "foreground-turn-1#1")).toBe(ms("10:00:00"));
    // Another Agent is not affected.
    expect(turnName("a2", "foreground-turn-1")).toBe("foreground-turn-1");

    const page = {
      ...payload,
      entries: [
        row(1, "08:00:01", "foreground-turn-1", { type: "user_message", text: "first" }),
        row(2, "08:00:30", "foreground-turn-1"),
        row(3, "08:10:01", "foreground-turn-2"),
        row(4, "10:00:01", "foreground-turn-1", { type: "user_message", text: "again" }),
        row(5, "10:00:20", "foreground-turn-1"),
      ],
      agent: { status: "running", activeTurn: { turnId: "foreground-turn-1", startedAt: at("10:00:00") } },
    };
    const out = await handleFoldIndex({ agentId: "a1", direction: "tail" }, context(async () => page));
    expect(out.turns).toEqual([
      { id: "foreground-turn-1", at: ms("08:00:00") },
      { id: "foreground-turn-2", at: ms("08:10:00") },
      { id: "foreground-turn-1#1", at: ms("10:00:00") },
    ]);
    expect(out.rows.map((entry) => entry.u)).toEqual([0, 0, 1, 2, 2]);
    expect(out.active).toEqual({ id: "foreground-turn-1#1", at: ms("10:00:00") });
    forgetTurnStarts();
  });

  it("learns a running turn's start into its own generation, and keeps counting when old closes are let go", () => {
    forgetTurnStarts();
    noteAgentClosed("a3", 1_000);
    noteTurnStarted("a3", "codex-turn-1", 2_000);
    expect(knownTurnStart("a3", "codex-turn-1#1")).toBe(2_000);
    expect(knownTurnStart("a3", "codex-turn-1")).toBeNull();
    for (let close = 1; close <= 120; close++) noteAgentClosed("a3", 10_000 + close);
    expect(turnName("a3", "t")).toBe("t#121");
    // Rows older than the closes still kept are counted from the oldest one kept.
    expect(turnName("a3", "t", 5_000)).toBe("t#21");
    forgetAgentTurns("a3");
    expect(turnName("a3", "t")).toBe("t");
    expect(knownTurnStart("a3", "codex-turn-1#1")).toBeNull();
    forgetTurnStarts();
  });
});
