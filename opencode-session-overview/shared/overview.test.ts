import { describe, expect, it } from "vitest";
import {
  contextPercent,
  countCompletedTasks,
  extractTasks,
  formatCost,
  formatTokens,
} from "./overview";

describe("OpenCode session overview", () => {
  it("formats token and cost values for compact cards", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_500)).toBe("12.5k");
    expect(formatCost(0.0052)).toBe("$0.0052");
    expect(formatCost(null)).toBe("—");
  });

  it("calculates a bounded context percentage", () => {
    expect(contextPercent({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
      contextWindowMaxTokens: 100,
      contextWindowUsedTokens: 8,
    })).toBe(8);
    expect(contextPercent(null)).toBeNull();
    expect(contextPercent({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
      contextWindowMaxTokens: 100,
      contextWindowUsedTokens: 120,
    })).toBe(100);
  });

  it("uses the latest todo snapshot and preserves stable task IDs", () => {
    const tasks = extractTasks([
      { type: "assistant_message", text: "planning" },
      {
        type: "todo",
        items: [
          { id: "one", text: "Create branch", completed: true },
          { text: "Run checks", completed: false, status: "in_progress" },
        ],
      },
    ]);
    expect(tasks).toEqual([
      { id: "one", text: "Create branch", status: "completed" },
      { id: "Run checks", text: "Run checks", status: "in_progress" },
    ]);
    expect(countCompletedTasks(tasks)).toBe(1);
  });
});
