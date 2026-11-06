// Adapted from getpaseo/paseo PR #4507 (92ea169d), Apache-2.0.
// Modified: shared sidebar DTOs, isolated optional sections, null-safe numbers and dates.
import { windowFromReportedDuration } from "@getpaseo/plugin/server/usage";
import type { Balance, Window } from "../shared/usage";

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function number(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function nonnegative(value: unknown): number | null {
  const result = number(value);
  return result !== null && result >= 0 ? result : null;
}
function timestamp(value: unknown): string | null {
  const epoch = nonnegative(value);
  if (epoch === null) return null;
  const date = new Date(epoch * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function windows(value: unknown, scope?: { id: string; label: string }): Window[] {
  const rate = object(value);
  if (!rate) return [];
  return (["primary_window", "secondary_window"] as const).flatMap((slot) => {
    const window = object(rate[slot]);
    if (!window) return [];
    const usedPct = nonnegative(window.used_percent);
    if (usedPct === null) return [];
    const primary = slot === "primary_window";
    const normalized = windowFromReportedDuration({
      durationSeconds: nonnegative(window.limit_window_seconds),
      unknown: { id: primary ? "unknown_primary" : "unknown_secondary", label: primary ? "Primary limit" : "Secondary limit", shortLabel: "" },
      scope, summary: !scope, utilizationPct: usedPct, resetsAt: timestamp(window.reset_at),
    });
    return [{ id: normalized.id, label: normalized.label, shortLabel: normalized.shortLabel ?? "", summary: !scope, usedPct, resetsAt: normalized.resetsAt ?? null }];
  });
}
export function parseCodexUsage(raw: unknown): { plan: string | null; balances: Balance[]; windows: Window[] } {
  const usage = object(raw);
  if (!usage || !["plan_type", "rate_limit", "additional_rate_limits", "spend_control", "credits", "code_review_rate_limit"].some((key) => key in usage)) {
    throw new Error("Codex returned an unrecognized usage response.");
  }
  const balances: Balance[] = [];
  const spend = object(object(usage.spend_control)?.individual_limit);
  const limit = nonnegative(spend?.limit);
  if (spend && limit !== null) {
    const used = nonnegative(spend.used);
    const remaining = nonnegative(spend.remaining);
    const effectiveUsed = used ?? (remaining !== null ? Math.max(0, limit - remaining) : null);
    const computedPct = limit > 0 && effectiveUsed !== null ? effectiveUsed / limit * 100 : null;
    const reportedUnit = text(spend.unit)?.toLowerCase();
    const unit = reportedUnit === "usd" || reportedUnit === "credits" ? reportedUnit : undefined;
    balances.push({ id: "spend", label: unit === "usd" ? "Monthly spend" : unit === "credits" ? "Monthly credits" : "Monthly allowance", limit, used: effectiveUsed,
      remaining: remaining ?? (used !== null ? Math.max(0, limit - used) : null),
      usedPct: nonnegative(spend.used_percent) ?? (computedPct !== null && Number.isFinite(computedPct) ? computedPct : null),
      resetsAt: timestamp(spend.reset_at), unit });
  } else {
    const remaining = nonnegative(object(usage.credits)?.balance);
    if (remaining !== null) balances.push({ id: "credits", label: "Credits", remaining, limit: null, used: null, usedPct: null, resetsAt: null, unit: "credits" });
  }
  const result = windows(usage.rate_limit);
  const occurrences = new Map<string, number>();
  if (Array.isArray(usage.additional_rate_limits)) {
    for (const value of usage.additional_rate_limits) {
      const feature = object(value);
      if (!feature) continue;
      const identity = text(feature.metered_feature) ?? text(feature.limit_name);
      if (!identity) continue;
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      result.push(...windows(feature.rate_limit, { id: `feature:${encodeURIComponent(identity)}${occurrence > 1 ? `:${occurrence}` : ""}`, label: text(feature.limit_name) ?? identity }));
    }
  }
  result.push(...windows(usage.code_review_rate_limit, { id: "code_review", label: "Code review" }));
  return { plan: text(usage.plan_type), balances, windows: result };
}
