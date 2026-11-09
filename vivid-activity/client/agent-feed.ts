import type { usePaseo } from "@getpaseo/plugin/client";

/**
 * 0.5.0：插件级的 Agent 列表订阅，只为让 Paseo 把 agent_update 推给本插件。SDK 只在同一个 API 实例调用过
 * `agents.list({ subscribe })` 时，才把 daemon 的 agent_update 转给 `agents.ref(id).subscribe()`（@getpaseo/client
 * `dist/index.js` 的 `listAgents`）；宿主给每个插件建自己的 API 实例（`createPaseoApi(client)`），宿主自己的订阅不会转过来。
 * 所以「等你批准」要实时出现，插件得自己开一份。
 *
 * - 每个 API 实例（每台主机）只开一份，按引用计数共用：有运行中的工具行挂着时由 attention 持有；
 * - 只在 App 前台时打开；没有引用或 App 进入后台就 release()，回到前台再开；
 * - 断线重连后 SDK 自己重新订阅并重发快照。每次拿到快照（首次、重连后、回到前台）都通知持有者，各自重读一次
 *   Agent 记录，补上订阅中断期间错过的变化；订阅失败（包括重连后重新订阅失败）就按退避重开。
 * - 流量：daemon 按订阅的 filter 推送，符合的 Agent 推完整的 upsert，不符合的只推一条 remove（agent-updates-service
 *   `publishPayload`），所以只订阅运行中、启动中的 Agent：等你批准只发生在运行中。`page.limit` 只限制快照，不影响之后的
 *   推送，快照只要 1 条，持有者靠重读拿到自己关心的 Agent。
 */
export type PaseoApi = ReturnType<typeof usePaseo>;

export interface FeedTimers {
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const REAL_TIMERS: FeedTimers = {
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What an open subscription reports: it (re)started with a fresh snapshot, or it is gone and must be reopened. */
export interface FeedEvents {
  snapshot(): void;
  failed(error: unknown): void;
}
export interface FeedConnection {
  close(): void;
}
export type OpenFeed<Api> = (api: Api, events: FeedEvents) => FeedConnection;

/** Delays before reopening a failed subscription; the last one repeats. */
export const AGENT_FEED_RETRY_MS: readonly number[] = [2_000, 10_000, 30_000];

interface Holder {
  onSnapshot(): void;
}
interface Feed<Api> {
  readonly api: Api;
  readonly holders: Set<Holder>;
  connection: FeedConnection | null;
  /** The open attempt events may still come from; null when none is open. */
  token: object | null;
  retry: unknown;
  failures: number;
}

/** The plugin's feeds, one per API instance (one per plugin evaluation); `open` is injected so tests need no daemon. */
export function createAgentFeeds<Api extends object>(options: { open: OpenFeed<Api>; timers?: FeedTimers; retryMs?: readonly number[] }) {
  const { open } = options;
  const timers = options.timers ?? REAL_TIMERS;
  const retryMs = options.retryMs ?? AGENT_FEED_RETRY_MS;
  const feeds = new Map<Api, Feed<Api>>();
  let foreground = true;

  function stop(feed: Feed<Api>): void {
    if (feed.retry !== null) {
      timers.clearTimer(feed.retry);
      feed.retry = null;
    }
    const connection = feed.connection;
    feed.connection = null;
    feed.token = null;
    feed.failures = 0;
    connection?.close();
  }

  function start(feed: Feed<Api>): void {
    const token = {};
    feed.token = token;
    const connection = open(feed.api, {
      snapshot() {
        if (feed.token !== token) return;
        feed.failures = 0;
        for (const holder of feed.holders) {
          try {
            holder.onSnapshot();
          } catch {
            // One holder's failure must not keep the others stale.
          }
        }
      },
      failed() {
        if (feed.token !== token) return;
        const dead = feed.connection;
        feed.connection = null;
        feed.token = null;
        dead?.close();
        if (feed.holders.size === 0 || !foreground) return;
        const delay = retryMs[Math.min(feed.failures, retryMs.length - 1)] ?? 30_000;
        feed.failures += 1;
        feed.retry = timers.setTimer(() => {
          feed.retry = null;
          sync(feed);
        }, delay);
      },
    });
    if (feed.token === token) feed.connection = connection;
    else connection.close();
  }

  /** Opens the feed while someone holds it and the app is in front; otherwise closes it (and forgets an unheld one). */
  function sync(feed: Feed<Api>): void {
    if (feed.holders.size > 0 && foreground) {
      if (feed.connection === null && feed.token === null && feed.retry === null) start(feed);
      return;
    }
    stop(feed);
    if (feed.holders.size === 0 && feeds.get(feed.api) === feed) feeds.delete(feed.api);
  }

  return {
    /**
     * Holds the feed of `api` until the returned function runs. `onSnapshot` runs each time the subscription (re)starts:
     * whatever changed while it was closed or reconnecting was not pushed, so the holder reads its Agent again.
     */
    acquire(api: Api, onSnapshot: () => void): () => void {
      let feed = feeds.get(api);
      if (!feed) {
        feed = { api, holders: new Set(), connection: null, token: null, retry: null, failures: 0 };
        feeds.set(api, feed);
      }
      const holder: Holder = { onSnapshot };
      feed.holders.add(holder);
      sync(feed);
      const held = feed;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.holders.delete(holder);
        sync(held);
      };
    },
    /** The app came to the front or left it (AppState). */
    setForeground(value: boolean): void {
      if (value === foreground) return;
      foreground = value;
      for (const feed of feeds.values()) sync(feed);
    },
    /** For tests. */
    debug(api: Api): { holders: number; open: boolean; retrying: boolean; failures: number } | null {
      const feed = feeds.get(api);
      return feed ? { holders: feed.holders.size, open: feed.token !== null, retrying: feed.retry !== null, failures: feed.failures } : null;
    },
    /** For tests. */
    size(): number {
      return feeds.size;
    },
  };
}

/** The one list subscription: running and starting Agents only, a one-entry snapshot (see the top of this file). */
export function agentFeedQuery(signal: AbortSignal) {
  return {
    subscribe: {},
    filter: { statuses: ["running" as const, "initializing" as const] },
    page: { limit: 1 },
    signal,
  };
}

/** The structural part of the SDK's `agents.list` the feed needs (tests pass fakes). */
export interface FeedApi {
  agents: {
    list(options: ReturnType<typeof agentFeedQuery>): Promise<{
      subscription: {
        subscribe(observer: { snapshot(snapshot: unknown): void; update(message: unknown): void; error?(error: unknown): void }): () => void;
        release(): Promise<void>;
      };
    }>;
  };
}

/**
 * Opens the subscription through the plugin's own API instance, so its agent_update messages reach the handles that
 * API made. The SDK resubscribes by itself after a reconnect and hands the observer the new snapshot; when that fails
 * it reports an error and drops the subscription, and the feed opens a new one. Closing before the answer aborts the
 * request; either way the subscription is released on the daemon.
 */
export function openAgentFeed(api: FeedApi, events: FeedEvents): FeedConnection {
  const controller = new AbortController();
  let closed = false;
  let detach: (() => void) | null = null;
  let subscription: { release(): Promise<void> } | null = null;
  const release = () => {
    if (subscription) void subscription.release().catch(() => undefined);
  };
  void Promise.resolve()
    .then(() => api.agents.list(agentFeedQuery(controller.signal)))
    .then((result) => {
      subscription = result.subscription;
      if (closed) {
        release();
        return;
      }
      detach = result.subscription.subscribe({
        snapshot: () => events.snapshot(),
        update: () => undefined,
        error: (error) => events.failed(error),
      });
    })
    .catch((error: unknown) => {
      if (!closed) events.failed(error);
    });
  return {
    close() {
      if (closed) return;
      closed = true;
      detach?.();
      controller.abort();
      release();
    },
  };
}
