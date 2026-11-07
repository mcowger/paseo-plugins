import { createHash } from "node:crypto";
import type { Account } from "../shared/usage";
import { object, parseCodexUsage, text } from "./codex-parser";
import { ompToken } from "./omp-token";

interface Login {
  id: string;
  label: string;
  token: string;
  accountId: string | null;
}
interface Cached {
  account: Account;
  attemptedAt: number;
}
const endpoint = "https://chatgpt.com/backend-api/wham/usage";
function claims(token: string | null): Record<string, unknown> | null {
  try {
    return object(
      JSON.parse(Buffer.from(token?.split(".")[1] ?? "", "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
}
async function discover(): Promise<Login[]> {
  const token = await ompToken("openai-codex");
  const access = claims(token);
  const accountId = text(object(access?.["https://api.openai.com/auth"])?.chatgpt_account_id);
  const id = createHash("sha256")
    .update(accountId ?? "omp-openai-codex")
    .digest("hex");
  const label =
    text(object(access?.["https://api.openai.com/profile"])?.email) ??
    text(access?.email) ??
    "Codex account";
  return [{ id, label, token, accountId }];
}
export function createCodexUsageReader() {
  const cache = new Map<string, Cached>();
  const pending = new Map<string, Promise<Account>>();
  const controllers = new Set<AbortController>();
  let disposed = false;
  async function fetchAccount(login: Login): Promise<Account> {
    const previous = cache.get(login.id);
    const base: Account = {
      id: login.id,
      label: login.label,
      plan: null,
      status: "available",
      message: null,
      balances: [],
      windows: [],
      updatedAt: null,
      stale: false,
    };
    const attemptedAt = Date.now();
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let result: Account;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${login.token}`,
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      };
      if (login.accountId) headers["ChatGPT-Account-Id"] = login.accountId;
      const response = await fetch(endpoint, {
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403)
        result = {
          ...base,
          status: "unavailable",
          message: "OMP's Codex login was rejected. Sign in to OpenAI Codex in OMP, then refresh.",
        };
      else if (!response.ok)
        result = {
          ...base,
          status: "error",
          message:
            response.status === 429
              ? "Codex rate limited this request. Try again shortly."
              : `Codex usage API returned HTTP ${response.status}.`,
        };
      else {
        const body = await response.text();
        if (body.trim().startsWith("<")) throw new Error("html");
        const parsed = parseCodexUsage(JSON.parse(body));
        result = { ...base, ...parsed, updatedAt: new Date().toISOString() };
      }
    } catch {
      result = {
        ...base,
        status: "error",
        message: controller.signal.aborted
          ? "Codex usage request timed out."
          : "Could not fetch Codex usage. Try refreshing shortly.",
      };
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
    if (result.status !== "available" && previous?.account.updatedAt)
      result = {
        ...previous.account,
        label: login.label,
        status: result.status,
        message: result.message,
        stale: true,
      };
    if (!disposed) cache.set(login.id, { account: result, attemptedAt });
    return result;
  }
  return {
    async read(refresh: boolean): Promise<{ accounts: Account[] }> {
      if (disposed) throw new Error("Usage plugin stopped.");
      let logins: Login[];
      try {
        logins = await discover();
      } catch {
        const old = [...cache.values()].find(({ account }) => account.updatedAt)?.account;
        const message =
          "Could not obtain the Codex credential from OMP. Check OMP sign-in and availability, then refresh.";
        return {
          accounts: [
            old
              ? { ...old, status: "unavailable", message, stale: true }
              : {
                  id: "codex",
                  label: "Codex account",
                  plan: null,
                  status: "unavailable",
                  message,
                  balances: [],
                  windows: [],
                  updatedAt: null,
                  stale: false,
                },
          ],
        };
      }
      if (disposed) throw new Error("Usage plugin stopped.");
      const present = new Set(logins.map((login) => login.id));
      for (const key of cache.keys()) if (!present.has(key)) cache.delete(key);
      const accounts = await Promise.all(
        logins.map(async (login) => {
          const running = pending.get(login.id);
          if (running) return running;
          const cached = cache.get(login.id);
          if (cached && Date.now() - cached.attemptedAt < (refresh ? 10_000 : 60_000))
            return cached.account;
          const task = fetchAccount(login);
          pending.set(login.id, task);
          try {
            return await task;
          } finally {
            if (pending.get(login.id) === task) pending.delete(login.id);
          }
        }),
      );
      return { accounts };
    },
    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      cache.clear();
      pending.clear();
    },
  };
}
