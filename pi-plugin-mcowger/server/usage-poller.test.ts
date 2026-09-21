// Diff-on-touch source: ~/workspace/paseo/packages/server/src/server/agent/providers/pi/usage-poller.test.ts
// The first four tests are upstream ports (ProviderUsage instead of
// AgentUsage). The remaining tests cover plugin extensions from NG item 6:
// the nonterminal poll-error path, stale-generation rejection for in-flight
// periodic polls, the FINAL_USAGE_WAIT_MS final-deadline flush, and the
// `refreshNow` interim-refresh helper.
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { describe, expect, test } from "vitest";

import type { ProviderUsage } from "@getpaseo/plugin/server/provider";

import type { PiSessionStats } from "./rpc-types.js";
import { FINAL_USAGE_WAIT_MS, PiUsagePoller, type PiUsagePollScheduler } from "./usage-poller.js";

class ManualPollScheduler implements PiUsagePollScheduler {
  private readonly polls: Array<{ active: boolean; callback: () => void }> = [];

  schedulePoll(callback: () => void): () => void {
    const poll = { active: true, callback };
    this.polls.push(poll);
    return () => {
      poll.active = false;
    };
  }

  poll(): void {
    const poll = this.polls.shift();
    if (!poll) throw new Error("No context usage poll is scheduled");
    if (poll.active) poll.callback();
  }

  activePollCount(): number {
    return this.polls.filter((poll) => poll.active).length;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function stats(tokens: number): PiSessionStats {
  return {
    tokens: { input: 100, cacheRead: 10, output: 20 },
    cost: 0.01,
    contextUsage: { contextWindow: 200_000, tokens },
  };
}

describe("Pi usage poller", () => {
  test("emits only changed usage while active", async () => {
    const scheduler = new ManualPollScheduler();
    const updates: ProviderUsage[] = [];
    let current = stats(130);
    const poller = new PiUsagePoller({
      scheduler,
      readStats: async () => current,
      onUsage: (update) => updates.push(update),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    scheduler.poll();
    await waitForImmediate();
    scheduler.poll();
    await waitForImmediate();
    current = stats(150);
    scheduler.poll();
    await waitForImmediate();

    expect(updates).toEqual([
      {
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        totalCostUsd: 0.01,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 130,
      },
      {
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        totalCostUsd: 0.01,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 150,
      },
    ]);
    expect(scheduler.activePollCount()).toBe(1);
    poller.stopTurn();
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("drops an in-flight poll without hiding the final refresh", async () => {
    const scheduler = new ManualPollScheduler();
    const inFlightStats = deferred<PiSessionStats>();
    const finalStats = { contextUsage: { contextWindow: 200_000, tokens: 150 } };
    const finalUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 150,
    };
    const updates: Array<{ usage: ProviderUsage; turnId?: string }> = [];
    let readCount = 0;
    const poller = new PiUsagePoller({
      scheduler,
      readStats: async () => {
        readCount += 1;
        return readCount === 1 ? inFlightStats.promise : finalStats;
      },
      onUsage: (usage, turnId) => updates.push({ usage, turnId }),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    scheduler.poll();
    await expect(poller.completeTurn("turn-1")).resolves.toBeUndefined();
    inFlightStats.resolve({
      contextUsage: { contextWindow: 200_000, tokens: 130 },
    });
    await waitForImmediate();

    expect(updates).toEqual([{ usage: finalUsage, turnId: "turn-1" }]);
    await expect(poller.completeTurn()).resolves.toBeUndefined();
    expect(updates).toEqual([{ usage: finalUsage, turnId: "turn-1" }]);
  });

  test("drops a final refresh when a newer turn starts", async () => {
    const scheduler = new ManualPollScheduler();
    const finalStats = deferred<PiSessionStats>();
    const updates: ProviderUsage[] = [];
    const poller = new PiUsagePoller({
      scheduler,
      readStats: () => finalStats.promise,
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    const completion = poller.completeTurn();
    poller.startTurn();
    finalStats.resolve({ contextUsage: { contextWindow: 200_000, tokens: 150 } });

    await expect(completion).resolves.toBeUndefined();
    expect(updates).toEqual([]);
    expect(scheduler.activePollCount()).toBe(1);
    poller.stopTurn();
  });

  test("close permanently suppresses pending usage", async () => {
    const scheduler = new ManualPollScheduler();
    const finalStats = deferred<PiSessionStats>();
    const updates: ProviderUsage[] = [];
    const poller = new PiUsagePoller({
      scheduler,
      readStats: () => finalStats.promise,
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    const completion = poller.completeTurn();
    poller.close();
    poller.startTurn();
    finalStats.resolve({ contextUsage: { contextWindow: 200_000, tokens: 150 } });

    await expect(completion).resolves.toBeUndefined();
    expect(updates).toEqual([]);
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("reports poll errors without stopping the poll loop", async () => {
    const scheduler = new ManualPollScheduler();
    const errors: unknown[] = [];
    const updates: ProviderUsage[] = [];
    let readCount = 0;
    const poller = new PiUsagePoller({
      scheduler,
      readStats: async () => {
        readCount += 1;
        if (readCount === 1) throw new Error("stats unavailable");
        return stats(150);
      },
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => errors.push(error),
    });

    poller.startTurn();
    scheduler.poll();
    await waitForImmediate();

    expect(errors).toHaveLength(1);
    expect(updates).toEqual([]);
    // The failed poll reschedules: the next poll emits and keeps polling.
    scheduler.poll();
    await waitForImmediate();

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ contextWindowUsedTokens: 150 });
    expect(scheduler.activePollCount()).toBe(1);
    poller.stopTurn();
  });

  test("drops an in-flight periodic poll after the turn stops", async () => {
    const scheduler = new ManualPollScheduler();
    const inFlight = deferred<PiSessionStats>();
    const updates: ProviderUsage[] = [];
    const poller = new PiUsagePoller({
      scheduler,
      readStats: () => inFlight.promise,
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    scheduler.poll();
    poller.stopTurn();
    inFlight.resolve(stats(150));
    await waitForImmediate();

    expect(updates).toEqual([]);
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("empty stats never emit usage", async () => {
    const scheduler = new ManualPollScheduler();
    const updates: ProviderUsage[] = [];
    const poller = new PiUsagePoller({
      scheduler,
      readStats: async () => ({}),
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    scheduler.poll();
    await waitForImmediate();
    await expect(poller.completeTurn("turn-1")).resolves.toBeUndefined();

    expect(updates).toEqual([]);
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("drops the final sample when the deadline wins", async () => {
    const scheduler = new ManualPollScheduler();
    const pending = deferred<PiSessionStats>();
    const updates: ProviderUsage[] = [];
    const poller = new PiUsagePoller({
      scheduler,
      readStats: () => pending.promise,
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => {
        throw error;
      },
      finalWaitMs: 5,
    });

    poller.startTurn();
    await expect(poller.completeTurn("turn-1")).resolves.toBeUndefined();
    expect(updates).toEqual([]);

    // The late read must not publish after the deadline already won.
    pending.resolve(stats(150));
    await waitForImmediate();
    expect(updates).toEqual([]);
  });

  test("uses the default final deadline bound", () => {
    expect(FINAL_USAGE_WAIT_MS).toBe(250);
  });

  test("refreshNow publishes changed usage without disturbing the poll loop", async () => {
    const scheduler = new ManualPollScheduler();
    const updates: Array<{ usage: ProviderUsage; turnId?: string }> = [];
    let current = stats(130);
    const poller = new PiUsagePoller({
      scheduler,
      readStats: async () => current,
      onUsage: (usage, turnId) => updates.push({ usage, turnId }),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    await expect(poller.refreshNow("turn-1")).resolves.toBeUndefined();
    expect(updates).toHaveLength(1);
    expect(updates[0].turnId).toBe("turn-1");
    // Unchanged usage is deduped and the periodic poll is still scheduled.
    await expect(poller.refreshNow("turn-1")).resolves.toBeUndefined();
    expect(updates).toHaveLength(1);
    expect(scheduler.activePollCount()).toBe(1);
    current = stats(150);
    scheduler.poll();
    await waitForImmediate();
    expect(updates).toHaveLength(2);
    poller.stopTurn();
  });

  test("refreshNow drops stale reads and stays silent when closed", async () => {
    const scheduler = new ManualPollScheduler();
    const pending = deferred<PiSessionStats>();
    const updates: ProviderUsage[] = [];
    const poller = new PiUsagePoller({
      scheduler,
      readStats: () => pending.promise,
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    const refresh = poller.refreshNow();
    poller.stopTurn();
    pending.resolve(stats(150));
    await expect(refresh).resolves.toBeUndefined();
    expect(updates).toEqual([]);

    poller.close();
    await expect(poller.refreshNow()).resolves.toBeUndefined();
    expect(updates).toEqual([]);
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("throwing consumer callbacks cannot escape the poller", async () => {
    const scheduler = new ManualPollScheduler();
    let reads = 0;
    const poller = new PiUsagePoller({
      scheduler,
      readStats: async () => {
        reads += 1;
        if (reads === 1) throw new Error("stats unavailable");
        return stats(150);
      },
      onUsage: () => {
        throw new Error("sink exploded");
      },
      onPollError: () => {
        throw new Error("error sink exploded");
      },
    });

    poller.startTurn();
    scheduler.poll();
    await waitForImmediate();
    // The throwing onPollError did not break the loop: the next poll ran.
    scheduler.poll();
    await waitForImmediate();
    // The throwing onUsage did not escape or stop teardown either.
    await expect(poller.completeTurn("turn-1")).resolves.toBeUndefined();
    poller.stopTurn();
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("refreshNow routes read failures to onPollError", async () => {
    const scheduler = new ManualPollScheduler();
    const errors: unknown[] = [];
    const updates: ProviderUsage[] = [];
    const poller = new PiUsagePoller({
      scheduler,
      readStats: async () => {
        throw new Error("stats unavailable");
      },
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => errors.push(error),
    });

    poller.startTurn();
    await expect(poller.refreshNow()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(updates).toEqual([]);
    // The periodic schedule is undisturbed by the failed refresh.
    expect(scheduler.activePollCount()).toBe(1);
    poller.stopTurn();
  });

  test("completeTurn emits its keyed sample even when unchanged", async () => {
    const scheduler = new ManualPollScheduler();
    const updates: Array<{ usage: ProviderUsage; turnId?: string }> = [];
    const current = stats(130);
    const poller = new PiUsagePoller({
      scheduler,
      readStats: async () => current,
      onUsage: (usage, turnId) => updates.push({ usage, turnId }),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    // Interim refresh publishes the stats session-level (no turnId), which
    // shares the dedupe with the final read.
    await expect(poller.refreshNow()).resolves.toBeUndefined();
    expect(updates).toHaveLength(1);
    await expect(poller.completeTurn("turn-1")).resolves.toBeUndefined();
    expect(updates).toHaveLength(2);
    expect(updates[1]?.turnId).toBe("turn-1");
  });

  test("concurrent refreshNow calls coalesce into one stats read", async () => {
    const scheduler = new ManualPollScheduler();
    const gate = deferred<PiSessionStats>();
    let reads = 0;
    const updates: ProviderUsage[] = [];
    const poller = new PiUsagePoller({
      scheduler,
      readStats: () => {
        reads += 1;
        return gate.promise;
      },
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    const first = poller.refreshNow();
    const second = poller.refreshNow();
    gate.resolve(stats(150));
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(reads).toBe(1);
    expect(updates).toHaveLength(1);
    poller.stopTurn();
  });
});
