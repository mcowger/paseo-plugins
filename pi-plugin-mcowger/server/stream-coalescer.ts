// Diff-on-touch source: paseo-omp timeline-projector STREAM_FRAME_MS /
// OmpTimelineScheduler pattern (technique reference only, not a port).
// NG item 9: coalesce live `message_update` text/reasoning deltas behind the
// shared `server/scheduler.ts` seam (reused from item 6) so streaming stays
// smooth without changing item 4's synchronous replay snapshot semantics.
// Plain functions and object literals only.

import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

import { nodeScheduler, type PiScheduler, type PiTimerHandle } from "./scheduler.js";

// Single streaming frame budget (paseo-omp STREAM_FRAME_MS pattern): at most
// one scheduled flush per active text/reasoning block per frame.
export const STREAM_FRAME_MS = 32;

export interface PiStreamCoalescerOptions {
  scheduler?: PiScheduler;
  emit(item: ProviderTimelineItem): void;
}

interface PendingBlock {
  id: string;
  messageId?: string;
  kind: "text" | "reasoning";
  cumulative: string;
  dirty: boolean;
}

export class PiStreamCoalescer {
  private readonly scheduler: PiScheduler;
  private readonly emitItem: (item: ProviderTimelineItem) => void;
  private readonly blocks = new Map<string, PendingBlock>();
  private scheduled: PiTimerHandle | null = null;
  private generation = 0;
  private closed = false;

  constructor(options: PiStreamCoalescerOptions) {
    this.scheduler = options.scheduler ?? nodeScheduler;
    this.emitItem = options.emit;
  }

  appendAssistantText(id: string, delta: string, messageId?: string): void {
    this.append(id, "text", delta, messageId);
  }

  appendReasoning(id: string, delta: string): void {
    this.append(id, "reasoning", delta);
  }

  // Synchronous flush: emits one full cumulative snapshot per dirty block
  // with stable ids. Called before message end, accepted terminals,
  // interrupt, generation change, replay transition, and close so no final
  // character is ever lost to a pending frame.
  flushSync(): void {
    if (this.scheduled !== null) {
      this.scheduler.clear(this.scheduled);
      this.scheduled = null;
    }
    this.flushDirty();
  }

  // Turn/generation boundary: flush pending frames synchronously, drop
  // every prior turn's accumulated block text (unbounded growth + stale
  // reasoning replay when the next turn reuses an id like
  // `thinking:reasoning`), then bump the generation so already-fired
  // scheduled callbacks from the previous generation emit nothing.
  nextTurn(): void {
    this.flushSync();
    this.blocks.clear();
    this.generation += 1;
  }

  pendingCount(): number {
    let count = 0;
    for (const block of this.blocks.values()) {
      if (block.dirty) count += 1;
    }
    return count;
  }

  close(): void {
    if (this.closed) return;
    this.flushSync();
    this.closed = true;
    this.blocks.clear();
  }

  private append(id: string, kind: "text" | "reasoning", delta: string, messageId?: string): void {
    if (this.closed) return;
    const generation = this.generation;
    let block = this.blocks.get(id);
    if (!block || block.kind !== kind) {
      block = { id, kind, cumulative: "", dirty: false };
      this.blocks.set(id, block);
    }
    if (messageId !== undefined) block.messageId = messageId;
    block.cumulative += delta;
    block.dirty = true;
    this.schedule(generation);
  }

  private schedule(generation: number): void {
    if (this.scheduled !== null) return;
    this.scheduled = this.scheduler.set(() => {
      this.scheduled = null;
      // Stale-generation guard (NG item 9): a frame scheduled before a
      // turn/generation boundary must emit nothing.
      if (generation !== this.generation || this.closed) return;
      this.flushDirty();
    }, STREAM_FRAME_MS);
  }

  private flushDirty(): void {
    // Collect-then-emit: every dirty block is marked clean before the
    // first emission, so a nested flushSync triggered by an emission
    // callback (e.g. the session timeline ordering boundary) finds nothing
    // dirty instead of emitting later blocks re-entrantly out of order.
    const pending: PendingBlock[] = [];
    for (const block of this.blocks.values()) {
      if (!block.dirty) continue;
      block.dirty = false;
      pending.push(block);
    }
    for (const block of pending) {
      if (block.kind === "text") {
        this.emitItem({
          type: "assistant_message",
          id: block.id,
          ...(block.messageId !== undefined ? { messageId: block.messageId } : {}),
          text: block.cumulative,
        });
      } else {
        this.emitItem({ type: "reasoning", id: block.id, text: block.cumulative });
      }
    }
  }
}
