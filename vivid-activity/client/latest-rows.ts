import { FOLD_MEMORY, trimOldest } from "./fold-runtime";

/**
 * 0.5.0：每个 Agent 最新一条思考行、工具行、任务更新的时间（「只展开最新」和原生端行距用），每个 Agent 记一个数字。
 * 以前只增不减；现在和其他按 Agent 的记忆一样：折叠运行时忘掉一个 Agent（它的行离开屏幕 10 分钟）时一起丢掉，
 * 总数超过 FOLD_MEMORY.latestAgents 时丢掉较旧的一半。
 */
export interface LatestRows {
  /** The newest time noted for the Agent; 0 when none. */
  get(agentId: string): number;
  /** Notes a row's time; listeners hear about a newer one. */
  note(agentId: string, time: number): void;
  subscribe(listener: () => void): () => void;
  forget(agentId: string): void;
  size(): number;
}

export function createLatestRows(limit: number = FOLD_MEMORY.latestAgents): LatestRows {
  const times = new Map<string, number>();
  const listeners = new Set<() => void>();
  return {
    get: (agentId) => times.get(agentId) ?? 0,
    note(agentId, time) {
      if (time <= (times.get(agentId) ?? 0)) return;
      times.set(agentId, time);
      trimOldest(times, limit);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    forget(agentId) {
      times.delete(agentId);
    },
    size: () => times.size,
  };
}

/** Drops the Agent from each store when the fold runtime forgets it; returns how to stop. */
export function forgetWith(runtime: { onForget(listener: (agentId: string) => void): () => void }, stores: readonly LatestRows[]): () => void {
  return runtime.onForget((agentId) => {
    for (const store of stores) store.forget(agentId);
  });
}
