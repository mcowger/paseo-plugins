import type { Account, Balance, Window } from "../shared/usage";
import { ompToken } from "./omp-token";

const endpoint = "https://api.anthropic.com/api/oauth/usage";
interface Credentials { accessToken: string; label: string; plan: string | null }
interface Cached { account: Account; attemptedAt: number }

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function numeric(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function date(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
async function discoverCredentials(): Promise<Credentials> {
  return { accessToken: await ompToken("anthropic"), label: "Claude account", plan: null };
}
function makeWindows(raw: Record<string, unknown>): Window[] {
  const output: Window[] = [];
  for (const [key, label, shortLabel] of [["five_hour", "5-hour session", "Session"], ["seven_day", "7-day", "Week"], ["seven_day_sonnet", "7-day Sonnet", "Sonnet"], ["seven_day_opus", "7-day Opus", "Opus"], ["seven_day_oauth_apps", "7-day OAuth apps", "OAuth apps"]] as const) {
    const item = object(raw[key]);
    const usedPct = numeric(item?.utilization);
    if (!item || usedPct === null) continue;
    output.push({ id: key.replaceAll("_", "-"), label, shortLabel, summary: key === "five_hour" || key === "seven_day", usedPct, resetsAt: date(item.resets_at) });
  }
  return output;
}
function parseUsage(raw: unknown): { balances: Balance[]; windows: Window[]; plan: string | null } {
  const body = object(raw);
  if (!body) throw new Error("Unrecognized usage response");
  const windows = makeWindows(body);
  const extra = object(body.extra_usage);
  const balances: Balance[] = [];
  // These values are minor currency units; decimal_places makes the conversion explicit.
  if (extra && extra.is_enabled !== false && (!text(extra.currency) || text(extra.currency)?.toUpperCase() === "USD")) {
    const decimalPlaces = numeric(extra.decimal_places) ?? 2;
    const scale = 10 ** Math.min(decimalPlaces, 8);
    const limitMinor = numeric(extra.monthly_limit);
    const usedMinor = numeric(extra.used_credits);
    const remainingMinor = numeric(extra.remaining_credits);
    const limit = limitMinor === null ? null : limitMinor / scale;
    const used = usedMinor === null ? null : usedMinor / scale;
    const remaining = remainingMinor === null ? (limit !== null && used !== null ? Math.max(0, limit - used) : null) : remainingMinor / scale;
    const pct = numeric(extra.utilization) ?? (limit !== null && limit > 0 && used !== null ? used / limit * 100 : null);
    if (limit !== null || used !== null || remaining !== null) balances.push({ id: "spend", label: "Extra usage", used, limit, remaining, usedPct: pct, resetsAt: date(extra.resets_at) });
  }
  return { balances, windows, plan: text(body.billing_type) ?? text(body.plan) };
}

export function createUsageReader() {
  const cache = new Map<string, Cached>();
  const pending = new Map<string, Promise<Account>>();
  const controllers = new Set<AbortController>();
  let disposed = false;
  async function fetchAccount(credentials: Credentials, id: string): Promise<Account> {
    const previous = cache.get(id);
    const base: Account = { id, label: credentials.label, plan: credentials.plan, status: "available", message: null, balances: [], windows: [], updatedAt: null, stale: false };
    const controller = new AbortController(); controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let result: Account;
    try {
      const response = await fetch(endpoint, { method: "GET", headers: { Authorization: `Bearer ${credentials.accessToken}`, Accept: "application/json", "anthropic-beta": "oauth-2025-04-20" }, signal: controller.signal, redirect: "error" });
      if (response.status === 401 || response.status === 403) result = { ...base, status: "unavailable", message: "OMP's Anthropic login was rejected. Sign in to Anthropic in OMP, then refresh." };
      else if (!response.ok) result = { ...base, status: "error", message: response.status === 429 ? "Anthropic rate limited this request. Try again shortly." : `Claude usage API returned HTTP ${response.status}.` };
      else {
        const payload: unknown = await response.json();
        const parsed = parseUsage(payload);
        result = { ...base, ...parsed, plan: parsed.plan ?? base.plan, updatedAt: new Date().toISOString() };
      }
    } catch {
      result = { ...base, status: "error", message: controller.signal.aborted ? "Claude usage request timed out." : "Could not fetch Claude usage. Try refreshing shortly." };
    } finally { clearTimeout(timeout); controllers.delete(controller); }
    if (result.status !== "available" && previous?.account.updatedAt) result = { ...previous.account, label: credentials.label, status: result.status, message: result.message, stale: true };
    if (!disposed) cache.set(id, { account: result, attemptedAt: Date.now() });
    return result;
  }
  return {
    async read(refresh: boolean): Promise<{ accounts: Account[] }> {
      if (disposed) throw new Error("Usage plugin stopped.");
      let credentials: Credentials;
      try { credentials = await discoverCredentials(); } catch {
        const old = [...cache.values()].find(({ account }) => account.updatedAt)?.account;
        const message = "Could not obtain the Anthropic credential from OMP. Check OMP sign-in and availability, then refresh.";
        return { accounts: [old ? { ...old, status: "unavailable", message, stale: true } : { id: "claude", label: "Claude account", plan: null, status: "unavailable", message, balances: [], windows: [], updatedAt: null, stale: false }] };
      }
      const id = "claude";
      const running = pending.get(id);
      if (running) return { accounts: [await running] };
      const cached = cache.get(id);
      if (cached && Date.now() - cached.attemptedAt < (refresh ? 30_000 : 120_000)) return { accounts: [cached.account] };
      const task = fetchAccount(credentials, id); pending.set(id, task);
      try { return { accounts: [await task] }; }
      finally { if (pending.get(id) === task) pending.delete(id); }
    },
    dispose() { disposed = true; for (const controller of controllers) controller.abort(); controllers.clear(); cache.clear(); pending.clear(); },
  };
}
