import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { formatThinkingText, reduceTimeline, tasksFromTimelineItem } from "./summary";

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
});
