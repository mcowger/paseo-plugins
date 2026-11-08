import { pendingCalls } from "../shared/vivid-model";
import { FOLD_TIMING } from "./fold-runtime";

/**
 * 本地补丁：哪些工具调用正在等你批准。按 Agent 共享一个订阅（Paseo 客户端已有的 agent_update 流，
 * 不额外轮询），第一行出现时建立，最后一行卸载时释放。Claude 的权限请求带 metadata.toolUseId，
 * ACP 的带 metadata.toolCallId，Codex 的带 metadata.itemId（0.6.0），都等于时间线里的 callId（shared/vivid-model.ts pendingCalls）。
 * 0.4.1：没有行再用的 Agent，过 FOLD_TIMING.forgetMs 后连同记录一起删掉，长时间来回看很多 Agent 时不再越积越多。
 * 0.5.0：agent_update 以前其实到不了这里：SDK 只在本插件自己订阅了 Agent 列表时才转发（见 agent-feed.ts），所以审批请求
 * 在对话打开之后才到时，那一行一直是蓝色「运行中」，重开对话才变琥珀。现在只有运行中的工具行才登记（只有它们会变琥珀），
 * 登记期间持有插件级的列表订阅；订阅（重新）开始和 Agent 离开运行中时，各重读一次 Agent 记录（fetch_agent 只读，
 * 不会加载 Agent）。
 */
export type Store = {
  ids: ReadonlySet<string>;
  /** 0.6.0: the ids whose request is a question (等你回答), not an approval. */
  questions: ReadonlySet<string>;
  any: boolean;
  /** Every pending request is a question (for a row without an id). */
  onlyQuestions: boolean;
  listeners: Set<() => void>;
  refs: number;
  release: (() => void) | null;
  drop: unknown;
};
export type Pending = Parameters<typeof pendingCalls>[0];
export const EMPTY: ReadonlySet<string> = new Set();

const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) => left.size === right.size && [...left].every((id) => right.has(id));

export interface AttentionTimers {
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const REAL_TIMERS: AttentionTimers = {
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The per-Agent stores (one per plugin evaluation); exported for tests. */
export function createAttentionStores(timers: AttentionTimers = REAL_TIMERS, forgetMs: number = FOLD_TIMING.forgetMs) {
  const stores = new Map<string, Store>();
  function storeFor(agentId: string): Store {
    let store = stores.get(agentId);
    if (!store) {
      store = { ids: EMPTY, questions: EMPTY, any: false, onlyQuestions: false, listeners: new Set(), refs: 0, release: null, drop: null };
      stores.set(agentId, store);
    }
    if (store.drop !== null) {
      timers.clearTimer(store.drop);
      store.drop = null;
    }
    return store;
  }
  function dropLater(agentId: string, store: Store): void {
    if (store.refs > 0 || store.listeners.size > 0 || store.drop !== null) return;
    store.drop = timers.setTimer(() => {
      store.drop = null;
      if (store.refs === 0 && store.listeners.size === 0 && stores.get(agentId) === store) stores.delete(agentId);
    }, forgetMs);
  }
  return {
    /** A row of the Agent mounted; the first one subscribes (`subscribe` returns how to unsubscribe). */
    acquire(agentId: string, subscribe: (store: Store) => () => void): Store {
      const store = storeFor(agentId);
      store.refs += 1;
      if (store.refs === 1) store.release = subscribe(store);
      return store;
    },
    /** The row unmounted; the last one unsubscribes. */
    release(agentId: string, store: Store): void {
      if (store.refs === 0) return;
      store.refs -= 1;
      if (store.refs > 0) return;
      store.release?.();
      store.release = null;
      dropLater(agentId, store);
    },
    listen(agentId: string, listener: () => void): () => void {
      const store = storeFor(agentId);
      store.listeners.add(listener);
      return () => {
        store.listeners.delete(listener);
        dropLater(agentId, store);
      };
    },
    snapshot(agentId: string): Store | undefined {
      return stores.get(agentId);
    },
    publish(store: Store, pending: Pending): void {
      const { ids, questions, onlyQuestions } = pendingCalls(pending);
      const any = (pending?.length ?? 0) > 0;
      if (any === store.any && onlyQuestions === store.onlyQuestions && sameSet(ids, store.ids) && sameSet(questions, store.questions)) return;
      store.ids = ids.size > 0 ? ids : EMPTY;
      store.questions = questions.size > 0 ? questions : EMPTY;
      store.any = any;
      store.onlyQuestions = onlyQuestions;
      for (const listener of store.listeners) listener();
    },
    size(): number {
      return stores.size;
    },
  };
}

/** What the watcher uses of an Agent handle (tests pass fakes). */
export interface WatchedAgent {
  readonly pendingPermissions: Pending;
  refresh(): Promise<unknown>;
  subscribe(handler: (update: { kind: "upsert"; agent: { id: string; pendingPermissions?: Pending } } | { kind: "remove"; agentId: string }) => void): () => void;
}

/**
 * 0.5.0: one Agent's pending permissions while a running row of it is mounted. Pushed upserts carry them. A read of the
 * Agent's record (`refresh`, fetch_agent) fills the gaps: at the start, whenever the feed (re)starts (`holdFeed` calls
 * back on each snapshot) and when the Agent leaves the running Agents (a `remove`: its turn ended, or it cannot be
 * placed). Reads never overlap, and one that a push overtook is dropped: the push is at least as new.
 */
export function watchPendingPermissions(
  agent: WatchedAgent,
  agentId: string,
  publish: (pending: Pending) => void,
  holdFeed: (onSnapshot: () => void) => () => void,
): () => void {
  if (agentId.startsWith("provider:")) {
    publish([]);
    return () => undefined;
  }
  let stopped = false;
  let reading = false;
  let again = false;
  let pushes = 0;
  const read = (): void => {
    if (stopped) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    const seen = pushes;
    void agent
      .refresh()
      .then(() => {
        if (!stopped && pushes === seen) publish(agent.pendingPermissions);
      }, () => undefined)
      .finally(() => {
        reading = false;
        if (again && !stopped) {
          again = false;
          read();
        }
      });
  };
  const unsubscribe = agent.subscribe((update) => {
    if (stopped) return;
    if (update.kind === "upsert") {
      if (update.agent.id !== agentId) return;
      pushes += 1;
      publish(update.agent.pendingPermissions);
    } else if (update.agentId === agentId) {
      pushes += 1;
      read();
    }
  });
  const release = holdFeed(read);
  read();
  return () => {
    stopped = true;
    unsubscribe();
    release();
  };
}
