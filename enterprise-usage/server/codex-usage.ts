import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Account } from "../shared/usage";
import { object, parseCodexUsage, text } from "./codex-parser";

interface Login { id: string; label: string; token: string; accountId: string | null }
interface Cached { account: Account; attemptedAt: number }
const endpoint = "https://chatgpt.com/backend-api/wham/usage";
function claims(token: string | null): Record<string, unknown> | null {
  try { return object(JSON.parse(Buffer.from(token?.split(".")[1] ?? "", "base64url").toString("utf8"))); }
  catch { return null; }
}
async function discover(): Promise<Login[]> {
  const configured = process.env.CODEX_HOME?.trim();
  const homes = [...new Set([...(configured ? [resolve(configured)] : []), join(homedir(), ".codex")])];
  const found = new Map<string, Login>();
  for (const home of homes) {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(home, "auth.json"), "utf8")); }
    catch (error) {
      const code = object(error)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw new Error("Could not read the Codex login store on this host.");
    }
    const tokens = object(object(raw)?.tokens);
    const token = text(tokens?.access_token);
    if (!token) continue;
    const access = claims(token);
    const idToken = claims(text(tokens?.id_token));
    const accountId = text(tokens?.account_id) ?? text(object(access?.["https://api.openai.com/auth"])?.chatgpt_account_id)
      ?? text(object(idToken?.["https://api.openai.com/auth"])?.chatgpt_account_id);
    const id = createHash("sha256").update(accountId ?? home).digest("hex");
    const label = text(object(access?.["https://api.openai.com/profile"])?.email) ?? text(access?.email)
      ?? text(object(idToken?.["https://api.openai.com/profile"])?.email) ?? text(idToken?.email) ?? "Codex account";
    if (!found.has(id)) found.set(id, { id, label, token, accountId });
  }
  return [...found.values()];
}
export function createCodexUsageReader() {
  const cache = new Map<string, Cached>();
  const pending = new Map<string, Promise<Account>>();
  const controllers = new Set<AbortController>();
  let disposed = false;
  async function fetchAccount(login: Login): Promise<Account> {
    const previous = cache.get(login.id);
    const base: Account = { id: login.id, label: login.label, plan: null, status: "available", message: null, balances: [], windows: [], updatedAt: null, stale: false };
    const attemptedAt = Date.now();
    const controller = new AbortController(); controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let result: Account;
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${login.token}`, Accept: "application/json", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };
      if (login.accountId) headers["ChatGPT-Account-Id"] = login.accountId;
      const response = await fetch(endpoint, { headers, signal: controller.signal, redirect: "error" });
      if (response.status === 401 || response.status === 403) result = { ...base, status: "unavailable", message: "Codex login was rejected. Sign in with Codex on this host, then refresh." };
      else if (!response.ok) result = { ...base, status: "error", message: response.status === 429 ? "Codex rate limited this request. Try again shortly." : `Codex usage API returned HTTP ${response.status}.` };
      else {
        const body = await response.text();
        if (body.trim().startsWith("<")) throw new Error("html");
        const parsed = parseCodexUsage(JSON.parse(body));
        result = { ...base, ...parsed, updatedAt: new Date().toISOString() };
      }
    } catch {
      result = { ...base, status: "error", message: controller.signal.aborted ? "Codex usage request timed out." : "Could not fetch Codex usage. Try refreshing shortly." };
    } finally { clearTimeout(timeout); controllers.delete(controller); }
    if (result.status !== "available" && previous?.account.updatedAt) result = { ...previous.account, label: login.label, status: result.status, message: result.message, stale: true };
    if (!disposed) cache.set(login.id, { account: result, attemptedAt });
    return result;
  }
  return {
    async read(refresh: boolean): Promise<{ accounts: Account[] }> {
      if (disposed) throw new Error("Usage plugin stopped.");
      const logins = await discover();
      if (disposed) throw new Error("Usage plugin stopped.");
      const present = new Set(logins.map((login) => login.id));
      for (const key of cache.keys()) if (!present.has(key)) cache.delete(key);
      const accounts = await Promise.all(logins.map(async (login) => {
        const running = pending.get(login.id);
        if (running) return running;
        const cached = cache.get(login.id);
        if (cached && Date.now() - cached.attemptedAt < (refresh ? 10_000 : 60_000)) return cached.account;
        const task = fetchAccount(login); pending.set(login.id, task);
        try { return await task; }
        finally { if (pending.get(login.id) === task) pending.delete(login.id); }
      }));
      return { accounts };
    },
    dispose() { disposed = true; for (const controller of controllers) controller.abort(); controllers.clear(); cache.clear(); pending.clear(); },
  };
}
