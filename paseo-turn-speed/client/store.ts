import {
  cacheStats,
  calibrate,
  initialMeterState,
  reduceMeter,
  summarizeTurn,
  DEFAULT_CHARS_PER_TOKEN,
  REASONING_CHARS_PER_TOKEN,
  type CacheCountingMode,
  type MeterAction,
  type MeterState,
  type TurnSummary,
} from "./meter";

interface StoreSample {
  at: number;
  /** Estimated cumulative output tokens for the current turn. */
  est: number;
}

const MAX_SAMPLES_MS = 12_000;

export interface AgentSpeedStoreDeps {
  agentId: string;
  /** Effective chars/token for the agent's model (manual or calibrated). */
  charsPerToken(model: string | null): number;
  /** Learned chars/token for a model, ignoring any manual override. */
  learnedCharsPerToken(model: string): number | undefined;
  /** Called when a step produced a new chars/token measurement to persist. */
  onCalibration(model: string, charsPerToken: number): void;
  /** How the provider reports prompt cache reads (see `cacheStats`). */
  cacheCounting(): CacheCountingMode;
  now(): number;
}

/**
 * Per-agent holder of `MeterState`. Owns live-rate samples and folds usage
 * steps into the chars/token calibration; the reducer itself stays pure.
 *
 * Deliberately a closure factory, not a class: the Paseo client compiler
 * bundles classes as anonymous `class {` expressions, which Hermes (the
 * mobile app's JS engine) rejects with "Invalid expression encountered".
 */
export interface AgentSpeedStore {
  readonly agentId: string;
  readonly state: MeterState;
  readonly provider: string | null;
  readonly model: string | null;
  subscribe(listener: () => void): () => void;
  getSnapshot(): MeterState;
  /** True once any usage payload arrived since attach, even if absorbed. */
  readonly everSawUsage: boolean;
  setIdentity(provider: string | null | undefined, model: string | null | undefined): void;
  dispatch(action: MeterAction): void;
  liveTokPerSec(windowSec: number, maxTokPerSec?: number): number | null;
  summary(now?: number): TurnSummary;
  isRunning(): boolean;
}

export function createAgentSpeedStore(deps: AgentSpeedStoreDeps): AgentSpeedStore {
  let state = initialMeterState();
  let provider: string | null = null;
  let model: string | null = null;
  let samples: StoreSample[] = [];
  let lastRejectionLog = "";
  let everSawUsage = false;
  const listeners = new Set<() => void>();

  const now = () => deps.now();

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A render failure must not break the event stream.
      }
    }
  };

  const summary = (at?: number): TurnSummary =>
    summarizeTurn(state, deps.charsPerToken(model), at ?? now(), deps.cacheCounting());

  const pushSample = () => {
    if (state.phase !== "running") {
      samples = [];
      return;
    }
    const at = now();
    // A gap longer than the retention means the stream stalled (tool run,
    // user wait): old samples would drag the live rate toward zero, drop them.
    const newest = samples[samples.length - 1];
    if (newest && at - newest.at > MAX_SAMPLES_MS) samples = [];
    const est = summary(at).estTokens;
    const last = samples[samples.length - 1];
    if (last && at - last.at < 120) {
      samples[samples.length - 1] = { at, est };
    } else {
      samples.push({ at, est });
    }
    const cutoff = at - MAX_SAMPLES_MS;
    while (samples.length > 2 && samples[0].at < cutoff) samples.shift();
  };

  const store: AgentSpeedStore = {
    agentId: deps.agentId,
    get state() {
      return state;
    },
    get provider() {
      return provider;
    },
    get everSawUsage() {
      return everSawUsage;
    },
    get model() {
      return model;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return state;
    },
    setIdentity(nextProvider, nextModel) {
      const resolvedProvider = nextProvider ?? provider;
      const resolvedModel = nextModel ?? model;
      if (resolvedProvider === provider && resolvedModel === model) return;
      const modelChanged = resolvedModel !== null && resolvedModel !== model;
      provider = resolvedProvider;
      model = resolvedModel;
      // The exclusion verdict is a property of the model behind the agent:
      // switching models clears it in the reducer. A not-yet-known identity
      // dispatches nothing, so the first `setIdentity(…, null)` cannot undo
      // a verdict learned earlier.
      if (modelChanged) store.dispatch({ t: "model_changed", model: resolvedModel });
      emit();
    },
    dispatch(action) {
      const prev = state;
      const next = reduceMeter(state, action);
      if (action.t === "usage" && action.usage.output != null) everSawUsage = true;
      if (next === state) return;
      state = next;
      if (action.t === "model_changed") {
        console.log(
          `turn-speed: model [${deps.agentId.slice(0, 8)}] now=${action.model ?? "?"}` +
            ` thinking-verdict=${next.thinkingExcluded ? "excluded" : "unknown"}` +
            `${next.thinkingExcludedModel ? ` (learned on ${next.thinkingExcludedModel})` : ""}`,
        );
      }
      if (next.steps.length > prev.steps.length) {
        const step = next.steps[next.steps.length - 1];
        const thinking = next.thinkingExcluded
          ? (step.thinkingChars - step.thinkingLateChars) / REASONING_CHARS_PER_TOKEN
          : 0;
        const rate =
          step.decodeMs > 0 ? ((step.outTokens + thinking) / (step.decodeMs / 1000)).toFixed(1) : "inf";
        const thinkPart =
          step.thinkingChars > 0 ? ` thinkChars=${step.thinkingChars} think~${Math.round(thinking)}` : "";
        const stepCache = cacheStats(step.inputTokens, step.cachedTokens, deps.cacheCounting());
        const hit = stepCache.hitRate === null ? "n/a" : `${Math.round(stepCache.hitRate * 100)}%`;
        console.log(
          `turn-speed: step ok [${deps.agentId.slice(0, 8)}] out=${step.outTokens}${thinkPart} in=${step.inputTokens}` +
            ` cached=${step.cachedTokens} (${hit}) decodeMs=${Math.round(step.decodeMs)} waitMs=${Math.round(step.waitMs)}` +
            ` rate=${rate} verdict=${next.thinkingExcluded ? "excluded" : "off"}`,
        );
      }
      if (next.stepRejected) {
        const line = `${next.stepRejected.tokens}|${Math.round(next.stepRejected.windowMs)}`;
        if (line !== lastRejectionLog) {
          lastRejectionLog = line;
          console.log(
            `turn-speed: step kept without a window [${deps.agentId.slice(0, 8)}]` +
              ` tokens=${next.stepRejected.tokens} windowMs=${Math.round(next.stepRejected.windowMs)}` +
              " (implied rate above the plausibility cap, or too short to measure;" +
              " kept in the turn totals as unattributed tokens)",
          );
        }
      }
      if (next.calibInput) {
        const { chars, tokens } = next.calibInput;
        // Calibration learning keeps running on real data even while a manual
        // override hides it from the estimate.
        if (model) {
          const measured = calibrate(deps.learnedCharsPerToken(model), chars, tokens);
          if (measured !== null) deps.onCalibration(model, measured);
        }
      }
      pushSample();
      emit();
    },
    liveTokPerSec(windowSec: number, maxTokPerSec?: number) {
      const windowMs = Math.max(0.5, windowSec) * 1000;
      const at = now();
      const cutoff = at - windowMs;
      let first: StoreSample | null = null;
      let last: StoreSample | null = null;
      for (const sample of samples) {
        if (sample.at < cutoff) continue;
        if (!first) first = sample;
        last = sample;
      }
      if (!first || !last || last === first) {
        // Not enough history inside the window: widen to whatever we have.
        if (samples.length < 2) return null;
        first = samples[0];
        last = samples[samples.length - 1];
      }
      const spanMs = last.at - first.at;
      if (spanMs < 250) return null;
      const tokens = last.est - first.est;
      if (tokens <= 0) return null;
      const rate = tokens / (spanMs / 1000);
      // Beyond the plausibility cap the window holds a bookkeeping jump
      // (aggregated usage, reasoning bulk), not streaming speed: no number.
      if (maxTokPerSec !== undefined && rate > maxTokPerSec) return null;
      return rate;
    },
    summary,
    isRunning() {
      return state.phase === "running";
    },
  };
  return store;
}

export const DEFAULT_CPT = DEFAULT_CHARS_PER_TOKEN;
