import type { UsageFeed } from "./turn-usage";

/**
 * 0.8.0：给「按请求」计 Token 的 Agent（Codex 系）开的 Agent 列表订阅，在 daemon 里，不经 relay、不到手机。
 * Paseo 只在插件自己的 API 实例订阅过 Agent 列表时才把 agent_update 推给它（client/agent-feed.ts 有同样的说明）；
 * 每次用量变化（Codex 每次请求结束）都推一次完整记录，server/turn-usage.ts 逐次累加。
 *
 * - 只在有「按请求」的轮次在跑时打开（引用计数），最后一个结束 30 秒后关掉；只订运行中、启动中的 Agent，快照只要 1 条。
 * - 第一次快照之后再来的快照（断线重连）、订阅失败，都说明中间可能漏了更新：通知 `onGap`，正在算的轮次不再显示；
 *   失败后还有人要就 5 秒后重开。
 */
export interface FeedEvents {
  snapshot(): void;
  update(payload: unknown): void;
  failed(error: unknown): void;
}
export type OpenFeed = (events: FeedEvents) => { close(): void } | null;

export const USAGE_FEED_CLOSE_MS = 30_000;
export const USAGE_FEED_RETRY_MS = 5_000;

export function createUsageFeed(options: {
  open: OpenFeed;
  onUpdate(payload: unknown): void;
  onGap(): void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  closeAfterMs?: number;
  retryMs?: number;
}): UsageFeed & { dispose(): void; debug(): { holds: number; open: boolean; steady: boolean; retrying: boolean } } {
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const closeAfter = options.closeAfterMs ?? USAGE_FEED_CLOSE_MS;
  const retryAfter = options.retryMs ?? USAGE_FEED_RETRY_MS;
  let holds = 0;
  let connection: { close(): void } | null = null;
  let token: object | null = null;
  let steady = false;
  let closeTimer: unknown = null;
  let retryTimer: unknown = null;

  function stop(): void {
    const open = connection;
    connection = null;
    token = null;
    steady = false;
    open?.close();
  }

  function retry(): void {
    if (holds === 0 || retryTimer !== null) return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (holds > 0 && token === null) start();
    }, retryAfter);
  }

  function start(): void {
    const mine = {};
    token = mine;
    steady = false;
    let opened: { close(): void } | null = null;
    try {
      opened = options.open({
        snapshot() {
          if (token !== mine) return;
          // A later snapshot is a resubscription: whatever changed in between was not pushed.
          if (steady) options.onGap();
          steady = true;
        },
        update(payload) {
          if (token === mine) options.onUpdate(payload);
        },
        failed() {
          if (token !== mine) return;
          options.onGap();
          stop();
          retry();
        },
      });
    } catch {
      opened = null;
    }
    if (token !== mine) {
      opened?.close();
      return;
    }
    if (!opened) {
      token = null;
      options.onGap();
      retry();
      return;
    }
    connection = opened;
  }

  return {
    hold() {
      holds += 1;
      if (closeTimer !== null) {
        clearTimer(closeTimer);
        closeTimer = null;
      }
      if (token === null && retryTimer === null) start();
    },
    release() {
      holds = Math.max(0, holds - 1);
      if (holds > 0 || closeTimer !== null) return;
      closeTimer = setTimer(() => {
        closeTimer = null;
        if (holds === 0) stop();
      }, closeAfter);
    },
    dispose() {
      holds = 0;
      if (closeTimer !== null) clearTimer(closeTimer);
      if (retryTimer !== null) clearTimer(retryTimer);
      closeTimer = null;
      retryTimer = null;
      stop();
    },
    debug() {
      return { holds, open: connection !== null, steady, retrying: retryTimer !== null };
    },
  };
}

/** The structural part of the server SDK's `agents.list` the feed needs (tests pass fakes). */
export interface FeedApi {
  agents: {
    list(options: {
      subscribe: Record<string, never>;
      filter: { statuses: Array<"running" | "initializing"> };
      page: { limit: number };
      signal: AbortSignal;
    }): Promise<{
      subscription: {
        subscribe(observer: { snapshot(snapshot: unknown): void; update(message: unknown): void; error?(error: unknown): void }): () => void;
        release(): Promise<void>;
      };
    }>;
  };
}

/** Opens the subscription through the plugin server's API; closing before the answer aborts it, and it is always released. */
export function openUsageFeed(api: FeedApi, events: FeedEvents): { close(): void } {
  const controller = new AbortController();
  let closed = false;
  let detach: (() => void) | null = null;
  let subscription: { release(): Promise<void> } | null = null;
  const release = () => {
    if (subscription) void subscription.release().catch(() => undefined);
  };
  void Promise.resolve()
    .then(() => api.agents.list({ subscribe: {}, filter: { statuses: ["running", "initializing"] }, page: { limit: 1 }, signal: controller.signal }))
    .then((result) => {
      subscription = result.subscription;
      if (closed) {
        release();
        return;
      }
      detach = result.subscription.subscribe({
        snapshot: () => events.snapshot(),
        update: (message) => {
          const update = message as { type?: unknown; payload?: unknown } | null;
          if (update?.type === "agent_update") events.update(update.payload);
        },
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
