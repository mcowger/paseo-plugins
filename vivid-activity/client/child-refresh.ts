import { CHILD_EVENT_READ_DELAY_MS } from "../shared/child-agent";

export interface ChildRefreshDeps {
  read(manual: boolean, statusOnly: boolean): Promise<void>;
  allowed(): boolean;
  now?(): number;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}

/** One trailing refresh per five seconds. State transitions/manual requests bypass the delay, never overlap reads. */
export function createChildRefresh(deps: ChildRefreshDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let last = -Infinity;
  let timer: unknown = null;
  let busy = false;
  let disposed = false;
  let pending: { immediate: boolean; manual: boolean; statusOnly: boolean } | null = null;
  function schedule(): void {
    if (busy || disposed || pending === null) return;
    if (timer !== null) { clearTimer(timer); timer = null; }
    const delay = pending.immediate ? 0 : Math.max(0, last + CHILD_EVENT_READ_DELAY_MS - now());
    timer = setTimer(() => {
      timer = null;
      const request = pending;
      pending = null;
      if (!request || disposed || (!request.manual && !request.statusOnly && !deps.allowed())) return;
      busy = true;
      last = now();
      void Promise.resolve().then(() => { if (!disposed) return deps.read(request.manual, request.statusOnly); }).catch(() => undefined).finally(() => {
        busy = false;
        schedule();
      });
    }, delay);
  }
  return {
    request(options: { immediate?: boolean; manual?: boolean; statusOnly?: boolean; quiet?: boolean } = {}) {
      if (disposed) return;
      // 0.6.0-local.5 (codex-vivid-merge-F1): a quiet-spell read is only a fallback: none behind a read on its way or one
      // already queued, whose answer is what the quiet spell was waiting for.
      if (options.quiet && (busy || pending !== null)) return;
      pending = {
        immediate: !!options.immediate || !!pending?.immediate,
        manual: !!options.manual || !!pending?.manual,
        statusOnly: !!options.statusOnly && (pending === null || pending.statusOnly),
      };
      schedule();
    },
    dispose() {
      disposed = true;
      pending = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
