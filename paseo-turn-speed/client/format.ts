/** Pure display formatting, shared by the pill and the popover. */

/** 139, 12.4, 1.87 — always 3 significant characters worth of precision. */
export function fmtRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return "—";
  if (rate >= 100) return String(Math.round(rate));
  if (rate >= 10) return rate.toFixed(1);
  return rate.toFixed(2);
}

/** 823 / 1.2k / 12.4k / 128k, or plain grouped digits. */
export function fmtTokens(n: number, format: "compact" | "plain" = "compact"): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (format === "plain") return fmtGrouped(Math.round(n));
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 100_000) return `${Math.round(n / 1000)}k`;
  return `${Math.round(n / 1000)}k`;
}

function fmtGrouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
}

/** 0..1 ratio -> 0% / 3.4% / 86% / 100%. Never rounds up to 100% unless
 * the rate is genuinely that high: a 99.86% hit rate reads 99.9%. */
export function fmtPercent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio) || ratio < 0) return "—";
  const pct = ratio * 100;
  if (pct >= 99.95) return "100%";
  if (pct >= 99) return `${pct.toFixed(1)}%`;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct < 0.05) return "0%";
  return `${pct.toFixed(1)}%`;
}

/** 640ms / 12.3s / 2m05s */
export function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/** Prefix an estimated number. */
export function approx(value: string, isApprox: boolean): string {
  return isApprox ? `\u2248${value}` : value;
}

export function fmtTokPerSec(rate: number | null, isApprox: boolean): string {
  const text = fmtRate(rate);
  return text === "—" ? text : `${approx("", isApprox)}${text} tok/s`;
}
