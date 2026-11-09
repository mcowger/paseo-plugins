import { afterEach, describe, expect, it, vi } from "vitest";
import { createChildRefresh } from "./child-refresh";

const settle = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("child summary refresh", () => {
  it("reads a continuous stream at five-second intervals and keeps the final trailing update", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const reads: number[] = [];
    const refresh = createChildRefresh({ allowed: () => true, read: async () => { reads.push(Date.now()); } });
    refresh.request({ immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    for (let n = 0; n < 119; n++) {
      await vi.advanceTimersByTimeAsync(500);
      refresh.request();
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(reads).toEqual(Array.from({ length: 13 }, (_, n) => n * 5000));
    refresh.dispose();
  });

  it("refreshes a status transition immediately and resets the trailing interval", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const reads: number[] = [];
    const refresh = createChildRefresh({ allowed: () => true, read: async () => { reads.push(Date.now()); } });
    refresh.request(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000); refresh.request();
    await vi.advanceTimersByTimeAsync(1000); refresh.request({ immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    refresh.request(); await vi.advanceTimersByTimeAsync(4999);
    expect(reads).toEqual([0, 2000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toEqual([0, 2000, 7000]);
    refresh.dispose();
  });

  it("does not overlap slow reads and keeps a queued status change ahead of ordinary updates", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const requests: boolean[] = [];
    let finish: (() => void) | undefined;
    const refresh = createChildRefresh({ allowed: () => true, read: async (manual) => {
      requests.push(manual); await new Promise<void>((resolve) => { finish = resolve; });
    } });
    refresh.request(); await vi.advanceTimersByTimeAsync(0);
    refresh.request({ manual: true, immediate: true });
    for (let n = 0; n < 100; n++) refresh.request();
    await vi.advanceTimersByTimeAsync(6000); expect(requests).toEqual([false]);
    finish!(); await settle(); await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual([false, true]);
    refresh.dispose(); finish!(); await settle();
  });

  it("drops a pending automatic read after the card leaves view, and cancels on unmount", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let allowed = true;
    const read = vi.fn(async () => {});
    const refresh = createChildRefresh({ allowed: () => allowed, read });
    refresh.request(); await vi.advanceTimersByTimeAsync(0);
    refresh.request(); allowed = false; await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(1);
    refresh.request({ manual: true, immediate: true }); await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    refresh.request({ immediate: true }); refresh.dispose(); await vi.advanceTimersByTimeAsync(6000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never queues a quiet-spell read behind a read on its way or one already queued (0.6.0-local.5, codex-vivid-merge-F1)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const reads: number[] = [];
    let finish: (() => void) | undefined;
    const refresh = createChildRefresh({ allowed: () => true, read: async () => {
      reads.push(Date.now()); await new Promise<void>((resolve) => { finish = resolve; });
    } });
    refresh.request({ immediate: true }); await vi.advanceTimersByTimeAsync(0);
    refresh.request({ quiet: true });
    await vi.advanceTimersByTimeAsync(11_000); finish!(); await settle(); await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual([0]);
    // A host update queues a read; a quiet spell falling due before it runs adds nothing.
    refresh.request(); refresh.request({ quiet: true });
    await vi.advanceTimersByTimeAsync(0); finish!(); await settle(); await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toEqual([0, 11_000]);
    // Nothing on its way, nothing queued: the quiet spell reads.
    refresh.request({ quiet: true }); await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual([0, 11_000, 21_000]);
    refresh.dispose(); finish!(); await settle();
  });
});


it("does not start a read when unmounted between the timer callback and its microtask", async () => {
  let fire: (() => void) | undefined;
  const read = vi.fn(async () => {});
  const refresh = createChildRefresh({ allowed: () => true, read, setTimer: (run) => { fire = run; return 1; }, clearTimer: () => {} });
  refresh.request({ immediate: true });
  fire!();
  refresh.dispose();
  await settle();
  expect(read).not.toHaveBeenCalled();
});
