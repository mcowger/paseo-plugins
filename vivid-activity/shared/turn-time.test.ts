import { describe, expect, it } from "vitest";
import { endedStamp, formatTurnTime, turnTimeDataSchema } from "./turn-time";

describe("formatTurnTime", () => {
  it("always carries the calendar date", () => {
    expect(formatTurnTime(new Date(2026, 9, 15, 14, 5, 9).getTime())).toBe("2026-10-15 14:05:09");
    // 同一天、昨天、更早，格式都一样：回看时不会因为「今天」变了而变。
    expect(formatTurnTime(new Date(2026, 9, 14, 23, 59, 59).getTime())).toBe("2026-10-14 23:59:59");
    expect(formatTurnTime(new Date(2025, 11, 31, 8, 0, 0).getTime())).toBe("2025-12-31 08:00:00");
  });

  it("returns an empty label for unusable timestamps", () => {
    expect(formatTurnTime(0)).toBe("");
    expect(formatTurnTime(Number.NaN)).toBe("");
  });

  it("stamps a finished activity row only when the switch is on", () => {
    const at = new Date(2026, 9, 16, 11, 37, 44);
    expect(endedStamp(at, true, false)).toBe("2026-10-16 11:37:44");
    expect(endedStamp(at.getTime(), true, false)).toBe("2026-10-16 11:37:44");
    // 关掉开关没有标签；运行中的行还没结束，也不打。
    expect(endedStamp(at, false, false)).toBeNull();
    expect(endedStamp(at, true, true)).toBeNull();
    // 时间戳不可用时宁可不显示。
    expect(endedStamp(0, true, false)).toBeNull();
    expect(endedStamp(Number.NaN, true, false)).toBeNull();
  });

  it("accepts the wire payload", () => {
    expect(turnTimeDataSchema.parse({ at: 1, turnId: "t", outcome: "completed" })).toEqual({
      at: 1,
      turnId: "t",
      outcome: "completed",
    });
    expect(turnTimeDataSchema.safeParse({ at: 1, turnId: "t", outcome: "done" }).success).toBe(false);
  });
});
