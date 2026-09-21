// Diff-on-touch source: ~/workspace/paseo/packages/server/src/server/agent/providers/pi/usage-poller.ts
// Intentional divergences (never "fix" on diff):
// - Usage type is ProviderUsage (plugin SDK) instead of AgentUsage (in-tree
//   agent-sdk-types); the shapes are field-identical.
// - The default scheduler is built on the shared `server/scheduler.ts` seam
//   (NG item 6) instead of a local setTimeout closure, so item 9 can reuse
//   the same seam for streaming frame coalescing.
// - `completeTurn` bounds its final stats read with FINAL_USAGE_WAIT_MS
//   (paseo-omp final-deadline behavior): a hung stats call resolves to no
//   emission instead of hanging turn teardown. Override via `finalWaitMs`.
// - Plugin extension `refreshNow`: a one-shot generation-guarded stats read
//   for interim refreshes (tool end, assistant message end, compaction
//   completion). It never disturbs the periodic schedule and stays silent
//   when closed; stale in-flight reads are dropped like every other path.
//   Read failures report to `onPollError` (same as the periodic path), and
//   concurrent refreshes coalesce behind an in-flight guard. `completeTurn`
//   always emits its keyed sample even when interim reads already published
//   identical stats, so the turn-correlated `session.usage` is never lost
//   to the shared dedupe.
import type { ProviderUsage } from "@getpaseo/plugin/server/provider";

import type { PiSessionStats } from "./rpc-types.js";
import { createPollScheduler, type PiUsagePollScheduler } from "./scheduler.js";

export type { PiUsagePollScheduler } from "./scheduler.js";

const FINAL_READ_TIMED_OUT = Symbol("pi-usage-final-read-timed-out");

interface PiUsagePollerOptions {
  readStats(): Promise<PiSessionStats>;
  onUsage(usage: ProviderUsage, turnId?: string): void;
  onPollError(error: unknown): void;
  scheduler?: PiUsagePollScheduler;
  // Plugin extension (NG item 6): bound for the final stats read in
  // `completeTurn`. Defaults to FINAL_USAGE_WAIT_MS.
  finalWaitMs?: number;
}

// Plugin extension (NG item 6): final-deadline flush bound. A stats read that
// outlives this window is dropped so turn teardown never hangs on usage.
export const FINAL_USAGE_WAIT_MS = 250;

function toAgentUsage(stats: PiSessionStats): ProviderUsage | undefined {
  const inputTokens = stats.tokens?.input ?? 0;
  const cachedInputTokens = stats.tokens?.cacheRead ?? 0;
  const outputTokens = stats.tokens?.output ?? 0;
  const totalCostUsd = stats.cost ?? 0;
  const contextWindowMaxTokens = stats.contextUsage?.contextWindow ?? undefined;
  const contextWindowUsedTokens = stats.contextUsage?.tokens ?? undefined;

  if (
    inputTokens === 0 &&
    cachedInputTokens === 0 &&
    outputTokens === 0 &&
    totalCostUsd === 0 &&
    contextWindowMaxTokens === undefined &&
    contextWindowUsedTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalCostUsd,
    ...(typeof contextWindowMaxTokens === "number" ? { contextWindowMaxTokens } : {}),
    ...(typeof contextWindowUsedTokens === "number" ? { contextWindowUsedTokens } : {}),
  };
}

function isSameUsage(left: ProviderUsage, right: ProviderUsage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalCostUsd === right.totalCostUsd &&
    left.contextWindowMaxTokens === right.contextWindowMaxTokens &&
    left.contextWindowUsedTokens === right.contextWindowUsedTokens
  );
}

export class PiUsagePoller {
  private readonly scheduler: PiUsagePollScheduler;
  private readonly finalWaitMs: number;
  private active = false;
  private closed = false;
  private generation = 0;
  private cancelScheduledPoll: (() => void) | null = null;
  private lastUsage: ProviderUsage | null = null;
  private refreshInFlight = false;

  constructor(private readonly options: PiUsagePollerOptions) {
    this.scheduler = options.scheduler ?? createPollScheduler();
    this.finalWaitMs = options.finalWaitMs ?? FINAL_USAGE_WAIT_MS;
  }

  startTurn(): void {
    if (this.closed || this.active) {
      return;
    }
    this.active = true;
    this.generation += 1;
    this.schedule(this.generation);
  }

  stopTurn(): void {
    this.active = false;
    this.invalidatePendingWork();
  }

  async completeTurn(turnId?: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.active = false;
    const completionGeneration = this.invalidatePendingWork();
    const usage = await this.readFinalStats();
    // The deadline may win the race; a late stats read must not publish.
    if (usage === FINAL_READ_TIMED_OUT) {
      return;
    }
    if (this.closed || this.generation !== completionGeneration) {
      return;
    }
    // A completed turn always emits its keyed sample, even when the interim
    // `refreshNow` reads already published identical stats (shared dedupe
    // would otherwise swallow the turn-correlated `session.usage`).
    this.publishUsage(usage, turnId, { force: turnId !== undefined });
  }

  // Plugin extension (NG item 6): one-shot interim refresh. Reads stats once
  // with a generation guard and publishes only changed usage. Never starts,
  // stops, or reschedules periodic polling, so it is safe from tool-end,
  // message-end, and compaction-completion paths mid-turn or idle. Read
  // failures route to `onPollError` like the periodic path, and concurrent
  // refreshes coalesce (a refresh already in flight skips) so hot paths
  // cannot stack concurrent stats RPCs.
  async refreshNow(turnId?: string): Promise<void> {
    if (this.closed || this.refreshInFlight) {
      return;
    }
    this.refreshInFlight = true;
    try {
      const generation = this.generation;
      let usage: ProviderUsage | undefined;
      try {
        usage = toAgentUsage(await this.options.readStats());
      } catch (error) {
        this.reportPollError(error, generation);
        return;
      }
      if (!this.isCurrent(generation)) {
        return;
      }
      this.publishUsage(usage, turnId);
    } finally {
      this.refreshInFlight = false;
    }
  }

  close(): void {
    this.closed = true;
    this.active = false;
    this.invalidatePendingWork();
  }

  // Plugin extension (NG item 6): final stats read bounded by `finalWaitMs`.
  // Resolves to FINAL_READ_TIMED_OUT when the deadline wins so the caller
  // can drop the sample instead of publishing a late one.
  private async readFinalStats(): Promise<ProviderUsage | undefined | typeof FINAL_READ_TIMED_OUT> {
    const read = this.options.readStats().then(
      (stats) => ({ ready: true as const, usage: toAgentUsage(stats) }),
      () => ({ ready: true as const, usage: undefined as ProviderUsage | undefined }),
    );
    if (this.finalWaitMs <= 0) {
      return (await read).usage;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<{ ready: false }>((resolve) => {
        timer = setTimeout(() => resolve({ ready: false }), this.finalWaitMs);
      });
      const result = await Promise.race([read, deadline]);
      return result.ready ? result.usage : FINAL_READ_TIMED_OUT;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private invalidatePendingWork(): number {
    this.generation += 1;
    this.cancelScheduledPoll?.();
    this.cancelScheduledPoll = null;
    return this.generation;
  }

  private schedule(generation: number): void {
    this.cancelScheduledPoll = this.scheduler.schedulePoll(() => {
      this.cancelScheduledPoll = null;
      void this.poll(generation);
    });
  }

  private async poll(generation: number): Promise<void> {
    let usage: ProviderUsage | undefined;
    try {
      usage = toAgentUsage(await this.options.readStats());
    } catch (error) {
      try {
        if (this.isCurrent(generation)) {
          this.reportPollError(error, generation);
        }
      } finally {
        if (this.isCurrent(generation)) {
          this.schedule(generation);
        }
      }
      return;
    }
    try {
      if (this.isCurrent(generation)) {
        this.publishUsage(usage);
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.schedule(generation);
      }
    }
  }

  private takeForcedUsage(usage: ProviderUsage | undefined): ProviderUsage | undefined {
    if (!usage) return undefined;
    this.lastUsage = usage;
    return usage;
  }

  private takeChangedUsage(usage: ProviderUsage | undefined): ProviderUsage | undefined {
    if (!usage || (this.lastUsage && isSameUsage(this.lastUsage, usage))) {
      return undefined;
    }
    this.lastUsage = usage;
    return usage;
  }

  private publishUsage(
    usage: ProviderUsage | undefined,
    turnId?: string,
    options: { force?: boolean } = {},
  ): void {
    const changedUsage = options.force
      ? this.takeForcedUsage(usage)
      : this.takeChangedUsage(usage);
    if (changedUsage) {
      this.deliverUsage(changedUsage, turnId);
    }
  }

  // Consumer callbacks must never escape the poller: `poll` runs detached
  // (`void this.poll(...)`) and an escaping throw becomes an unhandled
  // rejection while the loop keeps firing.
  private deliverUsage(usage: ProviderUsage, turnId?: string): void {
    try {
      this.options.onUsage(usage, turnId);
    } catch {
      // A throwing usage sink must not break the poll loop or teardown.
    }
  }

  private reportPollError(error: unknown, generation: number): void {
    if (!this.isCurrent(generation)) return;
    try {
      this.options.onPollError(error);
    } catch {
      // A throwing error sink must not break the poll loop or teardown.
    }
  }

  private isCurrent(generation: number): boolean {
    return this.active && !this.closed && this.generation === generation;
  }
}
