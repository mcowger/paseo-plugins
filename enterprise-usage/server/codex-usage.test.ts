import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexUsageReader } from "./codex-usage";
import { parseCodexUsage } from "./codex-parser";
import { ompToken } from "./omp-token";

vi.mock("./omp-token", () => ({ ompToken: vi.fn() }));
beforeEach(() => {
  const payload = Buffer.from(JSON.stringify({ email: "enterprise@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })).toString("base64url");
  vi.mocked(ompToken).mockResolvedValue(`header.${payload}.sig`);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("Codex Enterprise usage", () => {
  it("reports spend-only data as available without inventing usage windows", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      plan_type: "enterprise", spend_control: { individual_limit: { limit: 100, used: 23.5, remaining: 76.5, reset_at: 1_800_000_000 } },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const reader = createCodexUsageReader();
    try {
      const { accounts: [account] } = await reader.read(false);
      expect(account).toMatchObject({ label: "enterprise@example.com", plan: "enterprise", status: "available", windows: [] });
      expect(account.balances[0]).toMatchObject({ id: "spend", used: 23.5, limit: 100, remaining: 76.5, usedPct: 23.5 });
      expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "ChatGPT-Account-Id": "account-1" });
    } finally { reader.dispose(); }
  });

  it("preserves feature windows and does not treat missing utilization as zero", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 1_800_000_000 }, secondary_window: { limit_window_seconds: 604800 } },
      additional_rate_limits: [{ metered_feature: "image_gen", limit_name: "Image generation", rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 3600 } } }],
    }), { status: 200 })));
    const reader = createCodexUsageReader();
    try {
      const { accounts: [account] } = await reader.read(false);
      expect(account.status).toBe("available");
      expect(account.windows).toHaveLength(2);
      expect(account.windows.map(({ usedPct }) => usedPct)).toEqual([42, 7]);
      expect(account.windows[1]).toMatchObject({ label: expect.stringContaining("Image generation"), summary: false });
    } finally { reader.dispose(); }
  });

  it("retains spend readings as stale on API errors", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ spend_control: { individual_limit: { limit: 50, used: 12 } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 })));
    const reader = createCodexUsageReader();
    try {
      const first = (await reader.read(false)).accounts[0];
      vi.advanceTimersByTime(11_000);
      const next = (await reader.read(true)).accounts[0];
      expect(next).toMatchObject({ status: "error", stale: true, message: "Codex rate limited this request. Try again shortly." });
      expect(next.balances).toEqual(first.balances);
    } finally { reader.dispose(); }
  });
  it("preserves the last reading when OMP credential retrieval fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ spend_control: { individual_limit: { limit: 50, used: 12 } } }), { status: 200 })));
    const reader = createCodexUsageReader();
    try {
      const first = (await reader.read(false)).accounts[0];
      vi.mocked(ompToken).mockRejectedValueOnce(new Error("unavailable"));
      const next = (await reader.read(true)).accounts[0];
      expect(next).toMatchObject({ status: "unavailable", stale: true, balances: first.balances });
    } finally { reader.dispose(); }
  });
});

describe("Codex balance units", () => {
  it("preserves recognized units without guessing unreported units", () => {
    const usd = parseCodexUsage({ spend_control: { individual_limit: { limit: 100, used: 25, unit: "usd" } } });
    expect(usd.balances[0].unit).toBe("usd");
    const credits = parseCodexUsage({ spend_control: { individual_limit: { limit: 100, used: 25, unit: "credits" } } });
    expect(credits.balances[0].unit).toBe("credits");
    const unspecified = parseCodexUsage({ spend_control: { individual_limit: { limit: 100, used: 25 } } });
    expect(unspecified.balances[0].unit).toBeUndefined();
    const unknown = parseCodexUsage({ spend_control: { individual_limit: { limit: 100, used: 25, unit: "tokens" } } });
    expect(unknown.balances[0].unit).toBeUndefined();
  });
});
