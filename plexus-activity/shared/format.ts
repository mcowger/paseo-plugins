/**
 * Display formatting for Plexus usage rows.
 *
 * Ported from the Plexus admin dashboard (`packages/frontend/src/lib/format.ts`) so the panel shows
 * the same numbers as the Logs page: humanized counts, six-decimal USD costs, and `∅`/`ms`/`s`
 * durations. `Intl` is deliberately avoided — Hermes exposes a partial implementation and the output
 * would differ between iOS and web for the same row.
 */

const SI_UNITS = ["", "k", "M", "G", "T", "P", "E"] as const;

/** Rounds at the displayed precision, then promotes the unit if rounding crossed a boundary. */
export function formatCount(value: number, maxDecimals = 1): string {
  if (!Number.isFinite(value)) return "-";
  if (value === 0) return "0";

  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  const power = 10 ** maxDecimals;
  const scaleAt = (index: number): number => Math.round((absolute * power) / 1000 ** index) / power;

  let index = 0;
  while (index < SI_UNITS.length - 1 && absolute >= 1000 ** (index + 1)) index += 1;

  let scaled = scaleAt(index);
  while (scaled >= 1000 && index < SI_UNITS.length - 1) {
    index += 1;
    scaled = scaleAt(index);
  }

  return `${sign}${scaled}${SI_UNITS[index] ?? ""}`;
}

/** Token counts render `-` for both `0` and "not reported", matching the Plexus token cell. */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return "-";
  return formatCount(value);
}

function groupThousands(integer: string): string {
  let grouped = "";
  for (let index = 0; index < integer.length; index += 1) {
    const fromEnd = integer.length - index;
    grouped += integer[index];
    if (fromEnd > 1 && fromEnd % 3 === 1) grouped += ",";
  }
  return grouped;
}

const COST_DECIMALS = 6;
const COST_SYMBOL = "$";

/**
 * USD cost with six fraction digits. Non-zero values below `10^-6` render `$<0.000001` so a tiny
 * cost never looks like zero. Exactly `0` renders `-`, matching Plexus's cost cell.
 */
export function formatCost(value: number | null | undefined, decimals = COST_DECIMALS): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  if (value === 0) return "-";

  const threshold = 10 ** -decimals;
  if (value < 0) return `${COST_SYMBOL}-${formatCost(-value, decimals).slice(1)}`;
  if (value < threshold) return `${COST_SYMBOL}<${threshold.toFixed(decimals)}`;

  const fixed = value.toFixed(decimals);
  const [integer = "0", fraction = ""] = fixed.split(".");
  return `${COST_SYMBOL}${groupThousands(integer)}${fraction ? `.${fraction}` : ""}`;
}

/** `pending` is Plexus's in-flight status; only these rows tick a live duration. */
export function isPendingStatus(status: string | null | undefined): boolean {
  return status === "pending";
}

/** `0` is a real measured zero (rendered `∅`); a missing duration is `-`. */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms === 0) return "∅";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTps(tps: number | null | undefined): string {
  if (tps === null || tps === undefined || !Number.isFinite(tps) || tps <= 0) return "-";
  return tps.toFixed(1);
}

/** Live in-flight estimate; always prefixed `~` because it is derived from stream byte volume. */
export function formatEstimatedTps(tps: number | null | undefined): string | null {
  if (tps === null || tps === undefined || !Number.isFinite(tps) || tps <= 0) return null;
  return `~${tps.toFixed(1)} t/s`;
}

export function formatReasoningEffort(effort: string | null | undefined): string | null {
  if (!effort) return null;
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

const TIER_LABELS: Readonly<Record<string, string>> = {
  flex: "Flex",
  priority: "Priority",
  ultrafast: "Ultrafast",
  default: "Default",
  auto: "Auto",
  scale: "Scale",
  reserved: "Reserved",
  performance: "Performance",
  deferred: "Deferred",
};

function formatTier(value: string): string {
  return TIER_LABELS[value.toLowerCase()] ?? value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Service tier label. Reported tiers win over requested ones; when both exist and differ the
 * request is shown as `requested→reported` so a downgrade is visible without a detail view.
 */
export function formatServiceTier(
  reported: string | null | undefined,
  requested: string | null | undefined,
): string | null {
  const actual = reported?.trim() ? reported : null;
  const ask = requested?.trim() ? requested : null;
  if (!actual && !ask) return null;
  if (actual && ask && actual.toLowerCase() !== ask.toLowerCase()) {
    return `${formatTier(ask)}→${formatTier(actual)}`;
  }
  return formatTier(actual ?? ask ?? "");
}

/** End-to-end throughput: output plus reasoning tokens over the full request duration. */
export function computeEndToEndTps(
  outputTokens: number | null | undefined,
  reasoningTokens: number | null | undefined,
  durationMs: number | null | undefined,
): number | null {
  const tokens = (outputTokens ?? 0) + (reasoningTokens ?? 0);
  if (tokens <= 0 || durationMs === null || durationMs === undefined || durationMs <= 0)
    return null;
  return tokens / (durationMs / 1000);
}

/**
 * Live duration for a request that has not reported one yet. `nowMs` is already corrected for
 * client/server clock skew by the caller.
 */
export function computeLiveDurationMs(
  startTime: number | null | undefined,
  nowMs: number,
): number | null {
  if (startTime === null || startTime === undefined || !Number.isFinite(startTime)) return null;
  return Math.max(0, nowMs - startTime);
}
