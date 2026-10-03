import type { Tier } from "./protocol.ts";
import type { ServiceTierPolicy } from "./service-tiers.ts";

export interface TierModel {
  api?: string;
  id?: string;
  provider?: string;
}

export function resolveSavedTier(tier: string, choices: readonly string[]): string {
  if (choices.includes(tier)) return tier;
  const migrated = tier === "fast" ? "priority" : tier === "default" ? "auto" : tier;
  if (choices.includes(migrated)) return migrated;
  return choices.includes("auto") ? "auto" : choices.includes("standard") ? "standard" : "default";
}

export function isTierApplicable(model: TierModel | undefined, tier: Tier, policy: ServiceTierPolicy | undefined): boolean {
  return model?.provider === "plexus" && policy?.provider === model.provider && policy.modelId === model.id && policy.serviceTiers.includes(tier);
}

export function applyTierToPayload(payload: unknown, model: TierModel | undefined, tier: Tier, policy: ServiceTierPolicy | undefined): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (!isTierApplicable(model, tier, policy)) return undefined;
  return { ...payload, service_tier: tier };
}
