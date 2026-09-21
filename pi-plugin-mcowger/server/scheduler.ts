// Shared injectable timer seam for server-side deferred emission (NG items 6, 9).
// Item 6 wires usage polling through it; item 9 will reuse it for streaming
// frame coalescing. Production code uses `nodeScheduler` (real timers);
// tests inject a manual fake. Plain functions and object literals only.

// Upstream `PiUsagePollScheduler` shape lives here (next to `PiScheduler`)
// so `server/usage-poller.ts` can import it without a module cycle.
export interface PiUsagePollScheduler {
  schedulePoll(callback: () => void): () => void;
}

export const PI_USAGE_POLL_INTERVAL_MS = 3_000;

export type PiTimerHandle = ReturnType<typeof setTimeout>;

export interface PiScheduler {
  set(callback: () => void, delayMs: number): PiTimerHandle;
  clear(handle: PiTimerHandle): void;
}

function createNodeScheduler(): PiScheduler {
  return {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: (handle) => clearTimeout(handle),
  };
}

export const nodeScheduler: PiScheduler = createNodeScheduler();

// Adapt the shared seam to the upstream `PiUsagePollScheduler` shape so
// `server/usage-poller.ts` stays structurally parallel to its upstream
// counterpart while remaining fake-timer testable.
export function createPollScheduler(
  scheduler: PiScheduler = nodeScheduler,
  delayMs: number = PI_USAGE_POLL_INTERVAL_MS,
): PiUsagePollScheduler {
  return {
    schedulePoll: (callback) => {
      const handle = scheduler.set(callback, delayMs);
      return () => scheduler.clear(handle);
    },
  };
}
