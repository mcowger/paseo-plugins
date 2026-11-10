import { useSyncExternalStore } from "react";

type ProviderSubagent = {
  id: string;
  parentAgentId: string;
  toolCallId: string;
  title: string;
  status: string;
  activity: readonly ProviderSubagentActivity[];
};
export type ProviderSubagentActivity = {
  id: string;
  title: string;
  summary?: string | null;
  meta?: string | null;
  icon?: string | null;
};
export type ProviderSubagentsSnapshot = readonly ProviderSubagent[];

type Observer = (events: string[], options: { signal: AbortSignal }) => {
  subscribe(observer: { snapshot(): void; update(message: unknown): void; error?(error: unknown): void }): () => void;
  release(): Promise<void>;
};
type PaseoObserverHost = { observeEvents?: unknown };
const EMPTY: ProviderSubagentsSnapshot = Object.freeze([]);
const MAX_PARENTS = 128;
const MAX_CHILDREN = 32;
const MAX_ACTIVITY = 150;
const MAX_TEXT = 2_000;
const EVENT = "agent.provider_subagents.update";
const stores = new Map<string, ProviderSubagentsSnapshot>();
const filteredStores = new WeakMap<ProviderSubagentsSnapshot, Map<string, ProviderSubagentsSnapshot>>();
const listeners = new Map<string, Set<() => void>>();
let stopCurrent: (() => void) | undefined;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_TEXT) : undefined;
}
function notify(parentAgentId: string): void {
  for (const listener of listeners.get(parentAgentId) ?? []) listener();
}
function consume(message: unknown): void {
  const outer = record(message);
  if (!outer) return;
  const inner = record(outer.message);
  if ((inner?.type ?? outer.type) !== EVENT) return;
  const payload = record(inner?.payload ?? outer.payload);
  if (!payload) return;
  const kind = payload.kind;
  const subagent = record(payload.subagent);
  const parentAgentId = string(kind === "upsert" ? subagent?.parentAgentId : payload.parentAgentId);
  const childId = string(kind === "upsert" ? subagent?.id : payload.subagentId);
  if (!parentAgentId || !childId) return;
  const prior = stores.get(parentAgentId) ?? EMPTY;
  const priorChild = prior.find((child) => child.id === childId);
  if (kind === "remove") {
    if (!priorChild) return;
    const next = Object.freeze(prior.filter((child) => child.id !== childId));
    stores.set(parentAgentId, next);
    notify(parentAgentId);
    return;
  }
  if (kind === "upsert") {
    if (!subagent) return;
    const toolCallId = string(subagent.toolCallId) ?? priorChild?.toolCallId;
    if (!toolCallId) return;
    const child: ProviderSubagent = Object.freeze({
      id: childId,
      parentAgentId,
      toolCallId,
      title: string(subagent.title) ?? "Subagent",
      status: string(subagent.status) ?? "running",
      activity: priorChild?.activity ?? Object.freeze([]),
    });
    const next = Object.freeze([...prior.filter((entry) => entry.id !== childId), child].slice(-MAX_CHILDREN));
    stores.delete(parentAgentId);
    stores.set(parentAgentId, next);
    while (stores.size > MAX_PARENTS) {
      const oldest = stores.keys().next().value;
      if (!oldest) break;
      stores.delete(oldest);
      notify(oldest);
    }
    notify(parentAgentId);
    return;
  }
  if (kind !== "timeline" || !priorChild) return;
  const item = record(payload.item);
  const seq = typeof payload.seq === "number" && Number.isFinite(payload.seq) ? payload.seq : undefined;
  if (!item || seq === undefined) return;
  const type = string(item.type) ?? "Activity";
  let title = type;
  let summary: string | undefined;
  if (type === "reasoning") { title = "Thinking"; summary = string(item.text); }
  else if (type === "assistant_message") { title = "Agent"; summary = string(item.text); }
  else if (type === "user_message") { title = "Prompt"; summary = string(item.text); }
  else if (type === "error") { title = "Error"; summary = string(item.message); }
  else if (type === "notification") { title = string(item.level) ?? "Notification"; summary = string(item.message); }
  else if (type === "tool_call") {
    title = string(item.name) ?? "Tool";
    const detail = record(item.detail);
    summary = string(detail?.summary ?? detail?.command ?? detail?.query);
  } else if (type === "todo") title = "Tasks";
  else if (type === "plugin") title = string(item.kind) ?? "Plugin";
  const activityId = `${childId}:${seq}`;
  if (priorChild.activity.some((activity) => activity.id === activityId)) return;
  const entry: ProviderSubagentActivity = Object.freeze({ id: activityId, title, ...(summary ? { summary } : {}) });
  const child: ProviderSubagent = Object.freeze({ ...priorChild, activity: Object.freeze([entry, ...priorChild.activity].slice(0, MAX_ACTIVITY)) });
  stores.set(parentAgentId, Object.freeze([...prior.filter((entry) => entry.id !== childId), child]));
  notify(parentAgentId);
}

/** Install at plugin contribution time, never per timeline row, to retain early child events. */
export function startProviderSubagents(paseo: PaseoObserverHost): () => void {
  stopCurrent?.();
  if (typeof paseo.observeEvents !== "function") return () => undefined;
  const lifetime = new AbortController();
  let unsubscribe: (() => void) | undefined;
  let observation: ReturnType<Observer> | undefined;
  try {
    observation = (paseo.observeEvents as Observer).call(paseo, [EVENT], { signal: lifetime.signal });
    unsubscribe = observation.subscribe({ snapshot() {}, update: consume, error() {} });
  } catch {
    lifetime.abort();
    if (observation) void observation.release().catch(() => undefined);
    return () => undefined;
  }
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
    lifetime.abort();
    for (const parent of stores.keys()) {
      stores.delete(parent);
      notify(parent);
    }
    void observation?.release().catch(() => undefined);
    if (stopCurrent === stop) stopCurrent = undefined;
  };
  stopCurrent = stop;
  return stop;
}

/** Read child descriptors and newest-first event activity for one parent and tool call. */
export function useProviderSubagents(parentAgentId: string, toolCallId: string, enabled = true): ProviderSubagentsSnapshot {
  const key = enabled && parentAgentId && toolCallId ? parentAgentId : "";
  const subscribe = (listener: () => void) => {
    if (!key) return () => undefined;
    let set = listeners.get(key);
    if (!set) listeners.set(key, set = new Set());
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) listeners.delete(key);
    };
  };
  const getSnapshot = () => {
    if (!key) return EMPTY;
    const stored = stores.get(key) ?? EMPTY;
    let byCall = filteredStores.get(stored);
    if (!byCall) filteredStores.set(stored, byCall = new Map());
    let filtered = byCall.get(toolCallId);
    if (!filtered) {
      const children = stored.filter((child) => child.toolCallId === toolCallId);
      filtered = children.length === stored.length ? stored : Object.freeze(children);
      byCall.set(toolCallId, filtered);
    }
    return filtered;
  };
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}
