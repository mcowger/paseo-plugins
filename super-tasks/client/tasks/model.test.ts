import { describe, expect, test } from "vitest";
import { formatTaskSidebarLabel, type AgentTaskCounts } from "./model";

const counts: AgentTaskCounts = {
  total: 1,
  pending: 0,
  inProgress: 1,
  completed: 0,
};

describe("formatTaskSidebarLabel", () => {
  test("shows progress and a brief of the active task", () => {
    expect(formatTaskSidebarLabel(counts, "Review pi-control guidance and config")).toBe(
      "0/1 · Review pi-control guida…",
    );
  });

  test("shows progress without a task brief when no task is active", () => {
    expect(formatTaskSidebarLabel(counts, null)).toBe("0/1 done");
  });

  test("falls back to the plugin title when there are no tasks", () => {
    expect(formatTaskSidebarLabel({ ...counts, total: 0 }, null)).toBe("Super Tasks");
  });
});
