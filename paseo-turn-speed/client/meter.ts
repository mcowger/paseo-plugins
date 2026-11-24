/**
 * Pure per-agent turn meter. No SDK, no timers, no I/O: every action carries
 * its own timestamp so the whole reducer is unit-testable with `node --test`.
 *
 * Usage counters arrive as snapshots of provider-reported totals that grow
 * within an assistant message (and may reset when a new message starts). The
 * meter therefore works in differences between consecutive events; a value
 * below the last seen one is treated as a reset and counts whole.
 *
 * Step model: one model call runs from its first streamed text to the usage
 * event that closes it. That window includes tool-argument generation, which
 * is decode time and output tokens even though no assistant text grows. The
 * gap between a step's usage and the next step's first text is wait time:
 * tool execution, queueing, and the next call's prefill.
 *
 * Whenever the provider reports the model is blocked on the user (a question
 * or permission request), that interval is tracked separately: it is removed
 * from step decode/wait windows and from the whole-turn rate, while the turn
 * clock itself keeps running in wall time. While the agent's work runs in
 * subagents (a delegated interval), that time is likewise removed from the
 * whole-turn rate — the subagents' own pills carry their speed — but it stays
 * inside decode/wait windows, because a delegated call is just another tool
 * run between the agent's model calls.
 *
 * Thinking tokens: some providers (measured on OpenCode + local reasoning
 * models) report `output` with the reasoning tokens subtracted while the
 * thinking itself streams as reasoning text and its decode time sits in the
 * step window. Counting only `output` then under-reports rates by the whole
 * thinking share. When a closed step shows far more reasoning characters
 * than its output tokens could pay for, the meter marks the turn as
 * `thinkingExcluded` and credits an estimate of the thinking tokens (reasoning
 * characters divided by the reasoning-specific chars/token ratio, measured
 * well above the visible-text one), marked approximate: reasoning that streamed
 * from the step start covers its own window time and enters the decode rate;
 * reasoning delivered as a late bulk (after the step's visible text began)
 * has no measured time, so it only enters turn totals and the whole-turn
 * rate. Providers that report thinking inside `output` never trigger this.
 *
 * Usage deltas the plausibility guard rejects are not dropped: they land in
 * `unattributedTokens`, counted in token totals and the whole-turn rate
 * without a decode window of their own.
 */

/** A live-window text gap longer than this is treated as a stall. */
export const MAX_TEXT_GAP_MS = 2000;
export const DEFAULT_CHARS_PER_TOKEN = 3.6;
/** Steps implying a faster decode than this are treated as misattributed
 * usage (e.g. a previous message's late step-finish landing in this turn)
 * and folded into the baseline instead of opening a step. */
export const DEFAULT_MAX_TOK_PER_SEC = 400;
/** Below this a usage window cannot resolve a rate: a trailing delta of a few
 * tokens that lands milliseconds after its own step would otherwise be
 * charged as a burst of hundreds of tok/s (measured: 3 tokens over 8 ms).
 * Real streamed steps decode over hundreds of milliseconds, so the floor only
 * ever catches deltas that never had a window of their own. */
export const MIN_MEASURABLE_WINDOW_MS = 100;
/** Message keys remembered across turns, so a snapshot of an older message
 * arriving late is recognised as "no growth" instead of a fresh text flood. */
const MAX_TEXT_KEYS = 32;
export const CAL_MIN = 2;
export const CAL_MAX = 8;
export const CAL_MIN_CHARS = 40;
/** A closed step whose reasoning characters exceed its output tokens by this
 * much cannot be reporting thinking inside `output`: mark the turn as one
 * where the provider excludes reasoning tokens from the reported numbers. */
export const EXCLUDED_EVIDENCE_RATIO = 8;
/** Below this many reasoning characters the evidence above is too noisy. */
export const EXCLUDED_MIN_CHARS = 200;
/** Reasoning prose encodes more characters per token than visible answers,
 * and the calibrated visible ratio is additionally biased low: usage
 * `output` counts tool-call arguments, which never stream as text. Measured
 * across ~41k reasoning tokens of real OpenCode + local reasoning sessions:
 * streamed reasoning text runs ~3.7 characters per reasoning token, so the
 * thinking estimate uses this dedicated ratio instead of the model's
 * visible-text calibration. */
export const REASONING_CHARS_PER_TOKEN = 3.7;
/** A closed step whose reported output tokens already pay for its streamed
 * reasoning characters — at most 1.4× the reasoning ratio, headroom for
 * token-dense prose — says thinking is inside `output`: excluded heavy
 * thinking could not be this cheap to report. Between this and
 * EXCLUDED_EVIDENCE_RATIO sits a neutral band that concludes nothing. A
 * single such step can also be a tool-heavy fluke on an excluding provider,
 * so a streak of them is needed to revoke the verdict — e.g. after the
 * provider config started including usage differently. One excluding-style
 * step re-arms it, so a wrong revocation costs at most a step of
 * undercounting; without revocation a wrong verdict double-counts forever. */
export const INCLUSION_EVIDENCE_RATIO = REASONING_CHARS_PER_TOKEN * 1.4;
export const INCLUSION_EVIDENCE_STEPS = 3;

export interface UsageSnapshot {
  input?: number | null;
  /** Prompt tokens served from the provider's cache (cache reads). */
  cached?: number | null;
  /**
   * Prompt tokens written into the provider's cache (Anthropic's
   * `cache_creation_input_tokens`). Part of the prompt the model had to
   * process, so it belongs in the cache-hit denominator.
   *
   * Paseo's AgentUsage carries no such field today (see the note on
   * `cacheStats`), so the client always sends 0; the slot exists so a
   * provider that starts reporting it changes one mapper, not the formula.
   */
  cacheWrite?: number | null;
  output?: number | null;
  ctxMax?: number | null;
  ctxUsed?: number | null;
}

export interface StepRecord {
  /** Output tokens produced by this model call. */
  outTokens: number;
  /** First text -> usage arrival: decode including tool arguments. */
  decodeMs: number;
  /** Previous step end -> this step's first text (tool run + prefill). */
  waitMs: number;
  /** Prompt tokens this call consumed. */
  inputTokens: number;
  /** Cached prompt tokens this call reported. */
  cachedTokens: number;
  /** Reasoning characters streamed during this step (thinking estimate). */
  thinkingChars: number;
  /** The subset that arrived late (after the step's visible text started):
   * a bulk delivery of the reasoning block, whose generation time the step
   * window never saw. Their tokens count in turn totals but not in the
   * decode-window rate. */
  thinkingLateChars: number;
  /** Prompt tokens this call wrote into the cache; 0 when unreported. */
  cacheWriteTokens: number;
  /** Prefill/TTFT measured on the first step only, else 0. */
  prefillMs: number;
}

export type TurnPhase = "idle" | "running" | "completed" | "failed" | "canceled";

/** One completed interval of the model being blocked on the user
 * (question, permission prompt, plan approval). */
export interface UserWaitInterval {
  start: number;
  end: number;
}

export interface MeterState {
  phase: TurnPhase;
  turnId: string | null;
  startedAt: number | null;
  /** The turn was discovered while it was already running (plugin reload, app
   * reopen, reconnect), so every event before this instant is unobserved while
   * the clock still starts at the turn's real boundary. Null when the turn was
   * seen from its first event. */
  seededFrom: number | null;
  /** First assistant/reasoning growth of the turn => end of prefill. */
  firstTextAt: number | null;
  lastTextAt: number | null;
  /** First text since the last step boundary (null = re-anchored). */
  stepFirstTextAt: number | null;
  /** First visible-text and first reasoning growth since the step boundary.
   * Their order tells streamed thinking (window-covering) from a late bulk
   * delivery of a reasoning block (whose generation time the window misses). */
  stepFirstVisibleAt: number | null;
  stepFirstReasoningAt: number | null;
  /** Usage arrival of the last completed step. */
  prevStepEndAt: number | null;
  /** Per-message observed text length (snapshot vs delta normalised). */
  textLens: Readonly<Record<string, number>>;
  /** Last text seen per key, to tell snapshots from deltas. */
  textTails: Readonly<Record<string, string>>;
  /** Last usage seen, for display. */
  usageOut: number | null;
  usageIn: number | null;
  usageCached: number | null;
  ctxMax: number | null;
  ctxUsed: number | null;
  /** Last seen cumulative counters; the baseline for the next delta. */
  prevUsageOut: number;
  prevUsageIn: number;
  prevUsageCached: number;
  prevUsageCacheWrite: number;
  steps: readonly StepRecord[];
  /** Characters streamed since the last step boundary (live estimate). */
  liveChars: number;
  /** All characters streamed this turn (fallback estimate). */
  totalChars: number;
  /** Reasoning-only characters since the last step boundary (⊆ liveChars). */
  liveReasoningChars: number;
  /** Reasoning-only characters streamed this turn (⊆ totalChars). */
  totalReasoningChars: number;
  /** Usage tokens the plausibility guard rejected, kept for whole-turn totals. */
  unattributedTokens: number;
  /** Set once a step showed reasoning characters no `output` figure could
   * pay for: this provider excludes thinking from its reported output, so
   * rates add an estimate from the streamed reasoning text. */
  thinkingExcluded: boolean;
  /** Model id (`model_changed`) the verdict belongs to: an exclusion is a
   * provider-model property, so switching to a model that reports thinking
   * inside `output` must not double-count it. Null while the identity was
   * not yet known when the verdict was learned. */
  thinkingExcludedModel: string | null;
  /** Consecutive closed steps whose `output` already paid for the streamed
   * reasoning characters; enough of them revoke a stale verdict. */
  inclusionStreak: number;
  /** Completed user-wait intervals inside this turn. */
  userWaits: readonly UserWaitInterval[];
  /** Start of the open user-wait interval, null when the model is live. */
  pausedAt: number | null;
  /** Completed intervals where the agent's work ran in subagents. */
  delegatedWaits: readonly UserWaitInterval[];
  /** Start of the open delegation interval, null while the agent runs alone. */
  delegatedAt: number | null;
  /** Completed intervals where a tool (shell, edit, fetch, …) was running.
   * The model generates nothing while a call is open, whatever the provider's
   * usage deltas say about when the step ended. */
  toolWaits: readonly UserWaitInterval[];
  /** Start of the open tool interval, null while no call is in flight. */
  toolAt: number | null;
  /** True once any real usage step landed during this turn. */
  sawUsage: boolean;
  /** Set when a usage delta was dropped as physically impossible. */
  stepRejected: { tokens: number; windowMs: number } | null;
  /** Set on each usage step for the store to fold into calibration. */
  calibInput: { chars: number; tokens: number } | null;
  endedAt: number | null;
  endNote: string | null;
  /** Ended from an agent snapshot rather than a terminal event: the clock is
   * stopped, but the outcome (completed / failed / canceled) is still open and
   * the real terminal event for this turn may replace it. */
  provisional: boolean;
}

export type MeterAction =
  | {
      t: "turn_started";
      at: number;
      turnId: string | null;
      /** When watching began, for a turn discovered mid-flight. */
      observedFrom?: number;
    }
  | { t: "text"; at: number; key: string; text: string; kind?: "text" | "reasoning" }
  | { t: "usage"; at: number; usage: UsageSnapshot; maxTokPerSec?: number }
  | { t: "compaction"; at: number }
  /** The model blocked on the user (question asked, permission pending). */
  | { t: "user_wait_started"; at: number }
  /** The user answered: the model woke up. */
  | { t: "user_wait_ended"; at: number }
  /** Subagents of this agent started running: the model is delegated. */
  | { t: "delegated_started"; at: number }
  /** All subagents finished: the agent works alone again. */
  | { t: "delegated_ended"; at: number }
  /** A tool call is running (shell, edit, fetch, …): the model produces
   * nothing until it returns. The caller opens one interval for a batch of
   * concurrent calls, exactly like the user-wait and delegation pairs: the
   * end closes whatever is open, so the caller only transitions on empty↔full. */
  | { t: "tool_started"; at: number }
  /** The last open tool call returned. */
  | { t: "tool_ended"; at: number }
  | { t: "turn_ended"; at: number; kind: "completed" | "failed" | "canceled"; usage?: UsageSnapshot; maxTokPerSec?: number; note?: string | null; turnId?: string | null; provisional?: boolean }
  /** The agent switched model (or its identity just became known): a
   * thinking-exclusion verdict learned on another model must not carry. */
  | { t: "model_changed"; model: string | null }
  /** Drop the locally observed turn (epoch replacement, reconnect, reload). */
  | { t: "reset" };

export function initialMeterState(): MeterState {
  return {
    phase: "idle",
    turnId: null,
    startedAt: null,
    seededFrom: null,
    firstTextAt: null,
    lastTextAt: null,
    stepFirstTextAt: null,
    stepFirstVisibleAt: null,
    stepFirstReasoningAt: null,
    prevStepEndAt: null,
    textLens: {},
    textTails: {},
    usageOut: null,
    usageIn: null,
    usageCached: null,
    ctxMax: null,
    ctxUsed: null,
    prevUsageOut: 0,
    prevUsageIn: 0,
    prevUsageCached: 0,
    prevUsageCacheWrite: 0,
    steps: [],
    liveChars: 0,
    totalChars: 0,
    liveReasoningChars: 0,
    totalReasoningChars: 0,
    unattributedTokens: 0,
    thinkingExcluded: false,
    thinkingExcludedModel: null,
    inclusionStreak: 0,
    userWaits: [],
    pausedAt: null,
    delegatedWaits: [],
    delegatedAt: null,
    toolWaits: [],
    toolAt: null,
    sawUsage: false,
    stepRejected: null,
    calibInput: null,
    endedAt: null,
    endNote: null,
    provisional: false,
  };
}

function num(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Count growth for one message key. Snapshot streams (full text each time)
 * and delta streams (fragments) both normalise to a growth amount. */
function growText(
  state: MeterState,
  key: string,
  text: string,
): { lens: Record<string, number>; tails: Record<string, string>; growth: number } {
  const prevLen = state.textLens[key] ?? 0;
  const prevText = state.textTails[key] ?? "";
  let growth: number;
  let nextLen: number;
  if (prevText !== "" && text.startsWith(prevText)) {
    // Snapshot: the item carries the whole accumulated text.
    growth = Math.max(0, text.length - prevLen);
    nextLen = text.length;
  } else if (prevText === "") {
    growth = text.length;
    nextLen = text.length;
  } else {
    // Delta fragment or a fresh part (e.g. a new reasoning block).
    growth = text.length;
    nextLen = prevLen + text.length;
  }
  const lens = { ...state.textLens, [key]: nextLen };
  const tails = { ...state.textTails, [key]: text };
  // Bound the map: keys survive turn boundaries (late snapshots of older
  // messages must not re-count), so evict the oldest ones.
  const keys = Object.keys(lens);
  for (const stale of keys.slice(0, keys.length - MAX_TEXT_KEYS)) {
    delete lens[stale];
    delete tails[stale];
  }
  return { lens, tails, growth };
}

function applyText(
  state: MeterState,
  at: number,
  key: string,
  text: string,
  isReasoning: boolean,
): MeterState {
  if (state.phase !== "running" || text.length === 0) return state;
  const { lens, tails, growth } = growText(state, key, text);
  if (growth <= 0) return state;
  return {
    ...state,
    textLens: lens,
    textTails: tails,
    firstTextAt: state.firstTextAt === null ? at : state.firstTextAt,
    stepFirstTextAt: state.stepFirstTextAt === null ? at : state.stepFirstTextAt,
    stepFirstVisibleAt:
      !isReasoning && state.stepFirstVisibleAt === null ? at : state.stepFirstVisibleAt,
    stepFirstReasoningAt:
      isReasoning && state.stepFirstReasoningAt === null ? at : state.stepFirstReasoningAt,
    lastTextAt: at,
    liveChars: state.liveChars + growth,
    totalChars: state.totalChars + growth,
    liveReasoningChars: isReasoning ? state.liveReasoningChars + growth : state.liveReasoningChars,
    totalReasoningChars: isReasoning ? state.totalReasoningChars + growth : state.totalReasoningChars,
  };
}

/** Difference against the last seen value; a decrease means the provider
 * restarted its counters (new assistant message or session), in which case
 * the whole value belongs to this step. */
function delta(value: number | null, previous: number): { amount: number; next: number } {
  if (value === null) return { amount: 0, next: previous };
  return value >= previous
    ? { amount: value - previous, next: value }
    : { amount: value, next: value };
}

/** Milliseconds inside [from, to] during which the model produced nothing
 * itself — blocked on the user, delegated to subagents, or waiting for a tool
 * to return; none of those may be charged to a decode window. Overlapping
 * stretches count once, and an open interval counts up to `to`. */
function waitOverlap(state: MeterState, from: number, to: number): number {
  if (to <= from) return 0;
  const asleep: UserWaitInterval[] = [
    ...state.userWaits,
    ...state.delegatedWaits,
    ...state.toolWaits,
  ];
  if (state.pausedAt !== null) asleep.push({ start: state.pausedAt, end: to });
  if (state.delegatedAt !== null) asleep.push({ start: state.delegatedAt, end: to });
  if (state.toolAt !== null) asleep.push({ start: state.toolAt, end: to });
  return unionOverlapMs(asleep, from, to);
}

/** Move the open user-wait interval into the completed list. */
function closeWait(state: MeterState, at: number): MeterState {
  return state.pausedAt === null
    ? state
    : {
        ...state,
        pausedAt: null,
        userWaits: [...state.userWaits, { start: state.pausedAt, end: Math.max(at, state.pausedAt) }],
      };
}

/** Move the open delegation interval into the completed list. */
function closeDelegated(state: MeterState, at: number): MeterState {
  return state.delegatedAt === null
    ? state
    : {
        ...state,
        delegatedAt: null,
        delegatedWaits: [
          ...state.delegatedWaits,
          { start: state.delegatedAt, end: Math.max(at, state.delegatedAt) },
        ],
      };
}

/** Move the open tool interval into the completed list. */
function closeTool(state: MeterState, at: number): MeterState {
  return state.toolAt === null
    ? state
    : {
        ...state,
        toolAt: null,
        toolWaits: [
          ...state.toolWaits,
          { start: state.toolAt, end: Math.max(at, state.toolAt) },
        ],
      };
}

/** Milliseconds inside [from, to] covered by at least one interval, counting
 * overlapping intervals once (a user wait during a delegation is one pause,
 * not two). */
function unionOverlapMs(intervals: readonly UserWaitInterval[], from: number, to: number): number {
  if (to <= from) return 0;
  const clipped = intervals
    .map((wait) => [Math.max(wait.start, from), Math.min(wait.end, to)] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let runStart = Number.NEGATIVE_INFINITY;
  let runEnd = Number.NEGATIVE_INFINITY;
  for (const [start, end] of clipped) {
    if (start > runEnd) {
      if (runEnd > runStart) total += runEnd - runStart;
      runStart = start;
      runEnd = end;
    } else if (end > runEnd) {
      runEnd = end;
    }
  }
  if (runEnd > runStart) total += runEnd - runStart;
  return total;
}

function applyUsage(
  state: MeterState,
  at: number,
  usage: UsageSnapshot,
  maxTokPerSec?: number,
): MeterState {
  const out = num(usage.output);
  const inp = num(usage.input);
  const cached = num(usage.cached);
  const cacheWrite = num(usage.cacheWrite);
  const counters = {
    usageOut: out ?? state.usageOut,
    usageIn: inp ?? state.usageIn,
    usageCached: cached ?? state.usageCached,
    ctxMax: num(usage.ctxMax) ?? state.ctxMax,
    ctxUsed: num(usage.ctxUsed) ?? state.ctxUsed,
  };
  const outDelta = delta(out, state.prevUsageOut);
  const inDelta = delta(inp, state.prevUsageIn);
  const cachedDelta = delta(cached, state.prevUsageCached);
  const cacheWriteDelta = delta(cacheWrite, state.prevUsageCacheWrite);
  const withCounters: MeterState = {
    ...state,
    ...counters,
    prevUsageOut: outDelta.next,
    prevUsageIn: inDelta.next,
    prevUsageCached: cachedDelta.next,
    prevUsageCacheWrite: cacheWriteDelta.next,
  };
  if (state.phase !== "running") return { ...withCounters };
  if (outDelta.amount <= 0) {
    // No new answer tokens: refresh counters without opening a step.
    return { ...withCounters, calibInput: null, stepRejected: null };
  }
  const stepStart = state.stepFirstTextAt ?? state.prevStepEndAt ?? state.startedAt ?? at;
  const stepDecodeMs = Math.max(0, at - stepStart - waitOverlap(state, stepStart, at));
  const stepWaitMs =
    state.steps.length === 0 || state.stepFirstTextAt === null || state.prevStepEndAt === null
      ? 0
      : Math.max(
          0,
          state.stepFirstTextAt -
            state.prevStepEndAt -
            waitOverlap(state, state.prevStepEndAt, state.stepFirstTextAt),
        );
  // A delta implying more tokens than the window could physically decode is
  // not this turn's work: typically the previous (interrupted) message's
  // step-finish landing late. Absorb it into the baseline, keep the window.
  // The other direction is just as unusable: a window of a few milliseconds
  // (a trailing delta of 2-3 tokens landing right behind its own step) has no
  // rate resolution at all, and prints hundreds of tok/s. Both kinds of token
  // stay in the turn totals, they just do not buy a window.
  const threshold = maxTokPerSec ?? DEFAULT_MAX_TOK_PER_SEC;
  const impliedRate =
    stepDecodeMs > 0 ? outDelta.amount / (stepDecodeMs / 1000) : Number.POSITIVE_INFINITY;
  if (stepDecodeMs < MIN_MEASURABLE_WINDOW_MS || impliedRate > threshold) {
    return {
      ...withCounters,
      calibInput: null,
      // Real tokens with no trustworthy window of their own: keep them in
      // the turn totals instead of letting them vanish from every rate.
      unattributedTokens: state.unattributedTokens + outDelta.amount,
      stepRejected: { tokens: outDelta.amount, windowMs: stepDecodeMs },
    };
  }
  const prefillMs =
    state.steps.length === 0 && state.firstTextAt !== null && state.startedAt !== null
      ? Math.max(0, state.firstTextAt - state.startedAt)
      : 0;
  // Reasoning that showed up only after this step's visible text was already
  // streaming is a bulk delivery of the finished block: the window missed
  // its generation. Reasoning that led (or carried) the window covered it.
  const reasoningLate =
    state.liveReasoningChars > 0 &&
    state.stepFirstVisibleAt !== null &&
    (state.stepFirstReasoningAt === null || state.stepFirstReasoningAt > state.stepFirstVisibleAt);
  const step: StepRecord = {
    outTokens: outDelta.amount,
    decodeMs: stepDecodeMs,
    waitMs: stepWaitMs,
    inputTokens: inDelta.amount,
    cachedTokens: cachedDelta.amount,
    thinkingChars: state.liveReasoningChars,
    thinkingLateChars: reasoningLate ? state.liveReasoningChars : 0,
    cacheWriteTokens: cacheWriteDelta.amount,
    prefillMs,
  };
  // More streamed reasoning characters than this step's output tokens could
  // possibly contain: the provider subtracts thinking from `output`.
  const thinkingEvidence =
    state.liveReasoningChars >= EXCLUDED_MIN_CHARS &&
    state.liveReasoningChars > outDelta.amount * EXCLUDED_EVIDENCE_RATIO;
  // The opposite signal: this step streamed meaningful reasoning yet its
  // reported output tokens alone already pay for those characters, meaning
  // the thinking is inside `output`. A single such step can also be a
  // tool-heavy step on an excluding provider, so a streak of them is needed
  // to revoke the verdict; one excluding-style step re-arms it.
  const inclusionEvidence =
    state.thinkingExcluded &&
    !thinkingEvidence &&
    state.liveReasoningChars >= EXCLUDED_MIN_CHARS &&
    state.liveReasoningChars <= outDelta.amount * INCLUSION_EVIDENCE_RATIO;
  const inclusionStreak = inclusionEvidence ? state.inclusionStreak + 1 : 0;
  const revoked = inclusionStreak >= INCLUSION_EVIDENCE_STEPS;
  return {
    ...withCounters,
    steps: [...state.steps, step],
    stepFirstTextAt: null,
    stepFirstVisibleAt: null,
    stepFirstReasoningAt: null,
    prevStepEndAt: at,
    liveChars: 0,
    liveReasoningChars: 0,
    sawUsage: true,
    thinkingExcluded: revoked ? false : state.thinkingExcluded || thinkingEvidence,
    inclusionStreak: revoked ? 0 : inclusionStreak,
    stepRejected: null,
    // Calibration pairs visible characters with visible tokens: reasoning
    // text must not enter it, or the ratio saturates against excluded output.
    calibInput: {
      chars: state.liveChars - state.liveReasoningChars,
      tokens: outDelta.amount,
    },
  };
}

/** A provisional end stopped the clock, but the step it froze still belongs
 * to this turn: usage that arrives afterwards must still close that step, or
 * the terminal payload's tokens never reach the turn's totals. */
function usageAccountingBase(state: MeterState): MeterState {
  return state.provisional ? { ...state, phase: "running" } : state;
}

/** Keep the stopped clock when only the accounting was updated. */
function keepProvisionalEnd(state: MeterState, next: MeterState): MeterState {
  if (!state.provisional) return next;
  return {
    ...next,
    phase: state.phase,
    endedAt: state.endedAt,
    endNote: state.endNote,
    provisional: true,
  };
}

function endTurn(
  state: MeterState,
  at: number,
  kind: "completed" | "failed" | "canceled",
  usage: UsageSnapshot | undefined,
  maxTokPerSec: number | undefined,
  note: string | null,
  turnId: string | null | undefined,
  provisional: boolean,
): MeterState {
  // A terminal event for another turn describes a turn this meter never
  // followed: it must not close this one, and it must not advance this turn's
  // usage baseline either. An empty id is no id, not another turn.
  const id = turnId || null;
  if (id !== null && state.turnId !== null && id !== state.turnId) return state;
  // A repeated cumulative payload contributes no delta and opens no step.
  const withUsage = usage
    ? applyUsage(usageAccountingBase(state), at, usage, maxTokPerSec)
    : state;
  if (withUsage.phase === "running") {
    // A turn that ends while a question is still open closes the wait there;
    // same for an ongoing delegation or an in-flight tool call.
    return {
      ...closeTool(closeDelegated(closeWait(withUsage, at), at), at),
      phase: kind,
      endedAt: at,
      endNote: note,
      provisional,
    };
  }
  // A provisional end only knows that the agent stopped working: an idle
  // snapshot cannot tell a completed turn from a failed or canceled one. The
  // real terminal event is authoritative for the same turn, so it replaces the
  // guess together with the outcome and the usage it carries.
  if (!withUsage.provisional) return state;
  return {
    ...withUsage,
    phase: kind,
    endedAt: at,
    endNote: note,
    provisional: false,
  };
}

export function reduceMeter(state: MeterState, action: MeterAction): MeterState {
  switch (action.t) {
    case "turn_started": {
      // Cumulative counters and their last-seen baseline survive the reset:
      // the baseline must come from what this plugin actually observed, not
      // from a snapshot that may already contain this turn's early usage.
      return {
        ...initialMeterState(),
        phase: "running",
        turnId: action.turnId || null,
        startedAt: action.at,
        // A seed marks the turn as only partly observed. A live `turn_started`
        // for the turn already being tracked (a re-announce after a
        // resubscribe) cannot undo that mark: the events before the seed are
        // still missing.
        seededFrom:
          action.observedFrom ??
          (action.turnId && state.phase === "running" && state.turnId === action.turnId
            ? state.seededFrom
            : null),
        ctxMax: state.ctxMax,
        ctxUsed: state.ctxUsed,
        textLens: state.textLens,
        textTails: state.textTails,
        prevUsageOut: state.prevUsageOut,
        prevUsageIn: state.prevUsageIn,
        prevUsageCached: state.prevUsageCached,
        prevUsageCacheWrite: state.prevUsageCacheWrite,
        // A provider-level property: survives turns like the usage baseline
        // — but only when it has a known owner. A verdict that never got a
        // model identity cannot tell an unchanged provider from an invisible
        // model switch, so each new turn re-derives it from fresh evidence.
        thinkingExcluded:
          state.thinkingExcludedModel === null ? false : state.thinkingExcluded,
        thinkingExcludedModel: state.thinkingExcludedModel,
        inclusionStreak: state.thinkingExcludedModel === null ? 0 : state.inclusionStreak,
      };
    }
    case "text":
      return applyText(
        state,
        action.at,
        action.key,
        action.text,
        action.kind === "reasoning" ||
          // Backwards compatibility with callers using the legacy key scheme.
          (action.kind === undefined && action.key.startsWith("reasoning")),
      );
    case "usage": {
      const next = applyUsage(
        usageAccountingBase(state),
        action.at,
        action.usage,
        action.maxTokPerSec,
      );
      return keepProvisionalEnd(state, next);
    }
    case "compaction":
      // Context was rewritten; streamed chars since the last step no longer
      // map to answer tokens. Drop the live window, keep step history.
      return state.phase === "running"
        ? { ...state, liveChars: 0, liveReasoningChars: 0 }
        : state;
    case "user_wait_started":
      return state.phase === "running" && state.pausedAt === null
        ? { ...state, pausedAt: action.at }
        : state;
    case "user_wait_ended":
      // An end for a wait we never saw (resolved before attach) is a no-op.
      return state.pausedAt === null ? state : closeWait(state, action.at);
    case "delegated_started":
      return state.phase === "running" && state.delegatedAt === null
        ? { ...state, delegatedAt: action.at }
        : state;
    case "delegated_ended":
      // An end for a delegation we never saw is a no-op.
      return state.delegatedAt === null ? state : closeDelegated(state, action.at);
    case "tool_started":
      return state.phase === "running" && state.toolAt === null
        ? { ...state, toolAt: action.at }
        : state;
    case "tool_ended":
      // An end for a call we never saw opened (started before attach) is a
      // no-op: there is no interval to close.
      return state.toolAt === null ? state : closeTool(state, action.at);
    case "turn_ended":
      return endTurn(
        state,
        action.at,
        action.kind,
        action.usage,
        action.maxTokPerSec,
        action.note ?? null,
        action.turnId,
        action.provisional === true,
      );
    case "reset":
      // Keep the observed usage baseline: the provider's counters outlive the
      // locally observed turn, so deltas must stay continuous.
      return {
        ...initialMeterState(),
        ctxMax: state.ctxMax,
        textLens: state.textLens,
        textTails: state.textTails,
        prevUsageOut: state.prevUsageOut,
        prevUsageIn: state.prevUsageIn,
        prevUsageCached: state.prevUsageCached,
        prevUsageCacheWrite: state.prevUsageCacheWrite,
        thinkingExcluded: state.thinkingExcluded,
        thinkingExcludedModel: state.thinkingExcludedModel,
        inclusionStreak: state.inclusionStreak,
      };
    case "model_changed": {
      const model = action.model;
      // An unknown identity must never clear a learned verdict: the model
      // simply is not on record yet.
      if (model === null || model === state.thinkingExcludedModel) return state;
      // A verdict learned before identity was known belongs to it: adopt
      // rather than revoke, the first concrete model is what we observed.
      if (state.thinkingExcluded && state.thinkingExcludedModel === null) {
        return { ...state, thinkingExcludedModel: model };
      }
      // Another model: the exclusion verdict was its property, not this
      // model's. Steps of the current turn stay; only the verdict resets.
      return {
        ...state,
        thinkingExcluded: false,
        thinkingExcludedModel: model,
        inclusionStreak: 0,
      };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Derived numbers (pure selectors)
// ---------------------------------------------------------------------------

export interface TurnSummary {
  /** Real output tokens this turn, or null when nothing real was seen. */
  outTokens: number | null;
  /** Estimated output tokens: real where available, chars/cpt for the tail. */
  estTokens: number;
  /** True when any part of the numbers is character-estimated. */
  approx: boolean;
  decodeMs: number;
  /** Sum of wait windows between steps (tool runs + later prefills). */
  waitMs: number;
  prefillMs: number | null;
  /** Whole-turn wall time including tool waits; null before start. */
  totalMs: number | null;
  /** Wall milliseconds the model spent blocked on the user this turn. */
  userWaitMs: number;
  /** True while an open user-wait interval is running. */
  waiting: boolean;
  /** Wall milliseconds this turn's work ran inside subagents. */
  delegatedMs: number;
  /** True while at least one subagent is running right now. */
  delegated: boolean;
  /** Wall milliseconds spent inside tool calls (shell, edit, fetch, …). */
  toolMs: number;
  /** True while a tool call is in flight: the model generates nothing. */
  tooling: boolean;
  tokPerSecDecode: number | null;
  /** Tokens per second over turn time minus user waits and tool calls. */
  tokPerSecTurn: number | null;
  steps: number;
  /** Prompt tokens consumed across the turn's calls. */
  inputTokens: number;
  /** Cached prompt tokens across the turn's calls. */
  cachedTokens: number;
  /** Prompt tokens written to the cache; 0 for providers that do not report it. */
  cacheWriteTokens: number;
  /** All prompt tokens across the turn's calls: input + writes + reads. */
  promptTokens: number;
  /** Cached share of `promptTokens` (0..1); null without prompt data. */
  cacheHitRate: number | null;
  /** Turn time and the token totals cover different stretches: the turn was
   * discovered mid-flight, so no rate over the whole turn is claimed (a partial
   * total is never shown), and `observedMs` says what was actually watched. */
  partial: boolean;
  /** Wall time watched by this plugin; null unless the turn is partial. */
  observedMs: number | null;
  /** Prompt tokens of the first step, for the prefill rate. */
  firstStepPromptTokens: number | null;
  /** Cached prompt tokens of the first step: with a warm cache the prompt
   * was restored, not prefilled, so the prefill rate is hidden then. */
  firstStepCachedTokens: number | null;
  /** Thinking tokens estimated from streamed reasoning characters (0 when
   * the provider reports thinking inside `output` or none was streamed). */
  thinkingTokens: number;
  /** Tokens from rejected usage bursts, counted in totals without a window. */
  unattributedTokens: number;
}

/**
 * How a provider reports prompt cache reads. The two common shapes cannot be
 * told apart from the numbers alone, hence the explicit override.
 *
 * - `inclusive` (OpenAI-style): the prompt counter already contains the cached
 *   tokens, so the prompt total is `inputTokens`.
 * - `separate` (Anthropic-style): `inputTokens` is only the uncached part and
 *   cache reads are reported on top, so the total is their sum.
 * - `auto`: infer from this call alone — cache reads larger than the prompt can
 *   only mean separate counters; otherwise assume the prompt includes them.
 *   Summarizing a turn, decide with `turnReportsSeparateCache` instead and pass
 *   an explicit mode, so one call cannot use a different shape from the rest.
 */
export type CacheCountingMode = "auto" | "inclusive" | "separate";

/**
 * Whether a turn's calls report cache reads outside the prompt counter.
 *
 * One call cannot tell the two shapes apart: a large uncached prompt and a
 * small cache read are the same pair of numbers whichever way the counters are
 * arranged. A whole turn can, because the shapes make different promises — an
 * inclusive provider can never report more cache reads than its prompt, so one
 * call that does proves disjoint counters for every call of the turn.
 *
 * Deciding per call instead lets a cache-cold call (a large prompt, a modest
 * cache read) fall back to the inclusive reading, and that call's cache reads
 * then stay out of the denominator while still counting in the numerator.
 * Measured on a real OpenCode turn: one such call moved 16k cache reads out of
 * the denominator and printed 86% where the prompt was 76% cache reads.
 */
export function turnReportsSeparateCache(
  steps: readonly { inputTokens: number; cachedTokens: number }[],
): boolean {
  return steps.some((step) => step.cachedTokens > 0 && step.cachedTokens > step.inputTokens);
}

/**
 * Prompt totals for one model call.
 *
 * The hit rate is the share of the prompt that was served without being
 * recomputed, so the denominator is the whole prompt:
 *
 *     hitRate = cacheRead / (newInput + cacheWrite + cacheRead)
 *
 * The `cacheWrite` term is Anthropic's `cache_creation_input_tokens`: those
 * tokens were part of the prompt even though they missed the cache, and
 * leaving them out inflates the rate whenever a TTL cache is being rebuilt.
 * Paseo's `AgentUsage` exposes only `inputTokens` and `cachedInputTokens`, so
 * the term is always 0 today and the formula collapses to
 * `cacheRead / (newInput + cacheRead)` — identical to the pre-cache-write
 * behaviour for every provider that does report 0.
 *
 * `hitRate` never exceeds 1: some providers fold cache writes into the same
 * counter they report as cache reads, and the clamp keeps that from printing
 * above 100%.
 */
export function cacheStats(
  inputTokens: number,
  cachedTokens: number,
  mode: CacheCountingMode = "auto",
  cacheWriteTokens = 0,
): { promptTokens: number; cachedTokens: number; hitRate: number | null } {
  const cached = Number.isFinite(cachedTokens) && cachedTokens > 0 ? cachedTokens : 0;
  const input = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const cacheWrite =
    Number.isFinite(cacheWriteTokens) && cacheWriteTokens > 0 ? cacheWriteTokens : 0;
  const separate = mode === "separate" || (mode === "auto" && cached > input);
  const promptTokens = separate ? input + cacheWrite + cached : input + cacheWrite;
  if (promptTokens <= 0) return { promptTokens: 0, cachedTokens: 0, hitRate: null };
  return {
    promptTokens,
    cachedTokens: cached,
    hitRate: Math.min(1, cached / promptTokens),
  };
}

export function summarizeTurn(
  state: MeterState,
  charsPerToken: number,
  now: number,
  cacheCounting: CacheCountingMode = "auto",
): TurnSummary {
  const realOut = state.steps.reduce((sum, s) => sum + s.outTokens, 0);
  const inputTokens = state.steps.reduce((sum, s) => sum + s.inputTokens, 0);
  const cachedTokens = state.steps.reduce((sum, s) => sum + s.cachedTokens, 0);
  const cacheWriteTokens = state.steps.reduce((sum, s) => sum + s.cacheWriteTokens, 0);
  const waitMs = state.steps.reduce((sum, s) => sum + s.waitMs, 0);
  const hasReal = state.sawUsage && realOut > 0;
  // Without any usage step there is no anchored window; the span of streamed
  // text stands in for it so estimate-only providers still get a decode rate.
  // While a step is open, its streamed characters already sit in `estTokens`
  // (as the tail estimate), so the running window from its first text counts
  // in the decode denominator too: freezing it at the closed steps would
  // divide a growing token count by stale windows and print a burst rate.
  const openWindowMs =
    state.phase === "running" && state.stepFirstTextAt !== null && state.liveChars > 0
      ? Math.max(
          0,
          now - state.stepFirstTextAt - waitOverlap(state, state.stepFirstTextAt, now),
        )
      : 0;
  const decodeMs =
    state.steps.length > 0
      ? state.steps.reduce((sum, s) => sum + s.decodeMs, 0) + openWindowMs
      : state.firstTextAt !== null && state.lastTextAt !== null
        ? Math.max(0, state.lastTextAt - state.firstTextAt)
        : 0;
  // Thinking estimate for providers detected as excluding reasoning from
  // `output`: reasoning characters converted with the reasoning-specific
  // chars/token ratio (visible-text calibration is biased by tool args).
  // Early thinking (reasoning led the step window) both adds tokens and was
  // paid for by window time; late bulks add tokens only, so they may count
  // in turn totals but never in the decode-window rate.
  const stepThinkingChars = state.steps.reduce((sum, s) => sum + s.thinkingChars, 0);
  const earlyThinking = state.thinkingExcluded
    ? state.steps.reduce((sum, s) => sum + (s.thinkingChars - s.thinkingLateChars), 0) /
      REASONING_CHARS_PER_TOKEN
    : 0;
  const lateThinking = state.thinkingExcluded
    ? state.steps.reduce((sum, s) => sum + s.thinkingLateChars, 0) / REASONING_CHARS_PER_TOKEN
    : 0;
  // Live reasoning characters enter the tail estimate only while reasoning
  // leads the open step (its arrival was paced with generation). A trailing
  // bulk of a finished reasoning block would fake a token burst.
  const liveReasoningEarly =
    state.stepFirstReasoningAt !== null &&
    (state.stepFirstVisibleAt === null || state.stepFirstReasoningAt <= state.stepFirstVisibleAt);
  const thinkingTokens = state.thinkingExcluded && hasReal
    ? (stepThinkingChars + (liveReasoningEarly ? state.liveReasoningChars : 0)) /
      REASONING_CHARS_PER_TOKEN
    : 0;
  const tailEst =
    (state.liveChars - state.liveReasoningChars) / charsPerToken +
    (liveReasoningEarly ? state.liveReasoningChars / REASONING_CHARS_PER_TOKEN : 0);
  const wholeEst =
    (state.totalChars - state.totalReasoningChars) / charsPerToken +
    (state.totalReasoningChars - (liveReasoningEarly ? 0 : state.liveReasoningChars)) /
      REASONING_CHARS_PER_TOKEN;
  let outTokens: number | null = null;
  let estTokens: number;
  let approx: boolean;
  if (hasReal) {
    outTokens = realOut;
    estTokens = realOut + earlyThinking + lateThinking + tailEst + state.unattributedTokens;
    approx = state.liveChars > 0 || earlyThinking + lateThinking > 0 || state.unattributedTokens > 0;
  } else {
    estTokens = wholeEst;
    approx = true;
  }
  // A turn discovered mid-flight has no observed prefill: the first text we
  // saw arrived long after the real one, so the gap measures the attach, not
  // the model.
  const prefillMs =
    state.seededFrom === null && state.firstTextAt !== null && state.startedAt !== null
      ? Math.max(0, state.firstTextAt - state.startedAt)
      : null;
  const end = state.endedAt ?? (state.phase === "running" ? now : null);
  const totalMs = state.startedAt !== null && end !== null ? Math.max(0, end - state.startedAt) : null;
  // What this plugin actually watched of a partly observed turn, for the row
  // that explains why its totals are smaller than the provider's.
  const observedMs =
    state.seededFrom !== null && end !== null ? Math.max(0, end - state.seededFrom) : null;
  let userWaitMs = 0;
  for (const wait of state.userWaits) userWaitMs += Math.max(0, wait.end - wait.start);
  if (state.pausedAt !== null && end !== null) userWaitMs += Math.max(0, end - state.pausedAt);
  let delegatedMs = 0;
  for (const wait of state.delegatedWaits) delegatedMs += Math.max(0, wait.end - wait.start);
  if (state.delegatedAt !== null && end !== null) delegatedMs += Math.max(0, end - state.delegatedAt);
  let toolMs = 0;
  for (const wait of state.toolWaits) toolMs += Math.max(0, wait.end - wait.start);
  if (state.toolAt !== null && end !== null) toolMs += Math.max(0, end - state.toolAt);
  // The turn's productive time: wall clock minus the stretches where the
  // agent produced nothing itself — blocked on the user, delegated to
  // subagents, or waiting for a tool to return. Overlapping stretches count
  // once.
  const asleep: UserWaitInterval[] = [
    ...state.userWaits,
    ...state.delegatedWaits,
    ...state.toolWaits,
  ];
  if (state.pausedAt !== null && end !== null) asleep.push({ start: state.pausedAt, end });
  if (state.delegatedAt !== null && end !== null) asleep.push({ start: state.delegatedAt, end });
  if (state.toolAt !== null && end !== null) asleep.push({ start: state.toolAt, end });
  const activeMs =
    totalMs !== null && state.startedAt !== null && end !== null
      ? Math.max(0, totalMs - unionOverlapMs(asleep, state.startedAt, end))
      : null;
  // Rejected bursts and late thinking bulks have no decode window of their
  // own, so they count in the whole-turn totals but never inflate the
  // decode-window rate.
  const decodeTokens = hasReal ? estTokens - state.unattributedTokens - lateThinking : estTokens;
  const tokPerSecDecode =
    decodeMs > 0 && decodeTokens > 0 ? decodeTokens / (decodeMs / 1000) : null;
  const tokPerSecTurn =
    state.seededFrom === null && activeMs !== null && activeMs > 0 && estTokens > 0
      ? estTokens / (activeMs / 1000)
      : null;
  // The counter shape is one property of the turn, not of a call: one cache-cold
  // call must not have its cache reads read back into the prompt it missed.
  const cacheMode: CacheCountingMode =
    cacheCounting === "separate" ||
    (cacheCounting === "auto" && turnReportsSeparateCache(state.steps))
      ? "separate"
      : "inclusive";
  let promptTokens = 0;
  let hitTokens = 0;
  for (const step of state.steps) {
    const stepCache = cacheStats(step.inputTokens, step.cachedTokens, cacheMode, step.cacheWriteTokens);
    promptTokens += stepCache.promptTokens;
    hitTokens += stepCache.cachedTokens;
  }
  const cacheHitRate = promptTokens > 0 ? Math.min(1, hitTokens / promptTokens) : null;
  return {
    outTokens,
    estTokens,
    approx,
    partial: state.seededFrom !== null,
    observedMs,
    decodeMs,
    waitMs,
    prefillMs,
    totalMs,
    userWaitMs,
    waiting: state.pausedAt !== null && state.phase === "running",
    delegatedMs,
    delegated: state.delegatedAt !== null && state.phase === "running",
    toolMs,
    tooling: state.toolAt !== null && state.phase === "running",
    tokPerSecDecode,
    tokPerSecTurn,
    steps: state.steps.length,
    inputTokens,
    cachedTokens,
    cacheWriteTokens,
    promptTokens,
    cacheHitRate,
    firstStepPromptTokens: state.steps.length > 0 && state.steps[0].inputTokens > 0 ? state.steps[0].inputTokens : null,
    firstStepCachedTokens: state.steps.length > 0 && state.steps[0].cachedTokens > 0 ? state.steps[0].cachedTokens : null,
    thinkingTokens,
    unattributedTokens: state.unattributedTokens,
  };
}

/** Blend a new chars/token measurement: EMA 0.7/0.3, clamped to CAL..CAL.
 * Small or nonsensical samples (mostly tool arguments, no visible text) are
 * rejected instead of poisoning the model's calibration. */
export function calibrate(
  prev: number | undefined,
  chars: number,
  tokens: number,
  minChars = CAL_MIN_CHARS,
): number | null {
  if (!(tokens > 0) || !(chars >= minChars)) return null;
  const observed = chars / tokens;
  // Below 1.5 char/token the sample is dominated by tool-call arguments
  // (counted in `output` but never streamed as text), not this model's text
  // ratio; above 12 it is usage bookkeeping noise (misattributed deltas).
  // Either end poisons the EMA toward the clamps (a single 20+ sample used to
  // pin the blend at CAL_MAX).
  if (!Number.isFinite(observed) || observed < 1.5 || observed > 12) return null;
  const base = typeof prev === "number" && Number.isFinite(prev) ? prev : DEFAULT_CHARS_PER_TOKEN;
  const next = 0.7 * base + 0.3 * observed;
  return Math.min(CAL_MAX, Math.max(CAL_MIN, next));
}
