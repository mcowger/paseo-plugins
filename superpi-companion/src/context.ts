/**
 * Known owned expanded-context budget from the inspected pi-microgpt
 * implementation. This is an integration budgeting limit, not verified
 * backend capacity.
 */
export const EXPANDED_CONTEXT_WINDOW = 1_050_000;

export interface ContextWindowModel {
  contextWindow: number;
}

/**
 * Per-session tracking for an applied expanded-context clone. `model` is the
 * catalog source the baseline belongs to, never the session-local clone, so a
 * later model switch records a fresh baseline instead of reusing a stale one.
 */
export interface ExpandedContextTracking {
  model: ContextWindowModel | undefined;
  baseline: number | undefined;
}

export type ExpandedContextPlan<T extends ContextWindowModel> =
  | {
      ok: true;
      /** Catalog model the recorded baseline came from. It is never mutated. */
      source: T;
      /** Session-local copy carrying the expanded window. */
      model: T;
      contextWindow: number;
      baseline: number;
    }
  | { ok: false; error: string };

/**
 * Plan a session-local expanded model without mutating the shared catalog
 * object. The baseline is derived from the source model so repeated toggles or
 * shared registry entries are never cumulatively mutated. The caller applies
 * the returned clone through Pi's public session-only `setModel`.
 */
export function planExpandedContext<T extends ContextWindowModel>(
  tracking: ExpandedContextTracking,
  model: T | undefined,
  target: number = EXPANDED_CONTEXT_WINDOW,
): ExpandedContextPlan<T> {
  if (!model || typeof model.contextWindow !== "number" || !Number.isFinite(model.contextWindow)) {
    return { ok: false, error: "current model has no known context window" };
  }
  const baseline =
    tracking.model === model && tracking.baseline !== undefined ? tracking.baseline : model.contextWindow;
  const contextWindow = Math.max(baseline, target);
  return {
    ok: true,
    source: model,
    model: { ...model, contextWindow } as T,
    contextWindow,
    baseline,
  };
}

/** Record the applied expansion so a later restore can find its baseline. */
export function trackExpandedContext(
  tracking: ExpandedContextTracking,
  source: ContextWindowModel,
  baseline: number,
): void {
  tracking.model = source;
  tracking.baseline = baseline;
}

/** Stop tracking a session-local expansion. */
export function clearExpandedContext(tracking: ExpandedContextTracking): void {
  tracking.model = undefined;
  tracking.baseline = undefined;
}

/**
 * Clone the current session model back to the recorded baseline. Returns the
 * session-local model to apply, or undefined when nothing is tracked or no
 * current model is known. The shared catalog object is never touched.
 */
export function planRestoredContext<T extends ContextWindowModel>(
  tracking: ExpandedContextTracking,
  current: T | undefined,
): T | undefined {
  if (tracking.baseline === undefined || !current) return undefined;
  return { ...current, contextWindow: tracking.baseline } as T;
}
