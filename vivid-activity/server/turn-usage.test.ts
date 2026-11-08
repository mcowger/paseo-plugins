import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTurnUsage, meterFor, rawUsage, REQUEST_END_GRACE_MS, REQUEST_END_WAIT_MS, sameUsage, shownTokens, type TurnUsageDeps } from "./turn-usage";

/**
 * 0.8.0: per-turn tokens. Provider ids here are made-up custom ids; their base is what counts (`extends` in the daemon
 * config, server/provider-base.ts), never the id.
 */
const bases: Record<string, string> = { "my-claude": "claude", "work-codex": "codex", "acp-agent": "acp", "pi-like": "pi" };

function setup(records: Record<string, unknown> = {}) {
  const feed = { holds: 0, hold: vi.fn(() => void (feed.holds += 1)), release: vi.fn(() => void (feed.holds -= 1)) };
  const refresh = vi.fn(async (agentId: string) => (agentId in records ? (records[agentId] as { lastUsage?: unknown }) : null));
  const deps: TurnUsageDeps = { base: async (provider) => bases[provider] ?? null, refresh, feed };
  return { usage: createTurnUsage(deps), feed, refresh };
}
const usage = (input: number, cached: number | undefined, output: number) => ({ inputTokens: input, ...(cached !== undefined ? { cachedInputTokens: cached } : {}), outputTokens: output, contextWindowUsedTokens: input + output });
const running = (provider: string, turnId: string, lastUsage?: unknown) => ({ provider, status: "running", activeTurn: { turnId, startedAt: null }, lastUsage });
const idle = (provider: string, lastUsage?: unknown) => ({ provider, status: "idle", activeTurn: null, lastUsage });
const upsert = (id: string, turnId: string | null, lastUsage: unknown) => ({ kind: "upsert", agent: { id, activeTurn: turnId ? { turnId } : null, lastUsage } });

describe("which turns show tokens, and how they are read", () => {
  it("reads Claude and ACP per turn, Codex per request, and nothing else", () => {
    expect(meterFor("claude")).toBe("turn");
    expect(meterFor("acp")).toBe("turn");
    expect(meterFor("copilot")).toBe("turn");
    expect(meterFor("codex")).toBe("request");
    expect(meterFor("pi")).toBeNull();
    expect(meterFor("opencode")).toBeNull();
    expect(meterFor(null)).toBeNull();
  });

  it("needs input and output; cache reads may be missing", () => {
    expect(rawUsage(usage(10, 4, 3))).toEqual({ input: 10, cached: 4, output: 3 });
    expect(rawUsage(usage(10, undefined, 3))).toEqual({ input: 10, cached: null, output: 3 });
    expect(rawUsage({ contextWindowUsedTokens: 5 })).toBeNull();
    expect(rawUsage({ inputTokens: -1, outputTokens: 1 })).toBeNull();
    expect(sameUsage(rawUsage(usage(1, 2, 3)), rawUsage(usage(1, 2, 3)))).toBe(true);
    expect(sameUsage(rawUsage(usage(1, 2, 3)), rawUsage(usage(1, 2, 4)))).toBe(false);
  });

  it("splits Codex's cached tokens out of its input, as the observatory does", () => {
    expect(shownTokens("request", { input: 1000, cached: 800, output: 50 })).toEqual({ i: 200, c: 800, o: 50 });
    expect(shownTokens("turn", { input: 6, cached: 31840, output: 120 })).toEqual({ i: 6, c: 31840, o: 120 });
  });
});

describe("Claude: the turn's total arrives when it ends", () => {
  it("shows the total read after a turn it watched, once no other turn began", async () => {
    const { usage: ledger } = setup();
    await ledger.turnStarted("a1", "my-claude", "foreground-turn-2");
    // While it runs: the previous turn's total (or only the context meter) is what the record says.
    expect(await ledger.observe("a1", running("my-claude", "foreground-turn-2", usage(5, 30000, 90)), ["foreground-turn-2"])).toBeUndefined();
    const after = await ledger.observe("a1", idle("my-claude", usage(6, 31840, 120)), ["foreground-turn-2"]);
    expect(after).toEqual([{ id: "foreground-turn-2", i: 6, c: 31840, o: 120 }]);
    // Frozen: a later read reports the same figures, even when the record changes without a new turn.
    expect(await ledger.observe("a1", idle("my-claude", usage(1, 1, 1)), [])).toEqual([{ id: "foreground-turn-2", i: 6, c: 31840, o: 120 }]);
  });

  it("shows nothing it cannot tell apart", async () => {
    const { usage: ledger } = setup();
    // The same figures as during the turn: this turn reported nothing (an interrupted turn keeps the previous total).
    await ledger.turnStarted("a2", "my-claude", "t1");
    await ledger.observe("a2", running("my-claude", "t1", usage(5, 10, 9)), ["t1"]);
    expect(await ledger.observe("a2", idle("my-claude", usage(5, 10, 9)), ["t1"])).toBeUndefined();
    // Only the context meter after the turn (a failed turn): no total.
    await ledger.turnStarted("a2", "my-claude", "t2");
    await ledger.observe("a2", running("my-claude", "t2", usage(5, 10, 9)), ["t2"]);
    expect(await ledger.observe("a2", idle("my-claude", { contextWindowUsedTokens: 900 }), ["t2"])).toBeUndefined();
  });

  it("never gives a turn the figures of a later one", async () => {
    const { usage: ledger } = setup();
    await ledger.turnStarted("a3", "my-claude", "t1");
    await ledger.observe("a3", running("my-claude", "t1", usage(1, 1, 1)), ["t1"]);
    // Another turn began (and ended) before the next read: its figures are not t1's, and t2 was never watched.
    await ledger.turnStarted("a3", "my-claude", "t2");
    expect(await ledger.observe("a3", idle("my-claude", usage(9, 9, 9)), ["t1", "t2"])).toBeUndefined();
  });

  it("forgets a turn's figures when its id starts again (the session was loaded again and counts from 1)", async () => {
    const { usage: ledger } = setup();
    await ledger.turnStarted("a5", "my-claude", "foreground-turn-1");
    await ledger.observe("a5", running("my-claude", "foreground-turn-1", usage(1, 1, 1)), ["foreground-turn-1"]);
    expect(await ledger.observe("a5", idle("my-claude", usage(6, 7, 8)), ["foreground-turn-1"])).toEqual([{ id: "foreground-turn-1", i: 6, c: 7, o: 8 }]);
    // Reloaded, a new foreground-turn-1 nobody watched: the old figures must not show on it.
    await ledger.turnStarted("a5", "my-claude", "foreground-turn-1");
    expect(await ledger.observe("a5", idle("my-claude", usage(9, 9, 9)), ["foreground-turn-1"])).toBeUndefined();
  });

  it("keeps a turn's figures when its session closes and the next session reuses its id (0.10.0-local.3)", async () => {
    let generation = 0;
    const deps: TurnUsageDeps = {
      base: async (provider) => bases[provider] ?? null,
      refresh: async () => null,
      feed: { hold: () => undefined, release: () => undefined },
      turnName: (_agentId, turnId) => (generation === 0 ? turnId : `${turnId}#${generation}`),
    };
    const ledger = createTurnUsage(deps);
    await ledger.turnStarted("a9", "my-claude", "foreground-turn-1");
    await ledger.observe("a9", running("my-claude", "foreground-turn-1", usage(1, 1, 1)), ["foreground-turn-1"]);
    expect(await ledger.observe("a9", idle("my-claude", usage(6, 7, 8)), ["foreground-turn-1"])).toEqual([{ id: "foreground-turn-1", i: 6, c: 7, o: 8 }]);
    // Paseo 0.14 released the session after an hour idle; a new message loaded it again.
    ledger.closed("a9");
    generation = 1;
    await ledger.turnStarted("a9", "my-claude", "foreground-turn-1");
    await ledger.observe("a9", running("my-claude", "foreground-turn-1", usage(6, 7, 8)), ["foreground-turn-1", "foreground-turn-1#1"]);
    expect(await ledger.observe("a9", idle("my-claude", usage(10, 20, 30)), ["foreground-turn-1", "foreground-turn-1#1"])).toEqual([
      { id: "foreground-turn-1", i: 6, c: 7, o: 8 },
      { id: "foreground-turn-1#1", i: 10, c: 20, o: 30 },
    ]);
  });

  it("shows nothing for a turn nobody watched while it ran (replayed history included)", async () => {
    const { usage: ledger } = setup();
    await ledger.turnStarted("a4", "my-claude", "t1");
    expect(await ledger.observe("a4", idle("my-claude", usage(6, 7, 8)), ["t1"])).toBeUndefined();
    // After a plugin restart nothing is known about earlier turns.
    const fresh = setup().usage;
    expect(await fresh.observe("a4", idle("my-claude", usage(6, 7, 8)), ["t1"])).toBeUndefined();
  });

  it("reads ACP the same way and leaves out a turn that reported no usage", async () => {
    const { usage: ledger } = setup();
    await ledger.turnStarted("a5", "acp-agent", "t1");
    await ledger.observe("a5", running("acp-agent", "t1"), ["t1"]);
    expect(await ledger.observe("a5", idle("acp-agent", usage(300, undefined, 40)), ["t1"])).toEqual([{ id: "t1", i: 300, c: null, o: 40 }]);
    // The next turn reported none, so the record still holds t1's figures.
    await ledger.turnStarted("a5", "acp-agent", "t2");
    await ledger.observe("a5", running("acp-agent", "t2", usage(300, undefined, 40)), ["t2"]);
    expect(await ledger.observe("a5", idle("acp-agent", usage(300, undefined, 40)), ["t2"])).toEqual([{ id: "t1", i: 300, c: null, o: 40 }]);
  });

  it("ignores providers whose figures mean something else (Pi reports the whole session)", async () => {
    const { usage: ledger } = setup();
    await ledger.turnStarted("a6", "pi-like", "t1");
    await ledger.observe("a6", running("pi-like", "t1", usage(1, 1, 1)), ["t1"]);
    expect(await ledger.observe("a6", idle("pi-like", usage(5, 5, 5)), ["t1"])).toBeUndefined();
  });
});

describe("Codex: each request's usage is added up", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("counts every request of a watched turn from its baseline and freezes when the Agent stops", async () => {
    const { usage: ledger, feed, refresh } = setup({ c1: { lastUsage: usage(900, 0, 20) } });
    await ledger.turnStarted("c1", "work-codex", "codex-turn-3");
    expect(feed.hold).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("c1");
    // The turn's first state carries the previous request's figures: not counted.
    ledger.feedUpdate(upsert("c1", "codex-turn-3", usage(900, 0, 20)));
    ledger.feedUpdate(upsert("c1", "codex-turn-3", usage(1200, 1000, 30)));
    // The same figures again (another state change) are the same request.
    ledger.feedUpdate(upsert("c1", "codex-turn-3", usage(1200, 1000, 30)));
    ledger.feedUpdate(upsert("c1", "codex-turn-3", usage(1500, 1100, 70)));
    // Another Agent's updates do not count.
    ledger.feedUpdate(upsert("other", "codex-turn-3", usage(1, 1, 1)));
    // Live while it runs and the user watches it.
    expect(await ledger.observe("c1", running("work-codex", "codex-turn-3", usage(1500, 1100, 70)), ["codex-turn-3"])).toEqual([
      { id: "codex-turn-3", i: 600, c: 2100, o: 100, live: true },
    ]);
    ledger.turnEnded("c1", "codex-turn-3");
    ledger.feedUpdate({ kind: "remove", agentId: "c1" });
    expect(feed.release).toHaveBeenCalledTimes(1);
    expect(await ledger.observe("c1", idle("work-codex", usage(1500, 1100, 70)), [])).toEqual([{ id: "codex-turn-3", i: 600, c: 2100, o: 100 }]);
  });

  it("waits briefly for the last updates when the turn just ended, then finishes after a grace time", async () => {
    const { usage: ledger, feed } = setup({ c2: { lastUsage: usage(10, 0, 1) } });
    await ledger.turnStarted("c2", "work-codex", "t1");
    await ledger.observe("c2", running("work-codex", "t1"), ["t1"]);
    ledger.feedUpdate(upsert("c2", "t1", usage(20, 5, 2)));
    ledger.turnEnded("c2", "t1");
    const answer = ledger.observe("c2", idle("work-codex"), ["t1"]);
    // A late update of the turn still counts.
    ledger.feedUpdate(upsert("c2", "t1", usage(30, 6, 4)));
    await vi.advanceTimersByTimeAsync(REQUEST_END_WAIT_MS);
    expect(await answer).toEqual([{ id: "t1", i: 39, c: 11, o: 6 }]);
    await vi.advanceTimersByTimeAsync(REQUEST_END_GRACE_MS);
    expect(feed.release).toHaveBeenCalledTimes(1);
    expect(await ledger.observe("c2", idle("work-codex"), [])).toEqual([{ id: "t1", i: 39, c: 11, o: 6 }]);
  });

  it("shows nothing when an update may have been missed or the baseline is unknown", async () => {
    const { usage: ledger } = setup({ c3: { lastUsage: usage(10, 0, 1) } });
    await ledger.turnStarted("c3", "work-codex", "t1");
    await ledger.observe("c3", running("work-codex", "t1"), ["t1"]);
    ledger.feedUpdate(upsert("c3", "t1", usage(20, 0, 2)));
    ledger.feedGap();
    ledger.feedUpdate({ kind: "remove", agentId: "c3" });
    expect(await ledger.observe("c3", idle("work-codex"), ["t1"])).toBeUndefined();
    // The baseline could not be read (the record was unavailable).
    const other = setup();
    await other.usage.turnStarted("c4", "work-codex", "t1");
    await other.usage.observe("c4", running("work-codex", "t1"), ["t1"]);
    other.usage.feedUpdate(upsert("c4", "t1", usage(20, 0, 2)));
    other.usage.feedUpdate({ kind: "remove", agentId: "c4" });
    expect(await other.usage.observe("c4", idle("work-codex"), ["t1"])).toBeUndefined();
  });

  it("counts updates that came before the baseline once it is read", async () => {
    let answer: (value: unknown) => void = () => {};
    const feed = { hold: vi.fn(), release: vi.fn() };
    const ledger = createTurnUsage({ base: async () => "codex", refresh: () => new Promise((resolve) => { answer = resolve; }) as never, feed });
    const started = ledger.turnStarted("c5", "work-codex", "t1");
    await Promise.resolve();
    await Promise.resolve();
    ledger.feedUpdate(upsert("c5", "t1", usage(10, 0, 1)));
    ledger.feedUpdate(upsert("c5", "t1", usage(40, 20, 3)));
    answer({ lastUsage: usage(10, 0, 1) });
    await started;
    expect(await ledger.observe("c5", running("work-codex", "t1"), ["t1"])).toEqual([{ id: "t1", i: 20, c: 20, o: 3, live: true }]);
  });

  it("shows nothing for a turn nobody watched while it ran", async () => {
    const { usage: ledger } = setup({ c6: { lastUsage: usage(10, 0, 1) } });
    await ledger.turnStarted("c6", "work-codex", "t1");
    ledger.feedUpdate(upsert("c6", "t1", usage(20, 0, 2)));
    ledger.feedUpdate({ kind: "remove", agentId: "c6" });
    expect(await ledger.observe("c6", idle("work-codex"), ["t1"])).toBeUndefined();
  });

  it("ends a counted turn when the session closes, and counts the next session's turn under its own name", async () => {
    let generation = 0;
    const feed = { holds: 0, hold: () => void (feed.holds += 1), release: () => void (feed.holds -= 1) };
    const ledger = createTurnUsage({
      base: async (provider) => bases[provider] ?? null,
      refresh: async () => ({ lastUsage: usage(100, 0, 10) }),
      feed,
      turnName: (_agentId, turnId) => (generation === 0 ? turnId : `${turnId}#${generation}`),
    });
    await ledger.turnStarted("c9", "work-codex", "codex-turn-1");
    ledger.feedUpdate(upsert("c9", "codex-turn-1", usage(300, 100, 20)));
    await ledger.observe("c9", running("work-codex", "codex-turn-1", usage(300, 100, 20)), ["codex-turn-1"]);
    ledger.closed("c9");
    expect(feed.holds).toBe(0);
    generation = 1;
    await ledger.turnStarted("c9", "work-codex", "codex-turn-1");
    // The subscription and the hooks carry the session's own ids.
    ledger.feedUpdate(upsert("c9", "codex-turn-1", usage(500, 200, 40)));
    expect(await ledger.observe("c9", running("work-codex", "codex-turn-1", usage(500, 200, 40)), ["codex-turn-1", "codex-turn-1#1"])).toEqual([
      { id: "codex-turn-1#1", i: 300, c: 200, o: 40, live: true },
      { id: "codex-turn-1", i: 200, c: 100, o: 20 },
    ]);
    ledger.turnEnded("c9", "codex-turn-1");
    expect(ledger.debug("c9")?.current?.ending).toBe(true);
    ledger.dispose();
  });

  it("holds the subscription only while a Codex turn runs, and lets go when an Agent is forgotten", async () => {
    const { usage: ledger, feed } = setup({ c7: { lastUsage: usage(1, 0, 1) } });
    await ledger.turnStarted("c7", "my-claude", "t1");
    expect(feed.hold).not.toHaveBeenCalled();
    await ledger.turnStarted("c7", "work-codex", "t2");
    expect(feed.holds).toBe(1);
    ledger.forget("c7");
    expect(feed.holds).toBe(0);
    await ledger.turnStarted("c8", "work-codex", "t1");
    ledger.dispose();
    expect(feed.holds).toBe(0);
  });
});
