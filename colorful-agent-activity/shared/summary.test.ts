import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import {
  isExcludedSummaryToolCall,
  summarizeAgentActivity,
  type SummarySourceEntry,
} from "./summary";

const NOW = Date.parse("2026-01-02T03:04:05.000Z");

function at(offsetMs: number): Date {
  return new Date(NOW - offsetMs);
}

function toolCall(overrides: Record<string, unknown>): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: "call",
    status: "completed",
    error: null,
    name: "read",
    detail: { type: "read", filePath: "a.ts" },
    ...overrides,
  } as AgentTimelineItem;
}

function entry(item: AgentTimelineItem, offsetMs = 0): SummarySourceEntry {
  return { item, timestamp: at(offsetMs) };
}

describe("summarizeAgentActivity tool grouping", () => {
  it("groups reads, writes, and edits by tool type with distinct file lists", () => {
    const summary = summarizeAgentActivity(
      [
        entry(toolCall({ callId: "r1", name: "read", detail: { type: "read", filePath: "types.ts" } })),
        entry(toolCall({ callId: "r2", name: "read", detail: { type: "read", filePath: "types.ts" } })),
        entry(toolCall({ callId: "r3", name: "read", detail: { type: "read", filePath: "other.ts" } })),
        entry(toolCall({ callId: "w1", name: "write", detail: { type: "write", filePath: "new.ts" } })),
        entry(toolCall({ callId: "e1", name: "edit", detail: { type: "edit", filePath: "types.ts" } })),
        entry(toolCall({ callId: "e2", name: "edit", detail: { type: "edit", filePath: "other.ts" } })),
        entry(toolCall({ callId: "s1", name: "bash", detail: { type: "shell", command: "ls" } })),
      ],
      { now: NOW },
    );

    const byLabel = new Map(summary.toolGroups.map((group) => [group.label, group]));
    expect(byLabel.get("Read")).toMatchObject({ count: 3, files: ["types.ts", "other.ts"] });
    expect(byLabel.get("Write")).toMatchObject({ count: 1, files: ["new.ts"] });
    expect(byLabel.get("Edit")).toMatchObject({ count: 2, files: ["types.ts", "other.ts"] });
    expect(byLabel.get("Shell")).toMatchObject({ count: 1, files: [] });
    expect(summary.toolCallCount).toBe(7);
  });

  it("expands apply_patch into one edit per file", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "+hello",
      "*** End Patch",
    ].join("\n");
    const summary = summarizeAgentActivity(
      [entry(toolCall({ name: "apply_patch", detail: { type: "unknown", input: patch, output: null } }))],
      { now: NOW },
    );

    const edit = summary.toolGroups.find((group) => group.label === "Edit");
    expect(edit?.count).toBe(2);
    expect(edit?.files).toEqual(["src/a.ts", "src/b.ts"]);
    // One raw tool call is still one coordination event.
    expect(summary.toolCallCount).toBe(1);
  });

  it("buckets MCP tools by their leaf name and code mode separately", () => {
    const summary = summarizeAgentActivity(
      [
        entry(
          toolCall({
            name: "mcp__exa__web_search_exa",
            detail: { type: "unknown", input: {}, output: {} },
          }),
        ),
        entry(
          toolCall({
            callId: "c2",
            name: "mcp__other__other_tool",
            detail: { type: "unknown", input: {}, output: {} },
          }),
        ),
        entry(toolCall({ callId: "c3", name: "execute", detail: { type: "unknown", input: "1+1", output: "2" } })),
      ],
      { now: NOW },
    );

    const labels = summary.toolGroups.map((group) => group.label).sort();
    expect(labels).toContain("MCP (web_search_exa)");
    expect(labels).toContain("MCP (other_tool)");
    expect(labels).toContain("Codemode");
  });

  it("excludes subagent delegation and todo calls", () => {
    const excluded = [
      toolCall({ name: "task", detail: { type: "unknown", input: {}, output: {} } }),
      toolCall({ name: "subagent", detail: { type: "unknown", input: {}, output: {} } }),
      toolCall({ name: "subagent_supervisor", detail: { type: "unknown", input: {}, output: {} } }),
      toolCall({ name: "todo", detail: { type: "unknown", input: {}, output: {} } }),
      toolCall({
        name: "Task",
        detail: { type: "sub_agent", subAgentType: "explore", log: "" },
      }),
    ];
    for (const item of excluded) {
      expect(isExcludedSummaryToolCall(item as never)).toBe(true);
    }
    const summary = summarizeAgentActivity(excluded.map((item) => entry(item)), { now: NOW });
    expect(summary.toolCallCount).toBe(0);
    expect(summary.toolGroups).toEqual([]);
  });
});

describe("summarizeAgentActivity thinking, output, and status", () => {
  it("collects thinking and output in order and drops blanks", () => {
    const summary = summarizeAgentActivity(
      [
        entry({ type: "reasoning", text: "first" }),
        entry({ type: "reasoning", text: "   " }),
        entry({ type: "assistant_message", text: "hello" }),
        entry({ type: "assistant_message", text: "\n" }),
        entry({ type: "reasoning", text: "second" }),
      ],
      { now: NOW },
    );

    expect(summary.thinking.map((item) => item.text)).toEqual(["first", "second"]);
    expect(summary.output.map((item) => item.text)).toEqual(["hello"]);
    expect(summary.thinkingCount).toBe(2);
    expect(summary.outputCount).toBe(1);
  });

  it("reports active calls, recent rate, and time since the last call", () => {
    const summary = summarizeAgentActivity(
      [
        entry(toolCall({ callId: "a", status: "running" }), 5_000),
        entry(toolCall({ callId: "b" }), 90_000),
        entry(toolCall({ callId: "c" }), 120_000),
      ],
      { now: NOW },
    );

    expect(summary.activeToolCalls).toBe(1);
    expect(summary.toolCallsPerMinute).toBe(1);
    expect(summary.msSinceLastToolCall).toBe(5_000);
  });

  it("marks a group failed when it has failures and no running calls", () => {
    const summary = summarizeAgentActivity(
      [
        entry(toolCall({ callId: "a", name: "bash", status: "failed", error: "boom", detail: { type: "shell", command: "x" } })),
        entry(toolCall({ callId: "b", name: "bash", status: "completed", detail: { type: "shell", command: "y" } })),
      ],
      { now: NOW },
    );

    const shell = summary.toolGroups.find((group) => group.label === "Shell");
    expect(shell).toMatchObject({ count: 2, status: "failed", failedCount: 1 });
  });
});
