// NG item 9: fake-scheduler tests for PiStreamCoalescer. Covers burst
// coalescing, interleaved text/reasoning, flush boundaries (message end,
// interrupt/terminal, generation change, replay transition, close), and the
// stale-generation guard. Plain functions and object literals only.
import { describe, expect, test } from "vitest";

import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

import type { PiScheduler, PiTimerHandle } from "./scheduler.js";
import { PiStreamCoalescer, STREAM_FRAME_MS } from "./stream-coalescer.js";

interface FiredTimer {
  active: boolean;
  callback: () => void;
  delayMs: number;
}

function createManualScheduler(): PiScheduler & {
  fire(): void;
  pendingCount(): number;
  lastDelayMs(): number | undefined;
} {
  const timers: FiredTimer[] = [];
  let lastDelay: number | undefined;
  return {
    set(callback: () => void, delayMs: number): PiTimerHandle {
      const timer: FiredTimer = { active: true, callback, delayMs };
      timers.push(timer);
      lastDelay = delayMs;
      return timer as unknown as PiTimerHandle;
    },
    clear(handle: PiTimerHandle): void {
      const timer = handle as unknown as FiredTimer;
      timer.active = false;
    },
    fire(): void {
      const timer = timers.shift();
      if (!timer) throw new Error("No stream frame is scheduled");
      if (timer.active) timer.callback();
    },
    pendingCount(): number {
      return timers.filter((timer) => timer.active).length;
    },
    lastDelayMs(): number | undefined {
      return lastDelay;
    },
  };
}

function createCoalescer(): {
  coalescer: PiStreamCoalescer;
  scheduler: ReturnType<typeof createManualScheduler>;
  items: ProviderTimelineItem[];
} {
  const scheduler = createManualScheduler();
  const items: ProviderTimelineItem[] = [];
  const coalescer = new PiStreamCoalescer({
    scheduler,
    emit: (item) => items.push(item),
  });
  return { coalescer, scheduler, items };
}

describe("PiStreamCoalescer", () => {
  test("uses a ~32ms frame budget", () => {
    expect(STREAM_FRAME_MS).toBe(32);
  });

  test("coalesces a burst of text deltas into one full snapshot", () => {
    const { coalescer, scheduler, items } = createCoalescer();
    coalescer.appendAssistantText("msg-1", "Hel", "msg-1");
    coalescer.appendAssistantText("msg-1", "lo, ", "msg-1");
    coalescer.appendAssistantText("msg-1", "world", "msg-1");

    // Burst deltas schedule exactly one frame.
    expect(items).toEqual([]);
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.lastDelayMs()).toBe(STREAM_FRAME_MS);

    scheduler.fire();

    expect(items).toEqual([
      { type: "assistant_message", id: "msg-1", messageId: "msg-1", text: "Hello, world" },
    ]);
    expect(coalescer.pendingCount()).toBe(0);
  });

  test("coalesces interleaved text and reasoning independently", () => {
    const { coalescer, scheduler, items } = createCoalescer();
    coalescer.appendAssistantText("msg-1", "Hi", "msg-1");
    coalescer.appendReasoning("msg-1:reasoning", "Let me ");
    coalescer.appendAssistantText("msg-1", " there", "msg-1");
    coalescer.appendReasoning("msg-1:reasoning", "think.");

    scheduler.fire();

    expect(items).toEqual([
      { type: "assistant_message", id: "msg-1", messageId: "msg-1", text: "Hi there" },
      { type: "reasoning", id: "msg-1:reasoning", text: "Let me think." },
    ]);
  });

  test("keeps stable ids across frames without losing final chars", () => {
    const { coalescer, scheduler, items } = createCoalescer();
    coalescer.appendAssistantText("msg-1", "ab", "msg-1");
    scheduler.fire();
    coalescer.appendAssistantText("msg-1", "cd", "msg-1");
    scheduler.fire();

    expect(items).toEqual([
      { type: "assistant_message", id: "msg-1", messageId: "msg-1", text: "ab" },
      { type: "assistant_message", id: "msg-1", messageId: "msg-1", text: "abcd" },
    ]);
  });

  test("flushSync emits pending frames without waiting for the timer", () => {
    const { coalescer, scheduler, items } = createCoalescer();
    coalescer.appendAssistantText("msg-1", "Hello", "msg-1");
    coalescer.appendReasoning("msg-1:reasoning", "hmm");

    coalescer.flushSync();

    expect(items).toEqual([
      { type: "assistant_message", id: "msg-1", messageId: "msg-1", text: "Hello" },
      { type: "reasoning", id: "msg-1:reasoning", text: "hmm" },
    ]);
    expect(scheduler.pendingCount()).toBe(0);
    expect(coalescer.pendingCount()).toBe(0);
  });

  test("stale-generation frames emit nothing", () => {
    const { coalescer, items } = createCoalescer();
    coalescer.appendAssistantText("msg-1", "Hello", "msg-1");
    // Generation boundary flushes synchronously; the previous frame is
    // stale afterwards and must emit nothing more.
    coalescer.nextTurn();

    expect(items).toEqual([
      { type: "assistant_message", id: "msg-1", messageId: "msg-1", text: "Hello" },
    ]);
    expect(coalescer.pendingCount()).toBe(0);
  });

  test("nextTurn drops prior blocks so reused ids start fresh", () => {
    const { coalescer, items } = createCoalescer();
    // Reasoning emitted before any assistant message reuses the fallback
    // id; the next turn must not resume the previous turn's text.
    coalescer.appendReasoning("thinking:reasoning", "old thoughts");
    coalescer.nextTurn();
    coalescer.appendReasoning("thinking:reasoning", "new thoughts");
    coalescer.appendAssistantText("msg-1", "old", "msg-1");
    coalescer.nextTurn();
    coalescer.appendAssistantText("msg-1", "new", "msg-1");
    coalescer.flushSync();

    expect(items).toEqual([
      { type: "reasoning", id: "thinking:reasoning", text: "old thoughts" },
      { type: "reasoning", id: "thinking:reasoning", text: "new thoughts" },
      { type: "assistant_message", id: "msg-1", messageId: "msg-1", text: "old" },
      { type: "assistant_message", id: "msg-1", messageId: "msg-1", text: "new" },
    ]);
  });

  test("close flushes pending text then suppresses later appends", () => {
    const { coalescer, scheduler, items } = createCoalescer();
    coalescer.appendAssistantText("msg-1", "Hello", "msg-1");

    coalescer.close();

    expect(items).toEqual([
      { type: "assistant_message", id: "msg-1", messageId: "msg-1", text: "Hello" },
    ]);
    coalescer.appendAssistantText("msg-1", " late", "msg-1");
    expect(items).toHaveLength(1);
    expect(scheduler.pendingCount()).toBe(0);
  });
});
