import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsageReader } from "./usage";

let dir: string;
let originalHome: string | undefined;
beforeEach(async () => {
  originalHome = process.env.CLAUDE_CONFIG_DIR;
  dir = await mkdtemp(join(tmpdir(), "claude-usage-test-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }));
});
afterEach(async () => {
  if (originalHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalHome;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("Claude Enterprise usage", () => {
  it("reports a spend-only account in dollars without inventing quota windows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      five_hour: null, seven_day: null,
      extra_usage: { is_enabled: true, monthly_limit: 150000, used_credits: 433, currency: "USD", decimal_places: 2 },
    }), { status: 200 })));
    const reader = createUsageReader();
    try {
      const { accounts: [account] } = await reader.read(false);
      expect(account.status).toBe("available");
      expect(account.windows).toEqual([]);
      expect(account.balances[0]).toMatchObject({ id: "spend", used: 4.33, limit: 1500, remaining: 1495.67 });
      expect(account.balances[0].usedPct).toBeCloseTo(0.2886666667);
    } finally { reader.dispose(); }
  });

  it("keeps missing spend unknown and retains the last reading after rate limiting", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: null, currency: "USD" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 })));
    const reader = createUsageReader();
    try {
      const first = (await reader.read(false)).accounts[0];
      expect(first.balances[0]).toMatchObject({ limit: 100, used: null, remaining: null, usedPct: null });
      vi.advanceTimersByTime(31_000);
      const next = (await reader.read(true)).accounts[0];
      expect(next).toMatchObject({ status: "error", stale: true, message: "Anthropic rate limited this request. Try again shortly." });
      expect(next.balances).toEqual(first.balances);
    } finally { reader.dispose(); }
  });
});
