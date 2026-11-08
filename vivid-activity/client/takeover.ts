import { DEFAULT_TAKEOVER, type TakeoverScope } from "../shared/settings";

/**
 * 本地补丁：「接管范围」开关。
 *
 * Paseo 只在插件的时间线转换器增减时重新投影整条时间线（每次增减都会换一个新的组合转换函数，
 * 投影缓存随之失效）。所以范围不是在转换函数里判断，而是按范围注册/注销转换器：
 * 切换后已显示的行立即重绘，不必重载插件或刷新页面。
 */
export type TakeoverPart = "reasoning" | "tool-calls";

export function takeoverParts(scope: TakeoverScope): readonly TakeoverPart[] {
  switch (scope) {
    case "all":
      return ["reasoning", "tool-calls"];
    case "reasoning":
      return ["reasoning"];
    case "off":
      return [];
  }
}

export interface TakeoverHost {
  /** Registers one transformer group and returns its removal. */
  register(part: TakeoverPart): () => void;
  /** Reads the stored scope; null keeps the current one (unreadable or invalid settings). */
  read(): Promise<TakeoverScope | null>;
  /** Calls `changed` whenever the stored settings may have changed, including after a reconnect. */
  watch(changed: () => void): () => void;
}

export interface TakeoverController {
  scope(): TakeoverScope;
  /** Applies a scope the caller already knows (e.g. just saved); outdated reads in flight are dropped. */
  apply(scope: TakeoverScope): void;
  refresh(): Promise<void>;
  stop(): void;
}

/**
 * Registers the parts for `initial` right away (no startup flash for the default), then follows the
 * stored setting. Removals stay with the host on stop: it releases every registration of a stopped plugin.
 */
export function startTakeover(host: TakeoverHost, initial: TakeoverScope = DEFAULT_TAKEOVER): TakeoverController {
  const active = new Map<TakeoverPart, () => void>();
  let current = initial;
  let stopped = false;
  let generation = 0;

  const sync = (scope: TakeoverScope) => {
    const wanted = takeoverParts(scope);
    for (const [part, remove] of active) {
      if (wanted.includes(part)) continue;
      active.delete(part);
      remove();
    }
    for (const part of wanted) if (!active.has(part)) active.set(part, host.register(part));
  };
  const apply = (scope: TakeoverScope) => {
    if (stopped || scope === current) return;
    current = scope;
    sync(scope);
  };
  const refresh = async () => {
    const ticket = ++generation;
    let scope: TakeoverScope | null;
    try {
      scope = await host.read();
    } catch {
      scope = null;
    }
    if (ticket !== generation || scope === null) return;
    apply(scope);
  };

  sync(initial);
  const unwatch = host.watch(() => void refresh());
  void refresh();
  return {
    scope: () => current,
    apply(scope) {
      generation++;
      apply(scope);
    },
    refresh,
    stop() {
      if (stopped) return;
      stopped = true;
      generation++;
      unwatch();
    },
  };
}

// One plugin evaluation per host: the settings screen of this evaluation applies a saved scope at once
// instead of waiting for the settings-changed event to come back.
let live: TakeoverController | null = null;
export function setLiveTakeover(controller: TakeoverController | null): void {
  live = controller;
}
export function applyTakeover(scope: TakeoverScope): void {
  live?.apply(scope);
}

/** A `status.plugin_settings_changed` update for a settings definition with this id (any plugin; re-reading is cheap). */
export function isSettingsChange(message: unknown, settingsId: string): boolean {
  if (typeof message !== "object" || message === null) return false;
  const { type, payload } = message as { type?: unknown; payload?: unknown };
  if (type !== "status" || typeof payload !== "object" || payload === null) return false;
  const status = payload as { status?: unknown; settingsId?: unknown };
  return status.status === "plugin_settings_changed" && status.settingsId === settingsId;
}
