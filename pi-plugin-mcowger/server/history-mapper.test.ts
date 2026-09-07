import { describe, expect, it } from "vitest";

import type { PiAgentMessage } from "../shared/rpc-types.js";
import { PiHistoryMapper } from "./history-mapper.js";

describe("PiHistoryMapper", () => {
  it("maps user, assistant, and reasoning messages with stable ids", () => {
    const mapper = new PiHistoryMapper([{ id: "entry-1", text: "hello pi" }]);
    const items = mapper.mapMessages([
      { role: "user", content: "hello pi" },
      {
        role: "assistant",
        responseId: "resp-1",
        content: [
          { type: "thinking", thinking: "pondering" },
          { type: "text", text: "hi there" },
        ],
      },
    ]);

    expect(items[0]).toMatchObject({
      type: "user_message",
      id: "entry-1",
      text: "hello pi",
      revertToken: "entry-1",
    });
    expect(items[1]).toMatchObject({ type: "reasoning", text: "pondering" });
    expect(items[2]).toMatchObject({
      type: "assistant_message",
      id: "resp-1",
      text: "hi there",
    });
  });

  it("maps tool calls and results", () => {
    const mapper = new PiHistoryMapper();
    const messages: PiAgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "file.ts" }],
      },
    ];
    const items = mapper.mapMessages(messages);
    expect(items[0]).toMatchObject({ type: "tool_call", status: "running", name: "bash" });
    expect(items[1]).toMatchObject({
      type: "tool_call",
      status: "completed",
      name: "bash",
      detail: { type: "shell", command: "ls", output: "file.ts" },
    });
  });

  it("emits a native todo item from rpiv-todo results", () => {
    const mapper = new PiHistoryMapper();
    const items = mapper.mapMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-9", name: "todo", arguments: { action: "set" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call-9",
        toolName: "todo",
        content: [{ type: "text", text: "ok" }],
        details: {
          tasks: [
            { id: 1, subject: "Plan", status: "completed" },
            { id: 2, subject: "Build", status: "in_progress" },
          ],
        },
      },
    ]);
    const todo = items.find((item) => item.type === "todo");
    expect(todo).toMatchObject({
      type: "todo",
      id: "pi-todos",
      items: [
        { id: "1", text: "Plan", completed: true, status: "completed" },
        { id: "2", text: "Build", completed: false, status: "in_progress" },
      ],
    });
  });

  it("maps bash executions", () => {
    const mapper = new PiHistoryMapper();
    const items = mapper.mapMessages([
      { role: "bashExecution", command: "ls", output: "x", exitCode: 0, timestamp: 42 },
    ]);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      name: "bash",
      status: "completed",
      detail: { type: "shell", command: "ls" },
    });
  });
});
