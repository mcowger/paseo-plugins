import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { NOTIFY_PREFIX, SuperpiReplySchema, type SuperpiReply } from "../src/protocol.ts";
import { CONTEXT_POLICY_REQUEST, CONTEXT_POLICY_SNAPSHOT, type ContextPolicy } from "../src/context-policy.ts";
import { SERVICE_TIERS_REQUEST, SERVICE_TIERS_SNAPSHOT, type ServiceTierPolicy } from "../src/service-tiers.ts";

export interface FakeNotify {
  message: string;
  level?: string;
}

interface FakeCommandSeed {
  name: string;
  source?: string;
}

export interface FakePi {
  api: ExtensionAPI;
  flags: Map<string, boolean | string | undefined>;
  commands: Array<{
    name: string;
    source?: string;
    description?: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  }>;
  entries: Array<{ customType: string; data: unknown }>;
  handlers: Map<string, Array<(...args: any[]) => any>>;
  /** Live event-bus subscribers, keyed by channel. */
  eventHandlers: Map<string, Set<(data: unknown) => void>>;
  emitEvent(channel: string, data: unknown): void;
  /** Session-local model set through `pi.setModel`; the catalog is never mutated. */
  sessionModel: FakeModel | undefined;
  /** Catalog/registry entries the companion must not mutate. */
  registry: FakeModel[];
  /** Every model passed to `pi.setModel`, including refused attempts. */
  setModelCalls: FakeModel[];
  /** When true, `pi.setModel` reports missing auth and does not change the session. */
  setModelRefuses: boolean;
  /** Resolve a catalog model exactly as the Pi registry does. */
  findModel(provider: string | undefined, modelId: string): FakeModel | undefined;
}

export function createFakePi(seed: { commands?: FakeCommandSeed[]; registry?: FakeModel[]; policies?: ContextPolicy[]; noPolicyPublisher?: boolean; tierPolicies?: ServiceTierPolicy[]; noTierPublisher?: boolean } = {}): FakePi {
  const state = {
    sessionModel: undefined as FakeModel | undefined,
    registry: seed.registry ?? [],
    setModelCalls: [] as FakeModel[],
    setModelRefuses: false,
  };
  const flags = new Map<string, boolean | string | undefined>();
  const commands: FakePi["commands"] = (seed.commands ?? []).map((command) => ({
    name: command.name,
    source: command.source,
    handler: () => undefined,
  }));
  const entries: FakePi["entries"] = [];
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  if (!seed.noPolicyPublisher) eventHandlers.set(CONTEXT_POLICY_REQUEST, new Set([(data: unknown) => {
    const { requestId } = data as { requestId: string };
    for (const handler of eventHandlers.get(CONTEXT_POLICY_SNAPSHOT) ?? []) handler({ version: 1, publisherId: "00000000-0000-4000-8000-000000000001", revision: 1, requestId, status: "ready", policies: seed.policies ?? [] });
  }]));
  if (!seed.noTierPublisher) eventHandlers.set(SERVICE_TIERS_REQUEST, new Set([(data: unknown) => {
    const { requestId } = data as { requestId: string };
    const policies = seed.tierPolicies ?? (seed.registry ?? []).filter((model) => model.provider === "plexus").map((model) => ({ provider: "plexus", modelId: model.id, serviceTiers: ["auto", "standard", "flex", "priority", "ultrafast"] }));
    for (const handler of eventHandlers.get(SERVICE_TIERS_SNAPSHOT) ?? []) handler({ version: 1, publisherId: "00000000-0000-4000-8000-000000000001", revision: 1, requestId, status: "ready", policies });
  }]));

  const api = {
    registerFlag: (name: string, options: { default?: boolean | string }) => {
      flags.set(name, options.default);
    },
    getFlag: (name: string) => flags.get(name),
    getCommands: () => commands.map(({ name, source }) => ({ name, source })),
    registerCommand: (
      name: string,
      options: {
        description?: string;
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
      },
    ) => {
      commands.push({ name, source: "extension", description: options.description, handler: options.handler });
    },
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ customType, data });
    },
    setModel: async (model: FakeModel) => {
      state.setModelCalls.push(model);
      if (state.setModelRefuses) return false;
      state.sessionModel = model;
      return true;
    },
    on: (event: string, handler: (...args: any[]) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
    events: {
      emit: (channel: string, data: unknown) => {
        for (const handler of eventHandlers.get(channel) ?? []) handler(data);
      },
      on: (channel: string, handler: (data: unknown) => void) => {
        const set = eventHandlers.get(channel) ?? new Set();
        set.add(handler);
        eventHandlers.set(channel, set);
        return () => set.delete(handler);
      },
    },
  };

  return {
    api: api as unknown as ExtensionAPI,
    flags,
    commands,
    entries,
    handlers,
    eventHandlers,
    emitEvent: (channel, data) => {
      for (const handler of eventHandlers.get(channel) ?? []) handler(data);
    },
    get sessionModel() {
      return state.sessionModel;
    },
    set sessionModel(value) {
      state.sessionModel = value;
    },
    get registry() {
      return state.registry;
    },
    get setModelCalls() {
      return state.setModelCalls;
    },
    get setModelRefuses() {
      return state.setModelRefuses;
    },
    set setModelRefuses(value) {
      state.setModelRefuses = value;
    },
    findModel: (provider, modelId) =>
      state.registry.find(
        (candidate) => (candidate.provider ?? "test") === (provider ?? "test") && candidate.id === modelId,
      ),
  };
}

export interface FakeModel {
  id: string;
  api: string;
  contextWindow: number;
  provider?: string;
  name?: string;
}

export interface FakeContextSeed {
  /** When set, `ctx.model` follows `pi.setModel` and `ctx.modelRegistry` resolves the catalog. */
  pi?: FakePi;
  model?: FakeModel;
  sessionId?: string;
  branch?: Array<Record<string, unknown>>;
  idle?: boolean;
  navigateCancelled?: boolean;
  navigateThrows?: string;
  navigateLeafId?: string;
  leafId?: string;
  compactAuto?: boolean;
  compactError?: string;
}

export interface FakeContext {
  ctx: ExtensionCommandContext;
  notifies: FakeNotify[];
  navigations: Array<{ targetId: string; options?: unknown }>;
  compactions: Array<{ options?: unknown }>;
}

export function createFakeContext(seed: FakeContextSeed = {}): FakeContext {
  const notifies: FakeNotify[] = [];
  const navigations: Array<{ targetId: string; options?: unknown }> = [];
  const compactions: Array<{ options?: unknown }> = [];
  let leafId = seed.leafId ?? (seed.branch?.at(-1)?.id as string | undefined) ?? null;
  const pi = seed.pi;
  if (pi && seed.model !== undefined) pi.sessionModel = seed.model;

  const ctx = {
    ui: {
      notify: (message: string, level?: string) => {
        notifies.push({ message, level });
      },
    },
    sessionManager: {
      getSessionId: () => seed.sessionId ?? "session-test",
      getBranch: () => seed.branch ?? [],
      getLeafId: () => leafId,
    },
    isIdle: () => seed.idle ?? true,
    navigateTree: async (targetId: string, options?: unknown) => {
      navigations.push({ targetId, options });
      if (seed.navigateThrows) throw new Error(seed.navigateThrows);
      if (!seed.navigateCancelled && seed.navigateLeafId !== undefined) leafId = seed.navigateLeafId;
      return { cancelled: seed.navigateCancelled ?? false };
    },
    compact: (options?: { onComplete?: (result: unknown) => void; onError?: (error: Error) => void }) => {
      compactions.push({ options });
      if (seed.compactAuto === false) return;
      if (seed.compactError !== undefined) options?.onError?.(new Error(seed.compactError));
      else options?.onComplete?.({});
    },
    modelRegistry: {
      find: (provider: string | undefined, modelId: string) =>
        pi ? pi.findModel(provider, modelId) : undefined,
    },
  };

  // `ctx.model` follows the session-local model when a fake Pi is wired, so a
  // `pi.setModel(clone)` is visible exactly as Pi's live context reports it.
  Object.defineProperty(ctx, "model", {
    enumerable: true,
    get: () => (pi ? pi.sessionModel : seed.model),
  });

  return { ctx: ctx as unknown as ExtensionCommandContext, notifies, navigations, compactions };
}

export function readReply(notifies: FakeNotify[]): SuperpiReply {
  const last = notifies.at(-1);
  if (!last) throw new Error("no notification was emitted");
  if (!last.message.startsWith(NOTIFY_PREFIX)) throw new Error(`notification missing prefix: ${last.message}`);
  return SuperpiReplySchema.parse(JSON.parse(last.message.slice(NOTIFY_PREFIX.length)));
}
