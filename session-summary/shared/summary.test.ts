import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import {
  cacheHitRate,
  elapsedDuration,
  formatDuration,
  formatPercent,
  formatThinkingText,
  formatTokenCount,
  lastTurnDuration,
  reduceTimeline,
  tasksFromTimelineItem,
  usageDelta,
  usageForTurn,
} from "./summary";

describe("session summary timeline reduction", () => {
  it("summarizes the initial prompt, deduplicated tool calls, reasoning, and final outcome", () => {
    const summary = reduceTimeline([
      { type: "user_message", text: "Implement the session summary panel" },
      { type: "reasoning", text: "# Inspect APIs\nI will inspect the plugin SDK first." },
      {
        type: "tool_call",
        callId: "read-1",
        name: "read",
        status: "running",
        error: null,
        detail: { type: "read", filePath: "AGENTS.md" },
      },
      {
        type: "tool_call",
        callId: "read-1",
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "AGENTS.md", content: "guidance" },
      },
      {
        type: "tool_call",
        callId: "bash-1",
        name: "bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm test" },
      },
      { type: "assistant_message", text: "I added the dashboard and tests." },
    ] satisfies AgentTimelineItem[]);

    expect(summary.initialPrompt).toBe("Implement the session summary panel");
    expect(summary.totalToolCalls).toBe(2);
    expect(summary.tools).toEqual([
      { name: "bash", count: 1 },
      { name: "read", count: 1 },
    ]);
    expect(summary.recentToolCalls).toEqual([
      { id: "bash-1", name: "bash", summary: "npm test", status: "completed" },
      { id: "read-1", name: "read", summary: "AGENTS.md", status: "completed" },
    ]);
    expect(summary.thoughts).toEqual([
      { id: "thought:0", title: "Inspect APIs", text: "# Inspect APIs\nI will inspect the plugin SDK first." },
    ]);
    expect(summary.outcome).toBe("I added the dashboard and tests.");
  });

  it("uses the latest native Todo snapshot for task status", () => {
    const summary = reduceTimeline([
      {
        type: "todo",
        items: [
          { id: "setup", text: "Create plugin", completed: false, status: "in_progress" },
          { id: "verify", text: "Run checks", completed: false },
        ],
      },
      {
        type: "todo",
        items: [
          { id: "setup", text: "Create plugin", completed: true, status: "completed" },
          { id: "verify", text: "Run checks", completed: false, status: "in_progress" },
        ],
      },
    ] satisfies AgentTimelineItem[]);

    expect(summary.tasks).toEqual([
      { id: "todo:setup", text: "Create plugin", status: "completed" },
      { id: "todo:verify", text: "Run checks", status: "in_progress" },
    ]);
    expect(summary.completedTaskCount).toBe(1);
  });

  it("parses Pi and RPiv Todo payloads plus markdown plan checklists", () => {
    const piTasks = tasksFromTimelineItem({
      type: "tool_call",
      callId: "todo-1",
      name: "todo",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: {},
        output: { details: { todos: [{ id: 1, text: "Inspect source", done: true }] } },
      },
    } satisfies AgentTimelineItem);
    const planTasks = tasksFromTimelineItem({
      type: "tool_call",
      callId: "plan-1",
      name: "plan",
      status: "completed",
      error: null,
      detail: { type: "plan", text: "- [x] Design reducer\n- [ ] Build panel" },
    } satisfies AgentTimelineItem);
    const rpivTasks = tasksFromTimelineItem({
      type: "tool_call",
      callId: "todo-2",
      name: "todowrite",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: {},
        output: { details: { tasks: [{ id: "verify", subject: "Verify checks", status: "in_progress" }] } },
      },
    } satisfies AgentTimelineItem);

    expect(piTasks).toEqual([{ id: "tool-todo:1", text: "Inspect source", status: "completed" }]);
    expect(rpivTasks).toEqual([{ id: "tool-task:verify", text: "Verify checks", status: "in_progress" }]);
    expect(planTasks).toEqual([
      { id: "plan:0:Design reducer", text: "Design reducer", status: "completed" },
      { id: "plan:1:Build panel", text: "Build panel", status: "pending" },
    ]);
  });

  it("keeps code intact while spacing adjacent markdown thought headers", () => {
    expect(formatThinkingText("**Inspect** **Implement**\n`**inline**`\n```\n**code** **stays**\n```")).toBe(
      "**Inspect**\n\n**Implement**\n`**inline**`\n```\n**code** **stays**\n```",
    );
  });

  it("coalesces adjacent reasoning deltas into one thought", () => {
    const summary = reduceTimeline([
      { type: "reasoning", text: "# Clarifying " },
      { type: "reasoning", text: "snapshot details\n\nI should be precise." },
      { type: "tool_call", callId: "read-1", name: "read", status: "completed", error: null, detail: { type: "read", filePath: "README.md" } },
      { type: "reasoning", text: "A separate thought." },
    ] satisfies AgentTimelineItem[]);

    expect(summary.thoughts).toEqual([
      { id: "thought:0", title: "Clarifying snapshot details", text: "# Clarifying snapshot details\n\nI should be precise." },
      { id: "thought:1", title: null, text: "A separate thought." },
    ]);
  });

  it("derives token deltas and cache hit rates", () => {
    const current = { inputTokens: 900, cachedInputTokens: 300, outputTokens: 120 };
    const previous = { inputTokens: 500, cachedInputTokens: 100, outputTokens: 40 };

    expect(usageDelta(current, previous)).toEqual({
      inputTokens: 400,
      cachedInputTokens: 200,
      outputTokens: 80,
    });
    expect(usageForTurn(current, previous)).toEqual({
      inputTokens: 400,
      cachedInputTokens: 200,
      outputTokens: 80,
    });
    expect(usageForTurn({ inputTokens: 12, outputTokens: 8 }, { inputTokens: 100, outputTokens: 50 })).toEqual({
      inputTokens: 12,
      outputTokens: 8,
    });
    expect(cacheHitRate(current)).toBe(0.25);
    expect(formatTokenCount(1_250)).toBe("1.3k");
    expect(formatPercent(0.25)).toBe("25%");
  });

  it("derives the previous turn duration and active elapsed duration", () => {
    const entries = [
      { item: { type: "user_message", text: "first" }, timestamp: "2026-01-01T00:00:00.000Z", turnId: "turn-1" },
      { item: { type: "assistant_message", text: "done" }, timestamp: "2026-01-01T00:00:07.000Z", turnId: "turn-1" },
      { item: { type: "user_message", text: "second" }, timestamp: "2026-01-01T00:01:00.000Z", turnId: "turn-2" },
    ] as const;

    expect(lastTurnDuration(entries, "turn-2")).toBe(7_000);
    expect(elapsedDuration("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:00:12.000Z"))).toBe(12_000);
    expect(formatDuration(7_000)).toBe("7s");
  });
});
