import { describe, expect, it } from "vitest";
import {
  computeEndToEndTps,
  computeLiveDurationMs,
  formatCost,
  formatCount,
  formatEstimatedTps,
  formatMs,
  formatReasoningEffort,
  formatServiceTier,
  formatTokens,
  formatTps,
} from "./format";

describe("formatCount", () => {
  it("keeps values under 1000 unchanged", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1)).toBe("1");
    expect(formatCount(340)).toBe("340");
    expect(formatCount(999)).toBe("999");
  });

  it("humanizes thousands and millions with at most one decimal", () => {
    expect(formatCount(1000)).toBe("1k");
    expect(formatCount(1300)).toBe("1.3k");
    expect(formatCount(1234567)).toBe("1.2M");
    expect(formatCount(2_500_000_000)).toBe("2.5G");
  });

  it("promotes the unit when rounding crosses a boundary", () => {
    expect(formatCount(999_950)).toBe("1M");
    expect(formatCount(999_960)).toBe("1M");
  });

  it("keeps the sign", () => {
    expect(formatCount(-1300)).toBe("-1.3k");
  });

  it("rejects non-finite input", () => {
    expect(formatCount(Number.NaN)).toBe("-");
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("-");
  });
});

describe("formatTokens", () => {
  it("renders 0 and missing values as a dash", () => {
    expect(formatTokens(0)).toBe("-");
    expect(formatTokens(null)).toBe("-");
    expect(formatTokens(undefined)).toBe("-");
  });

  it("humanizes counts", () => {
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(42)).toBe("42");
  });
});

describe("formatCost", () => {
  it("renders six decimal places", () => {
    expect(formatCost(0.0042)).toBe("$0.004200");
    expect(formatCost(1.5)).toBe("$1.500000");
  });

  it("marks values below the display threshold", () => {
    expect(formatCost(0.0000005)).toBe("$<0.000001");
    expect(formatCost(0.000001)).toBe("$0.000001");
  });

  it("renders zero and missing values as a dash", () => {
    expect(formatCost(0)).toBe("-");
    expect(formatCost(null)).toBe("-");
    expect(formatCost(undefined)).toBe("-");
  });

  it("groups thousands", () => {
    expect(formatCost(1234.5)).toBe("$1,234.500000");
    expect(formatCost(1234567.25)).toBe("$1,234,567.250000");
  });

  it("keeps negative costs readable", () => {
    expect(formatCost(-0.5)).toBe("$-0.500000");
  });
});

describe("formatMs", () => {
  it("matches Plexus duration rendering", () => {
    expect(formatMs(0)).toBe("∅");
    expect(formatMs(410)).toBe("410ms");
    expect(formatMs(999.6)).toBe("1000ms");
    expect(formatMs(2300)).toBe("2.3s");
  });

  it("renders a dash when the duration is unknown", () => {
    expect(formatMs(null)).toBe("-");
    expect(formatMs(undefined)).toBe("-");
  });
});

describe("formatTps", () => {
  it("uses one decimal place and rejects non-positive values", () => {
    expect(formatTps(148.44)).toBe("148.4");
    expect(formatTps(0)).toBe("-");
    expect(formatTps(null)).toBe("-");
  });
});

describe("formatEstimatedTps", () => {
  it("always marks an estimate", () => {
    expect(formatEstimatedTps(12.34)).toBe("~12.3 t/s");
    expect(formatEstimatedTps(0)).toBeNull();
    expect(formatEstimatedTps(null)).toBeNull();
  });
});

describe("formatReasoningEffort", () => {
  it("capitalizes the stored value", () => {
    expect(formatReasoningEffort("high")).toBe("High");
    expect(formatReasoningEffort("off")).toBe("Off");
    expect(formatReasoningEffort(null)).toBeNull();
    expect(formatReasoningEffort("")).toBeNull();
  });
});

describe("formatServiceTier", () => {
  it("prefers the provider-reported tier", () => {
    expect(formatServiceTier("priority", "flex")).toBe("Flex→Priority");
    expect(formatServiceTier("priority", "priority")).toBe("Priority");
    expect(formatServiceTier("priority", null)).toBe("Priority");
    expect(formatServiceTier(null, "flex")).toBe("Flex");
  });

  it("returns null when no tier was requested or reported", () => {
    expect(formatServiceTier(null, null)).toBeNull();
    expect(formatServiceTier("  ", "")).toBeNull();
  });

  it("passes through unknown tier spellings", () => {
    expect(formatServiceTier("batch-ish", null)).toBe("Batch-ish");
  });
});

describe("computeEndToEndTps", () => {
  it("includes reasoning tokens and excludes idle time only via duration", () => {
    expect(computeEndToEndTps(340, 60, 2000)).toBe(200);
    expect(computeEndToEndTps(0, 0, 2000)).toBeNull();
    expect(computeEndToEndTps(10, 0, 0)).toBeNull();
    expect(computeEndToEndTps(null, null, null)).toBeNull();
  });
});

describe("computeLiveDurationMs", () => {
  it("clamps clock skew to zero", () => {
    expect(computeLiveDurationMs(1000, 3500)).toBe(2500);
    expect(computeLiveDurationMs(5000, 3500)).toBe(0);
    expect(computeLiveDurationMs(null, 3500)).toBeNull();
  });
});
