import { describe, expect, it } from "vitest";
import { formatActivityTime, turnEndSchema } from "./activity-time";

describe("activity timestamps", () => {
  it("formats local time and rejects invalid timestamps", () => {
    expect(formatActivityTime(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02 03:04:05");
    expect(formatActivityTime(new Date(NaN))).toBe("");
    expect(turnEndSchema.safeParse({ at: 0 }).success).toBe(false);
  });
});
