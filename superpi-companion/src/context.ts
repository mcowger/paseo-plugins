import type { ContextPolicy } from "./context-policy.ts";

export interface ContextWindowModel {
  provider?: string;
  id: string;
  contextWindow: number;
}

/**
 * Per-session tracking for an applied expanded-context clone. `model` is the
 * catalog source the baseline belongs to, never the session-local clone, so a
 * later model switch records a fresh baseline instead of reusing a stale one.
 */
export interface ContextTracking {
  model: ContextWindowModel | undefined;
  baseline: number | undefined;
}

export function planContextBudget<T extends ContextWindowModel>(
  tracking: ContextTracking,
  model: T | undefined,
  policy: ContextPolicy | undefined,
  enabled: boolean,
): { model: T; baseline: number; available: boolean } | undefined {
  if (!model || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) return undefined;
  const same = tracking.model?.provider === model.provider && tracking.model?.id === model.id;
  const baseline = same && tracking.baseline !== undefined ? tracking.baseline : model.contextWindow;
  const available = policy !== undefined && policy.shortContextBudgetTokens < policy.maxContextTokens;
  const contextWindow = available ? enabled ? policy.maxContextTokens : policy.shortContextBudgetTokens : baseline;
  return { model: { ...model, contextWindow }, baseline, available };
}
