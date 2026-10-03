import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSubagentBridgeTracker, formatChildForward } from "./bridge.ts";
import { detectControlConflicts } from "./conflicts.ts";
import {
  clearExpandedContext,
  EXPANDED_CONTEXT_WINDOW,
  planExpandedContext,
  planRestoredContext,
  trackExpandedContext,
  type ContextWindowModel,
  type ExpandedContextTracking,
} from "./context.ts";
import { buildRewindEntry, findActiveBranchUserEntry, navigationCancelled } from "./rewind.ts";
import { applyTierToPayload, isTierApplicable } from "./tier.ts";
import {
  COMMAND_NAME,
  CompactDataSchema,
  ConfigureDataSchema,
  ControlEntrySchema,
  CUSTOM_ENTRY_TYPE,
  formatIssues,
  NOTIFY_PREFIX,
  parseRequestArg,
  PROTOCOL_VERSION,
  REWIND_ENTRY_TYPE,
  RewindDataSchema,
  ROLE_ENV,
  ROOT_FLAG,
  SESSION_KEY_ENV,
  SUBAGENT_BRIDGE_CHANNEL,
  SubagentBridgeRecordSchema,
  SuperpiReplySchema,
  SuperpiStateSchema,
  TIERS,
  type Conflict,
  type ControlEntry,
  type Origin,
  type RewindResult,
  type SuperpiRequest,
  type SuperpiReply,
  type SuperpiState,
  type Tier,
} from "./protocol.ts";

export interface CompanionOptions {
  /** Expected integration session key. Defaults to `SUPERPI_SESSION_KEY`. */
  sessionKey?: string;
  /** Force root/child role. Defaults to flag/env detection. */
  origin?: Origin;
  /** Clock for persisted entry timestamps. */
  now?: () => number;
  /** Override the expanded context budget. */
  expandedContextWindow?: number;
}

export interface CompanionHandle {
  readonly origin: Origin;
  readonly expectedSessionKey: string | undefined;
  handleArgs(args: string, ctx: ExtensionCommandContext): Promise<void>;
  buildState(ctx: ExtensionContext): SuperpiState;
  restore(ctx: ExtensionContext): Promise<void>;
  /** Owned runs that have not reached a terminal bridge record. */
  activeChildren(): number;
}

/** Operations implemented by the companion. */
export const COMPANION_CAPABILITIES: readonly string[] = [
  "hello",
  "get-state",
  "configure",
  "rewind",
  "compact",
];

const COMPANION_LIMITATIONS: readonly string[] = [
  "rewind restores Pi's active branch and appends a branch pin; it never writes files and never summarizes the abandoned future",
  "rewind is rejected while the root agent is busy, while a compaction is in progress, or while owned children are active",
  "the provider must clear its own queued input before asking the companion to navigate",
  "compact completion is awaited via Pi's documented callbacks/events; the companion never reports completion early",
  "host history replacement after rewind is the provider's supported-adapter concern, not a companion-invented reset event",
  "active owned children are counted from the pi-subagents bridge; children not bridged are not visible",
  "tier values are injected only for known provider dialects; backend acceptance is not verified",
  "long-context target is an integration budgeting limit, not confirmed backend capacity",
];

/**
 * Public Pi event-bus channel that announces the Superpi root session. The
 * companion emits it after a root session starts so other extensions can learn
 * root identity without registering the launch flag themselves.
 */
export const ROOT_SIGNAL_CHANNEL = "superpi:root:v1";

/** Schema version carried by the root signal payload. */
export const ROOT_SIGNAL_VERSION = 1;

function normalizeKey(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveOrigin(pi: ExtensionAPI, options: CompanionOptions): Origin {
  if (options.origin) return options.origin;
  if (pi.getFlag(ROOT_FLAG) === true) return "root";
  if (process.env[ROLE_ENV] === "root") return "root";
  return "child";
}

function readSessionId(ctx: ExtensionContext): string | undefined {
  try {
    const id = ctx.sessionManager.getSessionId();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function readLeafId(ctx: ExtensionContext): string | undefined {
  try {
    const id = ctx.sessionManager.getLeafId();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function readBranch(ctx: ExtensionContext): ReturnType<ExtensionContext["sessionManager"]["getBranch"]> {
  try {
    return ctx.sessionManager.getBranch();
  } catch {
    return [];
  }
}

type CompactOutcome = { ok: true } | { ok: false; error: string };

export function createCompanion(pi: ExtensionAPI, options: CompanionOptions = {}): CompanionHandle {
  const now = options.now ?? (() => Date.now());
  const expandedTarget = options.expandedContextWindow ?? EXPANDED_CONTEXT_WINDOW;
  const expectedSessionKey = normalizeKey(options.sessionKey ?? process.env[SESSION_KEY_ENV]);

  pi.registerFlag(ROOT_FLAG, {
    description: "Marks this Pi session as the Superpi root companion owner.",
    type: "boolean",
    default: false,
  });

  const origin = () => resolveOrigin(pi, options);
  /**
   * Root ownership for bridge forwarding is decided only by the dynamic launch
   * flag (or an explicit option). The role environment variable is inherited by
   * SDK child sessions, so it cannot distinguish the real root owner.
   */
  const rootFlagged = () => (options.origin ? options.origin === "root" : pi.getFlag(ROOT_FLAG) === true);

  const settings: { tier: Tier; longContext: boolean } = { tier: "default", longContext: false };
  const tracking: ExpandedContextTracking = { model: undefined, baseline: undefined };
  const bridgeTracker = createSubagentBridgeTracker(expectedSessionKey ?? "");
  let applyingModel = false;

  let compactionActive = false;
  let pendingCompact: { settle: (outcome: CompactOutcome) => void } | undefined;
  let bridgeUnsubscribe: (() => void) | undefined;
  let bridgeContext: ExtensionContext | undefined;

  function conflicts(): Conflict[] {
    try {
      return detectControlConflicts(pi.getCommands());
    } catch {
      return [];
    }
  }

  /**
   * Apply a session-local model through Pi's public, session-only `setModel`.
   * The catalog object is never mutated, so any other consumer of the model
   * registry (including owned pi-subagents children) keeps the baseline window.
   */
  async function applySessionModel(model: ContextWindowModel | undefined): Promise<boolean> {
    if (!model) return false;
    applyingModel = true;
    try {
      return await pi.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]);
    } catch {
      return false;
    } finally {
      applyingModel = false;
    }
  }

  function buildState(ctx: ExtensionContext): SuperpiState {
    const root = origin() === "root";
    const model = ctx.model;
    const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
    const sessionId = readSessionId(ctx);
    const state: SuperpiState = {
      capabilities: root ? [...COMPANION_CAPABILITIES] : [],
      settings: { tier: settings.tier, longContext: settings.longContext },
      origin: origin(),
      tiers: [...TIERS],
      longContextTarget: expandedTarget,
      tierApplicable: isTierApplicable(model, settings.tier),
      conflicts: conflicts(),
      limitations: [...COMPANION_LIMITATIONS],
    };
    if (root) state.activeChildren = bridgeTracker.activeChildren();
    if (contextWindow !== undefined) state.contextWindow = contextWindow;
    if (sessionId !== undefined) state.sessionId = sessionId;
    if (tracking.baseline !== undefined) state.modelBaselineContextWindow = tracking.baseline;
    return SuperpiStateSchema.parse(state);
  }

  function emit(ctx: ExtensionContext, reply: SuperpiReply): void {
    const validated = SuperpiReplySchema.parse(reply);
    ctx.ui.notify(`${NOTIFY_PREFIX}${JSON.stringify(validated)}`, validated.ok ? "info" : "warning");
  }

  function base(request: SuperpiRequest) {
    return {
      version: PROTOCOL_VERSION,
      sessionKey: request.sessionKey,
      requestId: request.requestId,
      operation: request.operation,
    } as const;
  }

  function persist(): void {
    pi.appendEntry(CUSTOM_ENTRY_TYPE, {
      version: PROTOCOL_VERSION,
      tier: settings.tier,
      longContext: settings.longContext,
      ...(tracking.baseline !== undefined ? { contextWindow: tracking.baseline } : {}),
      timestamp: now(),
    });
  }

  function latestControlEntry(ctx: ExtensionContext): ControlEntry | undefined {
    let latest: ControlEntry | undefined;
    for (const entry of readBranch(ctx)) {
      if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) continue;
      const parsed = ControlEntrySchema.safeParse(entry.data);
      if (parsed.success) latest = parsed.data;
    }
    return latest;
  }

  async function restoreBaseline(ctx: ExtensionContext): Promise<boolean> {
    const restored = planRestoredContext(tracking, ctx.model);
    if (!restored) return true;
    if (!(await applySessionModel(restored))) return false;
    clearExpandedContext(tracking);
    return true;
  }

  async function restore(ctx: ExtensionContext): Promise<void> {
    if (origin() !== "root") return;
    // Re-derive the baseline clone before reading persisted controls, so a
    // tracked expansion is never planned against its own expanded window. If
    // the baseline cannot be restored, leave the session as it is.
    if (!(await restoreBaseline(ctx))) return;
    const entry = latestControlEntry(ctx);
    if (!entry) {
      settings.tier = "default";
      settings.longContext = false;
      return;
    }
    settings.tier = entry.tier;
    settings.longContext = entry.longContext;
    if (entry.longContext) {
      // Failure here (no current model) leaves the selection set; model_select re-applies.
      const plan = planExpandedContext(tracking, ctx.model, expandedTarget);
      if (plan.ok && (await applySessionModel(plan.model))) {
        trackExpandedContext(tracking, plan.source, plan.baseline);
      }
    }
  }

  function settleCompact(outcome: CompactOutcome): void {
    compactionActive = false;
    const pending = pendingCompact;
    pendingCompact = undefined;
    if (pending) pending.settle(outcome);
  }

  function forwardBridgeRecord(data: unknown): void {
    if (origin() !== "root") return;
    const parsed = SubagentBridgeRecordSchema.safeParse(data);
    if (!parsed.success) return;
    const forward = bridgeTracker.accept(parsed.data);
    if (!forward) return;
    const ctx = bridgeContext;
    if (!ctx) return;
    // Native message/tool activity comes from the bridge record; the companion
    // never reads the child transcript path.
    ctx.ui.notify(formatChildForward(forward), "info");
  }

  function disposeBridge(): void {
    if (bridgeUnsubscribe) {
      bridgeUnsubscribe();
      bridgeUnsubscribe = undefined;
    }
    bridgeContext = undefined;
  }

  function subscribeBridge(ctx: ExtensionContext): void {
    if (!rootFlagged() || !expectedSessionKey) return;
    bridgeContext = ctx;
    if (bridgeUnsubscribe) return;
    const events = pi.events;
    if (!events || typeof events.on !== "function") return;
    bridgeUnsubscribe = events.on(SUBAGENT_BRIDGE_CHANNEL, forwardBridgeRecord);
  }

  /**
   * Announce the root session on the public event bus. Only the flag (or an
   * explicit option) marks root ownership; the role environment variable is
   * inherited by SDK children and is never sufficient to signal.
   */
  function emitRootSignal(ctx: ExtensionContext): void {
    const events = pi.events;
    if (!events || typeof events.emit !== "function") return;
    const sessionId = readSessionId(ctx);
    if (sessionId === undefined) return;
    events.emit(ROOT_SIGNAL_CHANNEL, {
      version: ROOT_SIGNAL_VERSION,
      sessionId,
    });
  }

  function rewindResult(cancelled: boolean, targetEntryId: string, ctx: ExtensionContext): RewindResult {
    const leafId = readLeafId(ctx);
    return {
      cancelled,
      targetEntryId,
      ...(leafId !== undefined ? { leafId } : {}),
      settings: { tier: settings.tier, longContext: settings.longContext },
      activeChildren: bridgeTracker.activeChildren(),
    };
  }

  function handleHello(request: SuperpiRequest, ctx: ExtensionCommandContext): void {
    const data = buildState(ctx);
    if (data.conflicts.length > 0) {
      const detail = data.conflicts.map((conflict) => `${conflict.owner} owns ${conflict.command}`).join("; ");
      const resolutions = data.conflicts.map((conflict) => conflict.resolution).join(" ");
      emit(ctx, {
        ...base(request),
        ok: false,
        data,
        error: `known control owner conflict: ${detail}. ${resolutions}`,
      });
      return;
    }
    emit(ctx, { ...base(request), ok: true, data });
  }

  async function handleConfigure(request: SuperpiRequest, ctx: ExtensionCommandContext): Promise<void> {
    const parsed = ConfigureDataSchema.safeParse(request.data ?? {});
    if (!parsed.success) {
      emit(ctx, { ...base(request), ok: false, error: `invalid configure data: ${formatIssues(parsed.error)}` });
      return;
    }

    const before = { tier: settings.tier, longContext: settings.longContext };
    const nextTier = parsed.data.tier ?? settings.tier;
    const nextLongContext = parsed.data.longContext ?? settings.longContext;

    // Plan every model change before mutating any selection, so a model that
    // cannot be expanded leaves the previous tier and toggle untouched and
    // nothing is persisted for a configuration that never applied.
    const expandPlan =
      nextLongContext && !settings.longContext
        ? planExpandedContext(tracking, ctx.model, expandedTarget)
        : undefined;
    if (expandPlan && !expandPlan.ok) {
      emit(ctx, { ...base(request), ok: false, data: buildState(ctx), error: expandPlan.error });
      return;
    }

    if (expandPlan?.ok) {
      if (!(await applySessionModel(expandPlan.model))) {
        emit(ctx, {
          ...base(request),
          ok: false,
          data: buildState(ctx),
          error: "could not move the session to the expanded model",
        });
        return;
      }
      trackExpandedContext(tracking, expandPlan.source, expandPlan.baseline);
    } else if (!nextLongContext && settings.longContext) {
      const restored = planRestoredContext(tracking, ctx.model);
      if (restored && !(await applySessionModel(restored))) {
        emit(ctx, {
          ...base(request),
          ok: false,
          data: buildState(ctx),
          error: "could not restore the session model baseline",
        });
        return;
      }
      clearExpandedContext(tracking);
    }

    settings.tier = nextTier;
    settings.longContext = nextLongContext;
    if (before.tier !== settings.tier || before.longContext !== settings.longContext) persist();

    emit(ctx, { ...base(request), ok: true, data: buildState(ctx) });
  }

  async function handleRewind(request: SuperpiRequest, ctx: ExtensionCommandContext): Promise<void> {
    const parsed = RewindDataSchema.safeParse(request.data ?? {});
    if (!parsed.success) {
      emit(ctx, { ...base(request), ok: false, error: `invalid rewind data: ${formatIssues(parsed.error)}` });
      return;
    }
    const { targetEntryId } = parsed.data;

    if (!ctx.isIdle()) {
      emit(ctx, { ...base(request), ok: false, data: buildState(ctx), error: "rewind requires an idle agent" });
      return;
    }
    if (compactionActive) {
      emit(ctx, {
        ...base(request),
        ok: false,
        data: buildState(ctx),
        error: "rewind is unavailable while a compaction is in progress",
      });
      return;
    }
    const activeChildren = bridgeTracker.activeChildren();
    if (activeChildren > 0) {
      emit(ctx, {
        ...base(request),
        ok: false,
        data: buildState(ctx),
        error: `rewind is unavailable while ${activeChildren} owned child session(s) are active`,
      });
      return;
    }

    const target = findActiveBranchUserEntry(readBranch(ctx), targetEntryId);
    if (!target.ok) {
      emit(ctx, { ...base(request), ok: false, data: buildState(ctx), error: `invalid rewind target: ${target.error}` });
      return;
    }

    let result: unknown;
    try {
      result = await ctx.navigateTree(targetEntryId, { summarize: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(ctx, {
        ...base(request),
        ok: false,
        data: buildState(ctx),
        error: `rewind navigation failed: ${message}`,
      });
      return;
    }

    if (navigationCancelled(result)) {
      emit(ctx, {
        ...base(request),
        ok: false,
        data: rewindResult(true, targetEntryId, ctx),
        error: "rewind was cancelled before navigation completed.",
      });
      return;
    }

    const leafId = readLeafId(ctx) ?? null;
    pi.appendEntry(REWIND_ENTRY_TYPE, buildRewindEntry(targetEntryId, leafId, now()));
    await restore(ctx);
    emit(ctx, { ...base(request), ok: true, data: rewindResult(false, targetEntryId, ctx) });
  }

  async function handleCompact(request: SuperpiRequest, ctx: ExtensionCommandContext): Promise<void> {
    const parsed = CompactDataSchema.safeParse(request.data ?? {});
    if (!parsed.success) {
      emit(ctx, { ...base(request), ok: false, error: `invalid compact data: ${formatIssues(parsed.error)}` });
      return;
    }
    if (!ctx.isIdle()) {
      emit(ctx, {
        ...base(request),
        ok: false,
        data: buildState(ctx),
        error: "manual compaction is unavailable while the agent is busy",
      });
      return;
    }
    if (compactionActive) {
      emit(ctx, {
        ...base(request),
        ok: false,
        data: buildState(ctx),
        error: "a compaction is already in progress",
      });
      return;
    }

    const completion = new Promise<CompactOutcome>((resolve) => {
      pendingCompact = { settle: resolve };
    });
    compactionActive = true;
    try {
      ctx.compact({
        ...(parsed.data.customInstructions !== undefined
          ? { customInstructions: parsed.data.customInstructions }
          : {}),
        onComplete: () => settleCompact({ ok: true }),
        onError: (error) => settleCompact({ ok: false, error: error.message }),
      });
    } catch (error) {
      settleCompact({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }

    // Wait for the documented callback or the session_compact/session_compact_failed
    // event. Never report completion before one of them settles.
    const outcome = await completion;
    if (outcome.ok) {
      emit(ctx, { ...base(request), ok: true, data: { compacted: true } });
    } else {
      emit(ctx, {
        ...base(request),
        ok: false,
        data: buildState(ctx),
        error: `compaction failed: ${outcome.error}`,
      });
    }
  }

  async function handleArgs(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const parsed = parseRequestArg(args);
    if (!parsed.ok) {
      emit(ctx, {
        version: PROTOCOL_VERSION,
        sessionKey: parsed.sessionKey,
        requestId: parsed.requestId,
        operation: parsed.operation,
        ok: false,
        error: parsed.error,
      });
      return;
    }

    const request = parsed.request;
    if (!expectedSessionKey) {
      emit(ctx, {
        ...base(request),
        ok: false,
        error: `${SESSION_KEY_ENV} is not set for this process; refusing control request.`,
      });
      return;
    }
    if (request.sessionKey !== expectedSessionKey) {
      emit(ctx, { ...base(request), ok: false, error: "session key mismatch; refusing control request." });
      return;
    }
    if (origin() !== "root") {
      emit(ctx, {
        ...base(request),
        ok: false,
        data: buildState(ctx),
        error: "superpi companion is not the root owner (origin=child); controls are root-only.",
      });
      return;
    }

    switch (request.operation) {
      case "hello":
        handleHello(request, ctx);
        return;
      case "get-state":
        emit(ctx, { ...base(request), ok: true, data: buildState(ctx) });
        return;
      case "configure":
        await handleConfigure(request, ctx);
        return;
      case "rewind":
        await handleRewind(request, ctx);
        return;
      case "compact":
        await handleCompact(request, ctx);
        return;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    // Subscribe and announce synchronously so bridge forwarding is ready before
    // any awaited model work; the returned promise lets callers await restore.
    const restoring = restore(ctx);
    if (rootFlagged()) {
      bridgeTracker.reset();
      subscribeBridge(ctx);
      emitRootSignal(ctx);
    }
    return restoring;
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", async (event, ctx) => {
    if (origin() !== "root") return;
    // Our own session-only setModel call must not re-enter expansion.
    if (applyingModel) return;
    if (!settings.longContext) return;
    // Catalog guard: only react to genuine catalog selections, never the
    // session-local clone already carrying the expanded window (absent from the
    // registry). Old-baseline guard: the tracked source is already expanded.
    if (ctx.modelRegistry.find(event.model.provider, event.model.id) !== event.model) return;
    if (tracking.model === event.model && tracking.baseline !== undefined) return;
    const plan = planExpandedContext(tracking, event.model, expandedTarget);
    if (plan.ok && (await applySessionModel(plan.model))) {
      trackExpandedContext(tracking, plan.source, plan.baseline);
    }
  });
  pi.on("session_before_compact", () => {
    compactionActive = true;
  });
  pi.on("session_compact", () => {
    settleCompact({ ok: true });
  });
  pi.on("session_compact_failed", (event) => {
    settleCompact({ ok: false, error: event.errorMessage ?? "compaction was aborted" });
  });
  pi.on("session_shutdown", () => {
    disposeBridge();
    settleCompact({ ok: false, error: "session shut down before compaction completed" });
    // The catalog object was never mutated, so shutdown only drops per-session
    // tracking; there is no registry window to restore.
    if (origin() === "root") clearExpandedContext(tracking);
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (origin() !== "root") return undefined;
    return applyTierToPayload(event.payload, ctx.model, settings.tier);
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Superpi control protocol (base64url-encoded JSON).",
    handler: (args, ctx) => handleArgs(args, ctx),
  });

  return {
    get origin() { return origin(); },
    expectedSessionKey,
    handleArgs,
    buildState,
    restore,
    activeChildren: () => bridgeTracker.activeChildren(),
  };
}
