import { describe, expect, it } from "vitest";
import { densityMetrics, STREAM_ROW_GAP } from "./density";

describe("row density", () => {
  const gap = (metrics: ReturnType<typeof densityMetrics>) => STREAM_ROW_GAP + metrics.marginTop + metrics.marginBottom;

  it("leaves 4px between rows in 紧凑 and keeps the 0.3.0-local.1 spacing in 标准", () => {
    expect(gap(densityMetrics("compact", false))).toBe(4);
    expect(gap(densityMetrics("standard", false))).toBe(10);
    expect(densityMetrics("standard", true)).toMatchObject({ rowMinHeight: 32, rowPaddingVertical: 3, tile: 20, marginTop: -3, marginBottom: -3 });
    expect(densityMetrics("standard", false).rowMinHeight).toBe(30);
  });

  it("makes compact rows shorter: phone 42 → 34px per row, desktop 40 → 28px", () => {
    const pitch = (density: "compact" | "standard", phone: boolean) => densityMetrics(density, phone).rowMinHeight + gap(densityMetrics(density, phone));
    expect(pitch("standard", true)).toBe(42);
    expect(pitch("compact", true)).toBe(34);
    expect(pitch("standard", false)).toBe(40);
    expect(pitch("compact", false)).toBe(28);
  });

  it("gives the native live tail the same visual gap as any other row", () => {
    for (const density of ["compact", "standard"] as const) {
      const metrics = densityMetrics(density, true);
      // The tail gets no host gap; its own top margin plus the previous row's bottom margin is the gap.
      expect(metrics.tailMarginTop + metrics.marginBottom).toBe(gap(metrics));
    }
  });

  it("keeps the last row clear of the turn footer (13px below it) and pulls into the neighbours only by empty edge", () => {
    for (const density of ["compact", "standard"] as const) {
      const metrics = densityMetrics(density, true);
      expect(13 + metrics.marginBottom).toBeGreaterThanOrEqual(7);
      // The tile is centred: what a clipping native cell could cut stays inside the row's empty edge.
      expect(-metrics.marginTop).toBeLessThanOrEqual((metrics.rowMinHeight - metrics.tile) / 2);
    }
    // A native tablet (wide layout, native list) keeps the taller compact row too.
    expect(densityMetrics("compact", false, true).rowMinHeight).toBe(30);
    expect(densityMetrics("compact", false, false).rowMinHeight).toBe(24);
  });

  it("returns stable objects so memoised styles survive re-renders", () => {
    expect(densityMetrics("compact", true)).toBe(densityMetrics("compact", true));
  });
});
