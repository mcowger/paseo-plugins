import { describe, expect, it, vi } from "vitest";
import { createUsageFeed, openUsageFeed, type FeedEvents } from "./usage-feed";

function fakeTimers() {
  const timers = new Map<number, { run: () => void; at: number }>();
  let now = 0;
  let next = 1;
  return {
    setTimer: (run: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { run, at: now + ms });
      return id;
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of Array.from(timers)) if (timer.at <= now) {
        timers.delete(id);
        timer.run();
      }
    },
    pending: () => timers.size,
  };
}

describe("the server's Agent list subscription for Codex turns (0.8.0)", () => {
  it("opens once while held and closes a while after the last hold", () => {
    const timers = fakeTimers();
    const opened: FeedEvents[] = [];
    const closed = vi.fn();
    const feed = createUsageFeed({ open: (events) => (opened.push(events), { close: closed }), onUpdate: vi.fn(), onGap: vi.fn(), ...timers, closeAfterMs: 1000 });
    feed.hold();
    feed.hold();
    expect(opened).toHaveLength(1);
    feed.release();
    feed.release();
    expect(closed).not.toHaveBeenCalled();
    timers.advance(500);
    feed.hold();
    timers.advance(1000);
    expect(closed).not.toHaveBeenCalled();
    feed.release();
    timers.advance(1000);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(feed.debug()).toMatchObject({ holds: 0, open: false });
  });

  it("passes updates on, and reports a gap on a second snapshot or a failure, then opens again", () => {
    const timers = fakeTimers();
    const opened: FeedEvents[] = [];
    const onUpdate = vi.fn();
    const onGap = vi.fn();
    const feed = createUsageFeed({ open: (events) => (opened.push(events), { close: vi.fn() }), onUpdate, onGap, ...timers, retryMs: 5000 });
    feed.hold();
    opened[0]!.snapshot();
    opened[0]!.update({ kind: "upsert" });
    expect(onUpdate).toHaveBeenCalledWith({ kind: "upsert" });
    expect(onGap).not.toHaveBeenCalled();
    // A reconnect resends a snapshot: what changed meanwhile was not pushed.
    opened[0]!.snapshot();
    expect(onGap).toHaveBeenCalledTimes(1);
    opened[0]!.failed(new Error("gone"));
    expect(onGap).toHaveBeenCalledTimes(2);
    // Events from the dead subscription are ignored.
    opened[0]!.update({ kind: "late" });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    timers.advance(5000);
    expect(opened).toHaveLength(2);
    feed.dispose();
    expect(timers.pending()).toBe(0);
  });

  it("reports a gap when it cannot open (no API yet) and tries again while held", () => {
    const timers = fakeTimers();
    let attempts = 0;
    const onGap = vi.fn();
    const feed = createUsageFeed({ open: () => (attempts++, null), onUpdate: vi.fn(), onGap, ...timers, retryMs: 100 });
    feed.hold();
    expect(onGap).toHaveBeenCalledTimes(1);
    timers.advance(100);
    expect(attempts).toBe(2);
    feed.release();
    timers.advance(100);
    expect(attempts).toBe(2);
  });

  it("subscribes to running and starting Agents with a one-entry snapshot, and releases on close", async () => {
    const release = vi.fn(async () => undefined);
    let observer: { snapshot(snapshot: unknown): void; update(message: unknown): void; error?(error: unknown): void } | null = null;
    const list = vi.fn(async () => ({ subscription: { subscribe: (next: typeof observer) => ((observer = next), () => (observer = null)), release } }));
    const events = { snapshot: vi.fn(), update: vi.fn(), failed: vi.fn() };
    const connection = openUsageFeed({ agents: { list } } as never, events);
    await vi.waitFor(() => expect(observer).not.toBeNull());
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ subscribe: {}, filter: { statuses: ["running", "initializing"] }, page: { limit: 1 } }));
    observer!.snapshot({});
    observer!.update({ type: "agent_update", payload: { kind: "remove", agentId: "a" } });
    observer!.update({ type: "workspace_update", payload: {} });
    expect(events.snapshot).toHaveBeenCalledTimes(1);
    expect(events.update).toHaveBeenCalledWith({ kind: "remove", agentId: "a" });
    expect(events.update).toHaveBeenCalledTimes(1);
    connection.close();
    expect(observer).toBeNull();
    expect(release).toHaveBeenCalled();
  });
});
