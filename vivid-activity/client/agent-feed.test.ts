import { describe, expect, it } from "vitest";
import { AGENT_FEED_RETRY_MS, agentFeedQuery, createAgentFeeds, openAgentFeed, type FeedApi, type FeedEvents } from "./agent-feed";

function fakeTimers() {
  let time = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    setTimer: (run: () => void, ms: number) => {
      const handle = ++next;
      timers.set(handle, { at: time + ms, run });
      return handle;
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].run();
      }
      time = end;
    },
    pending: () => timers.size,
  };
}

/** An `open` that records each subscription it opens and lets the test drive its events. */
function fakeOpen() {
  const opened: Array<{ api: object; events: FeedEvents; closed: boolean }> = [];
  const open = (api: object, events: FeedEvents) => {
    const entry = { api, events, closed: false };
    opened.push(entry);
    return { close: () => void (entry.closed = true) };
  };
  return { open, opened, live: () => opened.filter((entry) => !entry.closed) };
}

describe("plugin-level agent feed (0.5.0)", () => {
  it("opens one subscription per API instance, shared by reference count, and releases it with the last holder", () => {
    const { open, opened, live } = fakeOpen();
    const feeds = createAgentFeeds({ open, timers: fakeTimers() });
    const api = {};
    const first = feeds.acquire(api, () => undefined);
    const second = feeds.acquire(api, () => undefined);
    expect(opened).toHaveLength(1);
    expect(feeds.debug(api)).toMatchObject({ holders: 2, open: true });
    // Another host's API gets its own.
    const other = {};
    const third = feeds.acquire(other, () => undefined);
    expect(opened.map((entry) => entry.api)).toEqual([api, other]);
    first();
    first(); // releasing twice counts once
    expect(live()).toHaveLength(2);
    second();
    expect(opened[0]!.closed).toBe(true);
    expect(feeds.debug(api)).toBeNull();
    third();
    expect(live()).toHaveLength(0);
    expect(feeds.size()).toBe(0);
  });

  it("is open only while the app is in front: background releases it, coming back opens a new one", () => {
    const { open, opened, live } = fakeOpen();
    const feeds = createAgentFeeds({ open, timers: fakeTimers() });
    const api = {};
    feeds.setForeground(false);
    const release = feeds.acquire(api, () => undefined);
    expect(opened).toHaveLength(0);
    feeds.setForeground(true);
    expect(live()).toHaveLength(1);
    feeds.setForeground(false);
    expect(live()).toHaveLength(0);
    expect(feeds.debug(api)).toMatchObject({ holders: 1, open: false });
    feeds.setForeground(true);
    expect(opened).toHaveLength(2);
    expect(live()).toHaveLength(1);
    release();
    expect(live()).toHaveLength(0);
    // Nobody holds it: coming to the front again opens nothing.
    feeds.setForeground(false);
    feeds.setForeground(true);
    expect(opened).toHaveLength(2);
  });

  it("tells every holder when the subscription (re)starts, and ignores a closed subscription's late events", () => {
    const { open, opened } = fakeOpen();
    const feeds = createAgentFeeds({ open, timers: fakeTimers() });
    const api = {};
    const heard: string[] = [];
    const releaseA = feeds.acquire(api, () => void heard.push("a"));
    feeds.acquire(api, () => {
      heard.push("b");
      throw new Error("one holder failing does not stop the others");
    });
    const releaseC = feeds.acquire(api, () => void heard.push("c"));
    opened[0]!.events.snapshot(); // first snapshot
    opened[0]!.events.snapshot(); // the SDK resubscribed after a reconnect
    expect(heard).toEqual(["a", "b", "c", "a", "b", "c"]);
    releaseA();
    releaseC();
    feeds.setForeground(false);
    const stale = opened[0]!.events;
    feeds.setForeground(true);
    heard.length = 0;
    stale.snapshot();
    stale.failed(new Error("late"));
    expect(heard).toEqual([]);
    expect(opened).toHaveLength(2);
    opened[1]!.events.snapshot();
    expect(heard).toEqual(["b"]);
  });

  it("reopens a failed subscription with backoff while it is still wanted, and stops retrying once it is not", () => {
    const timers = fakeTimers();
    const { open, opened, live } = fakeOpen();
    const feeds = createAgentFeeds({ open, timers });
    const api = {};
    const release = feeds.acquire(api, () => undefined);
    opened[0]!.events.failed(new Error("request failed"));
    expect(opened[0]!.closed).toBe(true);
    expect(feeds.debug(api)).toMatchObject({ open: false, retrying: true, failures: 1 });
    timers.advance(AGENT_FEED_RETRY_MS[0]! - 1);
    expect(opened).toHaveLength(1);
    timers.advance(1);
    expect(opened).toHaveLength(2);
    opened[1]!.events.failed(new Error("again"));
    timers.advance(AGENT_FEED_RETRY_MS[1]! - 1);
    expect(opened).toHaveLength(2);
    timers.advance(1);
    expect(opened).toHaveLength(3);
    // A snapshot means it works again: the next failure starts the backoff over.
    opened[2]!.events.snapshot();
    opened[2]!.events.failed(new Error("dropped after a reconnect"));
    expect(feeds.debug(api)).toMatchObject({ failures: 1 });
    // Background during the wait: no retry, and none after coming back either until it opens again.
    feeds.setForeground(false);
    expect(timers.pending()).toBe(0);
    feeds.setForeground(true);
    expect(opened).toHaveLength(4);
    opened[3]!.events.failed(new Error("once more"));
    release();
    expect(timers.pending()).toBe(0);
    timers.advance(60_000);
    expect(opened).toHaveLength(4);
    expect(live()).toHaveLength(0);
    expect(feeds.size()).toBe(0);
  });

  it("copes with an open that fails or snapshots before it returns", () => {
    const timers = fakeTimers();
    const closed: string[] = [];
    let mode: "fail" | "snapshot" = "fail";
    const feeds = createAgentFeeds({
      timers,
      open: (_api, events) => {
        if (mode === "fail") events.failed(new Error("disposed"));
        else events.snapshot();
        const name = mode;
        return { close: () => void closed.push(name) };
      },
    });
    const api = {};
    let heard = 0;
    const release = feeds.acquire(api, () => void heard++);
    expect(closed).toEqual(["fail"]);
    expect(feeds.debug(api)).toMatchObject({ open: false, retrying: true });
    mode = "snapshot";
    timers.advance(AGENT_FEED_RETRY_MS[0]!);
    expect(heard).toBe(1);
    expect(feeds.debug(api)).toMatchObject({ open: true, retrying: false, failures: 0 });
    release();
    expect(closed).toEqual(["fail", "snapshot"]);
  });
});

/** A stand-in for the SDK's `agents.list({ subscribe })`: the owned subscription and its observer. */
function fakeApi() {
  const calls: Array<ReturnType<typeof agentFeedQuery>> = [];
  let observer: { snapshot(snapshot: unknown): void; update(message: unknown): void; error?(error: unknown): void } | null = null;
  let resolveList: (() => void) | null = null;
  let rejectList: ((error: unknown) => void) | null = null;
  const state = { released: 0, detached: 0 };
  const subscription = {
    subscribe(next: NonNullable<typeof observer>) {
      observer = next;
      next.snapshot({ entries: [] }); // the SDK hands a new observer the current snapshot at once
      return () => {
        state.detached += 1;
        observer = null;
      };
    },
    release: async () => {
      state.released += 1;
    },
  };
  const api: FeedApi = {
    agents: {
      list(options) {
        calls.push(options);
        return new Promise((resolve, reject) => {
          resolveList = () => resolve({ subscription });
          rejectList = reject;
        });
      },
    },
  };
  return {
    api,
    calls,
    state,
    observer: () => observer,
    resolve: () => resolveList?.(),
    reject: (error: unknown) => rejectList?.(error),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("openAgentFeed (0.5.0)", () => {
  it("subscribes to running and starting agents with a one-entry snapshot, and reports each snapshot and a failure", async () => {
    const fake = fakeApi();
    const heard: string[] = [];
    const connection = openAgentFeed(fake.api, { snapshot: () => void heard.push("snapshot"), failed: () => void heard.push("failed") });
    await settle();
    expect(fake.calls).toHaveLength(1);
    const { signal, ...query } = fake.calls[0]!;
    expect(query).toEqual({ subscribe: {}, filter: { statuses: ["running", "initializing"] }, page: { limit: 1 } });
    expect(signal.aborted).toBe(false);
    fake.resolve();
    await settle();
    expect(heard).toEqual(["snapshot"]);
    // After a reconnect the SDK hands the observer the new snapshot; a failed resubscription reports an error.
    fake.observer()!.snapshot({ entries: [] });
    fake.observer()!.update({ type: "agent_update" });
    fake.observer()!.error!(new Error("resubscribe failed"));
    expect(heard).toEqual(["snapshot", "snapshot", "failed"]);
    connection.close();
    connection.close();
    expect(fake.state).toEqual({ released: 1, detached: 1 });
    expect(signal.aborted).toBe(true);
  });

  it("closing before the daemon answers aborts the request and releases the subscription once it arrives", async () => {
    const fake = fakeApi();
    let heard = 0;
    const connection = openAgentFeed(fake.api, { snapshot: () => void heard++, failed: () => void heard++ });
    await settle();
    connection.close();
    expect(fake.calls[0]!.signal.aborted).toBe(true);
    fake.resolve();
    await settle();
    expect(fake.state.released).toBe(1);
    expect(fake.observer()).toBeNull();
    expect(heard).toBe(0);
  });

  it("reports a failed request, unless it was closed first", async () => {
    const failing = fakeApi();
    const heard: unknown[] = [];
    openAgentFeed(failing.api, { snapshot: () => undefined, failed: (error) => void heard.push(error) });
    await settle();
    failing.reject(new Error("Subscription failed"));
    await settle();
    expect(heard).toHaveLength(1);
    const closedFirst = fakeApi();
    const connection = openAgentFeed(closedFirst.api, { snapshot: () => undefined, failed: (error) => void heard.push(error) });
    await settle();
    connection.close();
    closedFirst.reject(new Error("Subscription released"));
    await settle();
    expect(heard).toHaveLength(1);
    // An API that throws at once (disposed) is a failure too, not an exception in the caller.
    const disposed: FeedApi = { agents: { list: () => { throw new Error("Paseo API is disposed"); } } };
    openAgentFeed(disposed, { snapshot: () => undefined, failed: (error) => void heard.push(error) });
    await settle();
    expect(heard).toHaveLength(2);
  });
});
