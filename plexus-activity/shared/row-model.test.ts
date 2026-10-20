import { describe, expect, it } from "vitest";
import {
  compareNewestFirst,
  createEmptyRecord,
  isInFlight,
  matchesScope,
  mergeRecord,
  toUsageRow,
} from "./row-model";
import { usageRowSchema } from "./view";

describe("mergeRecord", () => {
  it("applies only defined fields", () => {
    const base = mergeRecord(createEmptyRecord("req-1", 1000), {
      requestId: "req-1",
      apiKey: "team-a",
      responseStatus: "pending",
    });
    const merged = mergeRecord(base, {
      requestId: "req-1",
      incomingModelAlias: "gpt-alias",
      tokensInput: undefined,
    });

    expect(merged.apiKey).toBe("team-a");
    expect(merged.responseStatus).toBe("pending");
    expect(merged.incomingModelAlias).toBe("gpt-alias");
    expect(merged.tokensInput).toBeNull();
  });

  it("treats an explicit null as a value", () => {
    const base = mergeRecord(createEmptyRecord("req-1", 1000), {
      requestId: "req-1",
      serviceTier: "priority",
    });
    const merged = mergeRecord(base, { requestId: "req-1", serviceTier: null });
    expect(merged.serviceTier).toBeNull();
  });

  it("keeps the original start time when a later patch omits it", () => {
    const base = createEmptyRecord("req-1", 1000);
    const merged = mergeRecord(base, { requestId: "req-1", costTotal: 0.5 });
    expect(merged.startTime).toBe(1000);
  });
});

describe("isInFlight", () => {
  it("is true only while Plexus reports pending", () => {
    expect(isInFlight({ ...createEmptyRecord("r", 1), responseStatus: "pending" })).toBe(true);
    expect(isInFlight({ ...createEmptyRecord("r", 1), responseStatus: "success" })).toBe(false);
    expect(isInFlight({ ...createEmptyRecord("r", 1), responseStatus: null })).toBe(false);
  });
});

describe("matchesScope", () => {
  const record = { ...createEmptyRecord("r", 1), apiKey: "team-a" };

  it("matches everything with no scope", () => {
    expect(matchesScope(record, null)).toBe(true);
  });

  it("requires an exact key name", () => {
    expect(matchesScope(record, "team-a")).toBe(true);
    expect(matchesScope(record, "team-a2")).toBe(false);
    expect(matchesScope(record, "team")).toBe(false);
    expect(matchesScope({ ...record, apiKey: null }, "team-a")).toBe(false);
  });
});

describe("compareNewestFirst", () => {
  it("orders by start time descending, then date, then id", () => {
    const rows = [
      { startTime: 1000, requestId: "delta", date: "2026-01-01T00:00:01.000Z" },
      { startTime: 2000, requestId: "alpha", date: "2026-01-01T00:00:02.000Z" },
      { startTime: 1000, requestId: "charlie", date: "2026-01-01T00:00:03.000Z" },
      { startTime: 1000, requestId: "bravo", date: "2026-01-01T00:00:01.000Z" },
    ];
    expect(
      rows
        .slice()
        .sort(compareNewestFirst)
        .map((row) => row.requestId),
    ).toEqual(["alpha", "charlie", "delta", "bravo"]);
  });

  it("is stable when date and start time match", () => {
    const left = { startTime: 1, requestId: "aaa", date: null };
    const right = { startTime: 1, requestId: "bbb", date: null };
    expect(compareNewestFirst(left, right)).toBeGreaterThan(0);
    expect(compareNewestFirst(right, left)).toBeLessThan(0);
  });
});

describe("toUsageRow", () => {
  it("prefers the final attempt model and flattens token buckets", () => {
    const record = mergeRecord(createEmptyRecord("req-1", 1736942400000), {
      requestId: "req-1",
      responseStatus: "success",
      selectedModelName: "gpt-5.4",
      finalAttemptModel: "gpt-5.4-2026-01-01",
      incomingApiType: "chat",
      outgoingApiType: "openai-responses",
      isStreamed: true,
      reasoningEffort: "high",
      requestedServiceTier: "flex",
      serviceTier: "priority",
      tokensInput: 1200,
      tokensCached: 0,
      tokensCacheWrite: 0,
      tokensOutput: 340,
      tokensReasoning: 12,
      tokensEstimated: true,
      costTotal: 0.0042,
      durationMs: 2300,
      ttftMs: 410,
      tokensPerSec: 148.4,
    });

    const row = toUsageRow(record, 7, null);

    expect(usageRowSchema.parse(row)).toEqual(row);
    expect(row.modelSlug).toBe("gpt-5.4-2026-01-01");
    expect(row.tokens).toEqual({
      input: 1200,
      cached: 0,
      cacheWrite: 0,
      output: 340,
      reasoning: 12,
      estimated: true,
    });
    expect(row.serviceTier).toBe("priority");
    expect(row.requestedServiceTier).toBe("flex");
    expect(row.updatedSeq).toBe(7);
  });

  it("falls back to the selected model name", () => {
    const record = mergeRecord(createEmptyRecord("req-1", 1), {
      requestId: "req-1",
      selectedModelName: "claude-sonnet-4",
    });
    expect(toUsageRow(record, 1, null).modelSlug).toBe("claude-sonnet-4");
  });

  it("carries the live estimate but never a key name", () => {
    const record = mergeRecord(createEmptyRecord("req-1", 1), {
      requestId: "req-1",
      apiKey: "team-a",
      responseStatus: "pending",
    });
    const row = toUsageRow(record, 2, 42.5);
    expect(row.liveTokensPerSec).toBe(42.5);
    expect(Object.keys(row)).not.toContain("apiKey");
  });
});
