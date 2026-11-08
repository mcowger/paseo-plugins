import { describe, expect, it } from "vitest";
import { createAgentFeeds } from "./agent-feed";
import { createAttentionStores, watchPendingPermissions, type WatchedAgent } from "./attention-store";
import { FOLD_TIMING } from "./fold-runtime";

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

describe("pending permission stores", () => {
  it("does not read or subscribe to provider subagent ids", () => {
    let reads = 0;
    let subscriptions = 0;
    const pending: unknown[] = [];
    const agent = { refresh: () => { reads++; throw new Error("must not request"); }, subscribe: () => { subscriptions++; throw new Error("must not subscribe"); } } as unknown as WatchedAgent;
    const stop = watchPendingPermissions(agent, "provider:parent:child", (value) => pending.push(value), () => { subscriptions++; return () => {}; });
    stop();
    expect(reads).toBe(0);
    expect(subscriptions).toBe(0);
    expect(pending).toEqual([[]]);
  });
  it("shares one subscription per Agent and drops the Agent's store once no row has used it for forgetMs (0.4.1)", () => {
    const timers = fakeTimers();
    const stores = createAttentionStores(timers);
    let subscribed = 0;
    let unsubscribed = 0;
    const subscribe = () => {
      subscribed += 1;
      return () => void (unsubscribed += 1);
    };
    const first = stores.acquire("agent-1", subscribe);
    const second = stores.acquire("agent-1", subscribe);
    expect(second).toBe(first);
    expect(subscribed).toBe(1);
    let heard = 0;
    const stop = stores.listen("agent-1", () => void (heard += 1));
    stores.publish(first, [{ metadata: { toolUseId: "toolu_1" } }]);
    expect(heard).toBe(1);
    expect([...stores.snapshot("agent-1")!.ids]).toEqual(["toolu_1"]);
    expect(stores.snapshot("agent-1")!.any).toBe(true);

    stores.release("agent-1", first);
    expect(unsubscribed).toBe(0);
    stores.release("agent-1", second);
    expect(unsubscribed).toBe(1);
    stop();
    timers.advance(FOLD_TIMING.forgetMs - 1);
    expect(stores.size()).toBe(1);
    timers.advance(1);
    expect(stores.size()).toBe(0);
    expect(stores.snapshot("agent-1")).toBeUndefined();
    expect(timers.pending()).toBe(0);
    // A late answer for the dropped store does not bring it back.
    stores.publish(first, []);
    expect(stores.size()).toBe(0);
  });

  it("publishes Codex item ids and which requests are questions, and stays quiet when nothing changed (0.6.0)", () => {
    const stores = createAttentionStores(fakeTimers());
    const store = stores.acquire("agent-q", () => () => undefined);
    let heard = 0;
    const stop = stores.listen("agent-q", () => void (heard += 1));
    const codexCommand = { kind: "tool", metadata: { itemId: "item_cmd_1", threadId: "t", turnId: "u" } };
    stores.publish(store, [codexCommand]);
    expect([...store.ids]).toEqual(["item_cmd_1"]);
    expect(store.questions.size).toBe(0);
    expect(store.onlyQuestions).toBe(false);
    expect(heard).toBe(1);
    // The same requests again: no news for the rows.
    stores.publish(store, [{ ...codexCommand }]);
    expect(heard).toBe(1);
    // An approval turning into a question for the same id is news.
    stores.publish(store, [{ kind: "question", metadata: { itemId: "item_cmd_1" } }]);
    expect(heard).toBe(2);
    expect([...store.questions]).toEqual(["item_cmd_1"]);
    expect(store.onlyQuestions).toBe(true);
    // A question without an id (some providers say nothing about the row): onlyQuestions tells the latest row what to say.
    stores.publish(store, [{ kind: "question", metadata: { source: "mock" } }]);
    expect(store.ids.size).toBe(0);
    expect(store.any).toBe(true);
    expect(store.onlyQuestions).toBe(true);
    stores.publish(store, []);
    expect({ any: store.any, onlyQuestions: store.onlyQuestions, ids: store.ids.size, questions: store.questions.size }).toEqual({ any: false, onlyQuestions: false, ids: 0, questions: 0 });
    stop();
    stores.release("agent-q", store);
  });

  it("keeps a store that is used again in time, and one that still has a listener (0.4.1)", () => {
    const timers = fakeTimers();
    const stores = createAttentionStores(timers);
    const subscribe = () => () => undefined;
    const store = stores.acquire("agent-1", subscribe);
    stores.release("agent-1", store);
    timers.advance(FOLD_TIMING.forgetMs / 2);
    const again = stores.acquire("agent-1", subscribe);
    expect(again).toBe(store);
    stores.release("agent-1", again);
    const stop = stores.listen("agent-1", () => undefined);
    timers.advance(FOLD_TIMING.forgetMs * 2);
    expect(stores.size()).toBe(1);
    stop();
    timers.advance(FOLD_TIMING.forgetMs);
    expect(stores.size()).toBe(0);
  });
});

type Update = Parameters<Parameters<WatchedAgent["subscribe"]>[0]>[0];

/** An agent handle whose reads the test answers one by one, and whose pushes it sends. */
function fakeAgent(agentId: string) {
  let handler: ((update: Update) => void) | null = null;
  const reads: Array<(pending: Array<{ metadata?: Record<string, unknown> }>) => void> = [];
  const agent: WatchedAgent & { pendingPermissions: Array<{ metadata?: Record<string, unknown> }> } = {
    pendingPermissions: [],
    refresh() {
      return new Promise((resolve) => {
        reads.push((pending) => {
          agent.pendingPermissions = pending;
          resolve(undefined);
        });
      });
    },
    subscribe(next) {
      handler = next;
      return () => {
        handler = null;
      };
    },
  };
  return {
    agent,
    reads,
    push: (pending: Array<{ metadata?: Record<string, unknown> }>, id = agentId) => handler?.({ kind: "upsert", agent: { id, pendingPermissions: pending } }),
    remove: (id = agentId) => handler?.({ kind: "remove", agentId: id }),
    subscribed: () => handler !== null,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const ask = (callId: string) => ({ metadata: { toolCallId: callId } });

describe("live pending permissions (0.5.0)", () => {
  it("publishes pushed changes of its own Agent, and reads the record at the start and on each feed snapshot", async () => {
    const fake = fakeAgent("agent-1");
    const published: string[][] = [];
    let onSnapshot: (() => void) | null = null;
    let held = 0;
    const stop = watchPendingPermissions(fake.agent, "agent-1", (pending) => void published.push((pending ?? []).map((entry) => String(entry?.metadata?.toolCallId))), (listener) => {
      held += 1;
      onSnapshot = listener;
      return () => void (held -= 1);
    });
    expect(held).toBe(1);
    expect(fake.reads).toHaveLength(1);
    fake.reads[0]!([]);
    await settle();
    expect(published).toEqual([[]]);
    // The request arrives while the chat is on screen: pushed at once.
    fake.push([ask("call-1")]);
    fake.push([ask("other")], "agent-2");
    expect(published).toEqual([[], ["call-1"]]);
    // Approved: the next push has none.
    fake.push([]);
    expect(published.at(-1)).toEqual([]);
    // The feed restarted (reconnect, or back from the background): read again.
    onSnapshot!();
    expect(fake.reads).toHaveLength(2);
    fake.reads[1]!([ask("call-2")]);
    await settle();
    expect(published.at(-1)).toEqual(["call-2"]);
    // It left the running Agents (turn over, or it cannot be placed): read instead of guessing.
    fake.remove();
    fake.remove("agent-2");
    expect(fake.reads).toHaveLength(3);
    fake.reads[2]!([]);
    await settle();
    expect(published.at(-1)).toEqual([]);
    stop();
    expect(held).toBe(0);
    expect(fake.subscribed()).toBe(false);
  });

  it("never overlaps reads, runs a requested one after the current, and drops a read a push overtook", async () => {
    const fake = fakeAgent("agent-1");
    const published: string[][] = [];
    let onSnapshot: (() => void) | null = null;
    const stop = watchPendingPermissions(fake.agent, "agent-1", (pending) => void published.push((pending ?? []).map((entry) => String(entry?.metadata?.toolCallId))), (listener) => {
      onSnapshot = listener;
      return () => undefined;
    });
    // A snapshot right after the start: one read in flight, a second one queued.
    onSnapshot!();
    onSnapshot!();
    expect(fake.reads).toHaveLength(1);
    // A push lands while the read is out: it is at least as new, so the read's older answer is dropped.
    fake.push([ask("call-1")]);
    fake.reads[0]!([]);
    await settle();
    expect(published).toEqual([["call-1"]]);
    // The queued read starts after the push, so its answer counts.
    expect(fake.reads).toHaveLength(2);
    fake.reads[1]!([ask("call-1")]);
    await settle();
    expect(published).toEqual([["call-1"], ["call-1"]]);
    // Stopped: a late answer and late pushes change nothing.
    onSnapshot!();
    stop();
    fake.reads[2]!([]);
    await settle();
    fake.push([]);
    expect(published).toEqual([["call-1"], ["call-1"]]);
  });

  it("holds one feed per API across Agents and rows, and reads every watched Agent when it (re)starts", async () => {
    const opened: Array<{ snapshot(): void; failed(error: unknown): void }> = [];
    const closed: number[] = [];
    const feeds = createAgentFeeds<object>({
      open: (_api, events) => {
        opened.push(events);
        const index = opened.length - 1;
        return { close: () => void closed.push(index) };
      },
    });
    const api = {};
    const stores = createAttentionStores();
    const agents = new Map([["agent-1", fakeAgent("agent-1")], ["agent-2", fakeAgent("agent-2")]]);
    const mount = (agentId: string) => {
      const store = stores.acquire(agentId, (subscribed) =>
        watchPendingPermissions(agents.get(agentId)!.agent, agentId, (pending) => stores.publish(subscribed, pending), (listener) => feeds.acquire(api, listener)));
      return () => stores.release(agentId, store);
    };
    const rows = [mount("agent-1"), mount("agent-1"), mount("agent-2")];
    const one = agents.get("agent-1")!;
    const two = agents.get("agent-2")!;
    expect(opened).toHaveLength(1);
    expect([one.reads.length, two.reads.length]).toEqual([1, 1]);
    // The feed's first snapshot: each Agent reads again once its current read is back, so a change between its first
    // read and the subscription is not lost.
    opened[0]!.snapshot();
    expect([one.reads.length, two.reads.length]).toEqual([1, 1]);
    one.reads[0]!([]);
    two.reads[0]!([]);
    await settle();
    expect([one.reads.length, two.reads.length]).toEqual([2, 2]);
    one.reads[1]!([]);
    two.reads[1]!([]);
    await settle();
    one.push([ask("call-9")]);
    expect([...stores.snapshot("agent-1")!.ids]).toEqual(["call-9"]);
    // The app goes to the background and comes back: a new subscription, and each Agent reads its record again.
    feeds.setForeground(false);
    expect(closed).toEqual([0]);
    feeds.setForeground(true);
    expect(opened).toHaveLength(2);
    opened[1]!.snapshot();
    expect([one.reads.length, two.reads.length]).toEqual([3, 3]);
    one.reads[2]!([]);
    await settle();
    expect(stores.snapshot("agent-1")!.ids.size).toBe(0);
    for (const release of rows) release();
    expect(closed).toEqual([0, 1]);
    expect(feeds.size()).toBe(0);
  });
});
