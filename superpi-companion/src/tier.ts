import type { Tier } from "./protocol.ts";

export type ActiveTier = Exclude<Tier, "default">;

export interface TierDialect {
  readonly id: string;
  readonly apis: readonly string[];
  readonly tiers: readonly ActiveTier[];
  inject(payload: Record<string, unknown>, tier: ActiveTier): Record<string, unknown>;
}

// Fast maps to OpenAI's priority tier; superpi tier names stay user-facing.
const OPENAI_RESPONSES: TierDialect = {
  id: "openai-responses",
  apis: ["openai-responses", "openai-codex-responses", "azure-openai-responses"],
  tiers: ["fast", "flex", "ultrafast"],
  inject(payload, tier) {
    return { ...payload, service_tier: tier === "fast" ? "priority" : tier };
  },
};

const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01";
const ANTHROPIC_MESSAGES: TierDialect = {
  id: "anthropic-messages",
  apis: ["anthropic-messages"],
  tiers: ["fast"],
  inject(payload, _tier) {
    const existing = Array.isArray(payload.betas)
      ? payload.betas.filter((beta): beta is string => typeof beta === "string")
      : [];
    const betas = existing.includes(ANTHROPIC_FAST_MODE_BETA) ? existing : [...existing, ANTHROPIC_FAST_MODE_BETA];
    return { ...payload, speed: "fast", betas };
  },
};

export const TIER_DIALECTS: readonly TierDialect[] = [OPENAI_RESPONSES, ANTHROPIC_MESSAGES];

export interface TierModel {
  api?: string;
  id?: string;
}

export function dialectForApi(api: string | undefined): TierDialect | undefined {
  if (!api) return undefined;
  return TIER_DIALECTS.find((dialect) => dialect.apis.includes(api));
}

/** Whether the companion can inject this tier for the model's API dialect. */
export function isTierApplicable(model: TierModel | undefined, tier: Tier): boolean {
  if (tier === "default") return true;
  const dialect = dialectForApi(model?.api);
  return dialect !== undefined && dialect.tiers.includes(tier);
}

/**
 * Return a payload copy with the tier applied, or `undefined` to leave the
 * request untouched. Unknown dialects and unsupported tiers are not injected;
 * the backend never sees a guessed value.
 */
export function applyTierToPayload(payload: unknown, model: TierModel | undefined, tier: Tier): unknown {
  if (tier === "default") return undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const dialect = dialectForApi(model?.api);
  if (!dialect || !dialect.tiers.includes(tier)) return undefined;
  return dialect.inject(payload as Record<string, unknown>, tier);
}
