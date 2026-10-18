import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import {
  createTimeline,
  mapToolDetail,
  mapUsage,
  projectToolDetails,
  type ToolDetailDiagnostic,
  toolDetailDiagnostic,
} from "./timeline";

function harness(diagnostics: ToolDetailDiagnostic[] = []) {
  const events: ProviderEvent[] = [];
  const timeline = createTimeline({
    sessionId: "session-1",
    emit: (event) => events.push(event),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const snapshots = () =>
    events.filter((event) => event.type === "timeline.item").map((event) => event.item);
  const usageEvents = () => events.filter((event) => event.type === "session.usage");
  return { events, timeline, snapshots, usageEvents };
}

function findItem(items: readonly ProviderTimelineItem[], id: string): ProviderTimelineItem {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Missing timeline item ${id}`);
  return item;
}

describe("createTimeline streaming", () => {
  test("folds text deltas into full snapshots with a stable id", () => {
    const { timeline, snapshots } = harness();

    timeline.accept({
      type: "message_start",
      message: { role: "assistant", responseId: "resp-1", content: [] },
    });
    timeline.accept({
      type: "message_update",
      usage: { input: 0, output: 0, cacheRead: 0, cost: { total: 0 } },
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
    });

    const emitted = snapshots().filter((item) => item.type === "assistant_message");
    expect(emitted.map((item) => item.text)).toEqual(["Hel", "Hello"]);
    expect(emitted.map((item) => item.id)).toEqual(["assistant:resp-1", "assistant:resp-1"]);
  });

  test("message_end replaces streaming content with the authoritative text and usage", () => {
    const { timeline, usageEvents } = harness();

    timeline.accept({
      type: "message_start",
      message: { role: "assistant", responseId: "resp-2", timestamp: 1791004278323, content: [] },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" },
    });
    timeline.accept({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "resp-2",
        content: [{ type: "text", text: "final answer" }],
        usage: { input: 100, output: 12, cacheRead: 7, cost: { total: 0.001 } },
        timestamp: 1791004278323,
      },
    });

    expect(findItem(timeline.items(), "assistant:1791004278323")).toMatchObject({
      type: "assistant_message",
      text: "final answer",
    });
    expect(timeline.usage()).toEqual({
      inputTokens: 100,
      cachedInputTokens: 7,
      outputTokens: 12,
      totalCostUsd: 0.001,
    });
    expect(usageEvents().at(-1)).toMatchObject({
      type: "session.usage",
      sessionId: "session-1",
      usage: { inputTokens: 100, outputTokens: 12 },
    });
  });

  test("folds thinking deltas into a reasoning item keyed by content index", () => {
    const { timeline } = harness();

    timeline.accept({
      type: "message_start",
      message: { role: "assistant", responseId: "resp-3", content: [] },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "thinking" },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 1, thinking: "thinking done" },
    });

    expect(findItem(timeline.items(), "reasoning:resp-3:1")).toMatchObject({
      type: "reasoning",
      text: "thinking done",
    });
  });

  test("prefers protocol content over the legacy thinking field on thinking_end", () => {
    const { timeline } = harness();

    timeline.accept({
      type: "message_start",
      message: { role: "assistant", responseId: "resp-4", content: [] },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        thinking: "legacy channel",
        content: "protocol channel",
      },
    });

    expect(findItem(timeline.items(), "reasoning:resp-4:0")).toMatchObject({
      type: "reasoning",
      text: "protocol channel",
    });
  });

  test("uses the signature summary as canonical thinking text over a merged block", () => {
    const { timeline } = harness();
    const timestamp = 1791004280000;

    timeline.accept({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp,
        content: [
          {
            type: "thinking",
            thinking: "Tracing service tier mapping.\n\nTraces service tier mapping.",
            thinkingSignature: JSON.stringify({
              type: "reasoning",
              summary: [{ text: "Tracing service tier mapping." }],
              content: [{ text: "Traces service tier mapping." }],
            }),
          },
        ],
      },
    });

    expect(findItem(timeline.items(), `reasoning:${timestamp}:0`)).toMatchObject({
      type: "reasoning",
      text: "Tracing service tier mapping.",
    });
  });

  test("falls back to block thinking when the signature has no display text", () => {
    const { timeline } = harness();
    const timestamp = 1791004280001;

    timeline.accept({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp,
        content: [
          {
            type: "thinking",
            thinking: "plain thought",
            thinkingSignature: JSON.stringify({ type: "reasoning" }),
          },
        ],
      },
    });

    expect(findItem(timeline.items(), `reasoning:${timestamp}:0`)).toMatchObject({
      type: "reasoning",
      text: "plain thought",
    });
  });

  test("keeps thinking snapshots prefix-monotonic across summary part separators", () => {
    const { timeline, snapshots } = harness();
    const timestamp = 1791004280010;
    const text = "Diagnosing remote Docker host networking and container exec issues.";

    timeline.accept({
      type: "message_start",
      message: { role: "assistant", timestamp, content: [] },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: text },
    });
    // Pi appends "\n\n" for response.reasoning_summary_part.done, while the
    // final output_item.done overwrite joins summary parts with no trailing
    // separator. The host diffs provider snapshots by prefix and concatenates
    // adjacent reasoning rows, so a trailing separator here used to render
    // the same paragraph twice.
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "\n\n" },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: text },
    });
    timeline.accept({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp,
        content: [
          {
            type: "thinking",
            thinking: text,
            thinkingSignature: JSON.stringify({
              type: "reasoning",
              summary: [{ text }],
            }),
          },
        ],
      },
    });

    const reasoning = snapshots().filter((item) => item.type === "reasoning");
    expect(reasoning.length).toBeGreaterThan(0);
    for (const item of reasoning) {
      expect(item.type === "reasoning" && /\s$/.test(item.text)).toBe(false);
    }
    for (let index = 1; index < reasoning.length; index += 1) {
      const prev = reasoning[index - 1];
      const next = reasoning[index];
      expect(
        prev.type === "reasoning" && next.type === "reasoning" && next.text.startsWith(prev.text),
      ).toBe(true);
    }
    // Simulate the host: strip the previous snapshot prefix per emit, keep
    // the remainder as a row, and concatenate adjacent reasoning rows. The
    // merged text must be the single paragraph, not a duplicated pair.
    let merged = "";
    let previous = "";
    for (const item of reasoning) {
      if (item.type !== "reasoning") continue;
      merged += item.text.startsWith(previous) ? item.text.slice(previous.length) : item.text;
      previous = item.text;
    }
    expect(merged).toBe(text);
  });

  test("drops whitespace-only thinking snapshots", () => {
    const { timeline } = harness();
    const timestamp = 1791004280011;

    timeline.accept({
      type: "message_start",
      message: { role: "assistant", timestamp, content: [] },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "\n\n" },
    });
    timeline.accept({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp,
        content: [{ type: "thinking", thinking: "\n\n" }],
      },
    });

    expect(timeline.items().filter((item) => item.type === "reasoning")).toHaveLength(0);
  });

  test("carries the active turn id onto usage events", () => {
    const { timeline, usageEvents } = harness();

    timeline.accept(
      {
        type: "message_update",
        usage: { input: 5, output: 1, cacheRead: 0, cost: { total: 0 } },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
      },
      { turnId: "turn-9" },
    );

    expect(usageEvents().at(-1)).toMatchObject({ turnId: "turn-9" });
  });
});

describe("createTimeline tools", () => {
  test("maps a read tool from argument deltas through execution end", () => {
    const { timeline } = harness();

    timeline.accept({
      type: "message_start",
      message: { role: "assistant", responseId: "resp-tool", content: [] },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        id: "call-1",
        toolName: "read",
      },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"path":"fixture.txt"}',
      },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "fixture.txt" },
        },
      },
    });
    timeline.accept({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "resp-tool",
        content: [
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "fixture.txt" } },
        ],
      },
    });
    timeline.accept({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "fixture.txt" },
    });
    timeline.accept({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "Isolated fixture data.\n" }] },
      isError: false,
    });

    expect(findItem(timeline.items(), "tool:call-1")).toMatchObject({
      type: "tool_call",
      id: "tool:call-1",
      callId: "call-1",
      name: "read",
      status: "completed",
      error: null,
      detail: { type: "read", filePath: "fixture.txt", content: "Isolated fixture data.\n" },
    });
  });

  test("reads tool identity from the native partial without publishing a provisional row", () => {
    const { timeline, snapshots } = harness();
    const timestamp = 1791004279000;

    timeline.accept({
      type: "message_start",
      message: { role: "assistant", timestamp, content: [] },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        partial: {
          role: "assistant",
          timestamp,
          content: [{ type: "toolCall", id: "call-real", name: "read", arguments: {} }],
        },
      },
    });

    const toolIds = snapshots()
      .filter((item) => item.type === "tool_call")
      .map((item) => item.id);
    expect(toolIds).toEqual(["tool:call-real"]);
    expect(toolIds.some((id) => id.startsWith("tool:stream-tool-"))).toBe(false);
  });

  test("defers the tool row until an authoritative native call id exists", () => {
    const { timeline, snapshots } = harness();
    const timestamp = 1791004279500;
    const partialWithoutCall = { role: "assistant", timestamp, content: [] };

    timeline.accept({
      type: "message_start",
      message: { role: "assistant", timestamp, content: [] },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        partial: partialWithoutCall,
      },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"path":"a.txt"}',
        partial: partialWithoutCall,
      },
    });

    expect(snapshots().filter((item) => item.type === "tool_call")).toHaveLength(0);

    timeline.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          id: "call-late",
          name: "read",
          arguments: { path: "a.txt" },
        },
        partial: partialWithoutCall,
      },
    });

    const toolIds = snapshots()
      .filter((item) => item.type === "tool_call")
      .map((item) => item.id);
    expect(toolIds).toEqual(["tool:call-late"]);
    expect(toolIds.some((id) => id.startsWith("tool:stream-tool-"))).toBe(false);
  });

  test("marks a failed tool execution with error data", () => {
    const { timeline } = harness();

    timeline.accept({
      type: "tool_execution_start",
      toolCallId: "call-2",
      toolName: "bash",
      args: { command: "false" },
    });
    timeline.accept({
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "bash",
      result: { content: [{ type: "text", text: "boom" }] },
      isError: true,
    });

    const tool = findItem(timeline.items(), "tool:call-2");
    expect(tool).toMatchObject({
      type: "tool_call",
      status: "failed",
      detail: { type: "shell", command: "false", output: "boom" },
    });
    expect(tool.type === "tool_call" && tool.error).not.toBeNull();
  });

  test("renders Pi's task list as a task card instead of a text row", () => {
    const { timeline } = harness();

    timeline.accept({
      type: "tool_execution_start",
      toolCallId: "call-todo",
      toolName: "todo",
      args: { action: "create", subject: "Inspect working tree status" },
    });
    // A running todo call has no list yet: it must not leave a placeholder row
    // behind that the card then sits next to.
    expect(timeline.items().filter((item) => item.type === "tool_call")).toHaveLength(0);

    timeline.accept({
      type: "tool_execution_end",
      toolCallId: "call-todo",
      toolName: "todo",
      result: { content: [{ type: "text", text: "Created #1: Inspect working tree status" }] },
      details: {
        action: "create",
        nextId: 3,
        tasks: [
          { id: 1, subject: "Inspect working tree status", status: "pending", description: "x" },
          { id: 2, subject: "Split the rename", status: "in_progress", description: "y" },
        ],
      },
    });

    const items = timeline.items();
    expect(items.some((item) => item.type === "tool_call")).toBe(false);
    expect(items.find((item) => item.type === "todo")).toEqual({
      type: "todo",
      id: "todo:call-todo",
      items: [
        { text: "Inspect working tree status", status: "pending", completed: false, id: "1" },
        { text: "Split the rename", status: "in_progress", completed: false, id: "2" },
      ],
    });
  });

  test("falls back to a tool row when a todo call reports no list", () => {
    const { timeline } = harness();

    timeline.accept({
      type: "tool_execution_end",
      toolCallId: "call-todo-2",
      toolName: "todo",
      result: { content: [{ type: "text", text: "No tasks" }] },
    });

    expect(findItem(timeline.items(), "tool:call-todo-2")).toMatchObject({
      type: "tool_call",
      detail: { type: "plain_text", label: "Todo", text: "No tasks" },
    });
  });

  test("replay folds the same task card instead of stacking duplicates", () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call-todo",
        toolName: "todo",
        content: [{ type: "text", text: "Created #1" }],
        details: { tasks: [{ id: 1, subject: "One", status: "pending" }] },
      },
    ];
    const first = harness();
    first.timeline.replay(messages);
    const second = harness();
    second.timeline.replay(messages);
    expect(first.timeline.items()).toEqual(second.timeline.items());
    expect(first.timeline.items().filter((item) => item.type === "todo")).toHaveLength(1);
  });

  test("replaces a tool result row from a toolResult message", () => {
    const { timeline } = harness();

    timeline.accept({
      type: "tool_execution_start",
      toolCallId: "call-3",
      toolName: "write",
      args: { path: "out.txt", content: "hello" },
    });
    timeline.accept({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call-3",
        toolName: "write",
        content: [{ type: "text", text: "wrote out.txt" }],
        isError: false,
      },
    });

    expect(findItem(timeline.items(), "tool:call-3")).toMatchObject({
      type: "tool_call",
      status: "completed",
      // The written payload comes from the call; the result text is the tool's
      // confirmation ("wrote out.txt") and must not stand in for the file.
      detail: { type: "write", filePath: "out.txt", content: "hello" },
    });
  });

  test("keeps the edit diff a toolResult carries in its details", () => {
    const { timeline } = harness();
    const patch = [
      "--- /app/src/a.ts",
      "+++ /app/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-const a = 1;",
      "+const a = 2;",
    ].join("\n");

    timeline.accept({
      type: "tool_execution_start",
      toolCallId: "call-4",
      toolName: "edit",
      args: {
        path: "/app/src/a.ts",
        edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
      },
    });
    timeline.accept({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call-4",
        toolName: "edit",
        content: [{ type: "text", text: "Successfully replaced 1 block(s)" }],
        details: { patch, diff: "    ...\n-1 const a = 1;\n+1 const a = 2;\n    ..." },
        isError: false,
      },
    });

    expect(findItem(timeline.items(), "tool:call-4")).toMatchObject({
      type: "tool_call",
      status: "completed",
      detail: {
        type: "edit",
        filePath: "/app/src/a.ts",
        oldString: "const a = 1;",
        newString: "const a = 2;",
        unifiedDiff: patch,
      },
    });
  });
});

describe("createTimeline user correlation and replay", () => {
  test("correlates a user message with clientMessageId and updates in place", () => {
    const { timeline } = harness();

    timeline.accept(
      {
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1000 },
      },
      { clientMessageId: "cm-1", turnId: "turn-1" },
    );
    timeline.accept(
      {
        type: "message_end",
        message: {
          role: "user",
          messageId: "msg-9",
          content: [{ type: "text", text: "hi there" }],
          timestamp: 1000,
        },
      },
      { clientMessageId: "cm-1" },
    );

    const users = timeline.items().filter((item) => item.type === "user_message");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      type: "user_message",
      id: "user:1000",
      clientMessageId: "cm-1",
      text: "hi there",
    });
  });

  test("keeps the native timestamp identity when responseId only arrives at message_end", () => {
    const { timeline, snapshots } = harness();
    const timestamp = 1791004278323;

    timeline.accept({
      type: "message_start",
      message: { role: "assistant", timestamp, content: [] },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
    });
    timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
    });
    timeline.accept({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "resp-late",
        timestamp,
        content: [{ type: "text", text: "Hello" }],
      },
    });

    const assistantIds = [
      ...new Set(
        snapshots()
          .filter((item) => item.type === "assistant_message")
          .map((item) => item.id),
      ),
    ];
    expect(assistantIds).toEqual([`assistant:${timestamp}`]);
    expect(assistantIds.some((id) => id.includes("resp-late"))).toBe(false);
    expect(timeline.items().filter((item) => item.type === "assistant_message")).toHaveLength(1);
  });

  test("live folding and replay agree on ids for a native trace with a late responseId", () => {
    const timestamp = 1791004278000;
    const user = { role: "user", content: [{ type: "text", text: "run" }], timestamp };
    const assistantStart = { role: "assistant", timestamp: timestamp + 1, content: [] };
    const finalAssistant = {
      role: "assistant",
      responseId: "resp-late",
      timestamp: timestamp + 1,
      content: [
        { type: "text", text: "working" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
      ],
    };
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "body" }],
      isError: false,
      timestamp: timestamp + 2,
    };

    const live = harness();
    live.timeline.accept(
      { type: "message_start", message: user },
      { clientMessageId: "cm-live", turnId: "turn-1" },
    );
    live.timeline.accept({ type: "message_start", message: assistantStart });
    live.timeline.accept({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" },
    });
    live.timeline.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        partial: finalAssistant,
      },
    });
    live.timeline.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "a.txt" },
        },
        partial: finalAssistant,
      },
    });
    live.timeline.accept({ type: "message_end", message: finalAssistant });
    live.timeline.accept({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "body" }] },
      isError: false,
    });

    const replayed = harness();
    replayed.timeline.replay([user, finalAssistant, toolResult]);

    expect(live.timeline.items().map((item) => item.id)).toEqual(
      replayed.timeline.items().map((item) => item.id),
    );
    expect(live.timeline.items().map((item) => item.id)).toEqual([
      `user:${timestamp}`,
      `assistant:${timestamp + 1}`,
      "tool:call-1",
    ]);
  });

  test("replays an authoritative message array with the same stable identities", () => {
    const { timeline, usageEvents } = harness();

    timeline.replay([
      { role: "user", content: [{ type: "text", text: "do it" }], timestamp: 1000 },
      {
        role: "assistant",
        responseId: "resp-replay",
        content: [
          { type: "text", text: "on it" },
          { type: "toolCall", id: "call-r", name: "read", arguments: { path: "a.txt" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-r",
        toolName: "read",
        content: [{ type: "text", text: "file body" }],
        isError: false,
      },
    ]);

    expect(timeline.items().map((item) => item.id)).toEqual([
      "user:1000",
      "assistant:resp-replay",
      "tool:call-r",
    ]);
    expect(findItem(timeline.items(), "tool:call-r")).toMatchObject({
      type: "tool_call",
      status: "completed",
      detail: { type: "read", filePath: "a.txt", content: "file body" },
    });
    expect(usageEvents()).toHaveLength(0);
  });

  test("replay resets the active history before folding", () => {
    const { timeline } = harness();

    timeline.accept({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 },
    });
    expect(timeline.size()).toBe(1);

    timeline.replay([
      { role: "user", content: [{ type: "text", text: "new" }], timestamp: 2 },
      { role: "assistant", responseId: "resp-new", content: [{ type: "text", text: "ok" }] },
    ]);

    expect(timeline.items().map((item) => item.id)).toEqual(["user:2", "assistant:resp-new"]);
    expect(timeline.size()).toBe(2);
  });

  test("replay and live folding agree on identities for the same native message", () => {
    const message = {
      role: "assistant",
      responseId: "resp-same",
      content: [{ type: "text", text: "same" }],
    };

    const live = harness();
    live.timeline.accept({ type: "message_end", message });

    const replayed = harness();
    replayed.timeline.replay([message]);

    expect(live.timeline.items().map((item) => item.id)).toEqual(
      replayed.timeline.items().map((item) => item.id),
    );
  });
});

describe("tool details nothing interprets", () => {
  test("projects details to bounded, scannable facts", () => {
    expect(
      projectToolDetails({
        status: "background",
        durationMs: 0,
        success: true,
        tokens: "",
        tags: ["a", "b", "c"],
        params: { action: "create" },
        empty: [],
        nothing: null,
      }),
    ).toEqual({
      fields: {
        status: "background",
        durationMs: 0,
        success: true,
        tags: "3 items",
        params: "1 field",
      },
      omitted: 0,
    });
    expect(projectToolDetails({ tokens: "", empty: [] })).toBeNull();
    expect(projectToolDetails("not a record")).toBeNull();
  });

  test("clips long values and stops adding fields past the budget", () => {
    const projected = projectToolDetails({
      long: "x".repeat(400),
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key${i}`, `v${i}`])),
    });
    expect(projected).not.toBeNull();
    const fields = projected?.fields ?? {};
    expect(String(fields.long)).toHaveLength(120);
    expect(String(fields.long).endsWith("…")).toBe(true);
    expect(Object.keys(fields).length).toBe(12);
    expect(projected?.omitted).toBe(9);
  });

  test("carries the projection on an unknown tool's output, and only there", () => {
    const detail = mapToolDetail("mystery", { a: 1 }, "did the thing", {
      status: "ok",
      tags: ["a"],
      modelName: "m",
    });
    expect(detail).toEqual({
      type: "unknown",
      input: { a: 1 },
      output: {
        content: "did the thing",
        details: { status: "ok", tags: "1 item", modelName: "m" },
      },
    });
    // A tool with a branch keeps its curated view; its details are read, not dumped.
    expect(
      mapToolDetail("Agent", { description: "Audit" }, "started", { agentId: "a1", status: "ok" }),
    ).toEqual({ type: "sub_agent", description: "Audit", childSessionId: "a1", log: "started" });
  });

  test("names the detail keys the mapping leaves unread", () => {
    expect(
      toolDetailDiagnostic("Agent", {
        agentId: "a1",
        description: "Audit",
        subagentType: "worker",
        displayName: "worker",
        status: "background",
        tokens: "",
        toolUses: 0,
      }),
    ).toEqual({
      tool: "Agent",
      kind: "agent",
      consumed: ["agentId", "sessionId", "description", "subagentType"],
      unconsumed: ["status", "tokens", "toolUses"],
    });
    // A key dropped on purpose is a decision, not a gap: it stays out of the log.
    expect(toolDetailDiagnostic("edit", { patch: "x", diff: "y", firstChangedLine: 3 })).toBeNull();
    expect(
      toolDetailDiagnostic("todo", { tasks: [], action: "create", params: {}, nextId: 2 }),
    ).toBeNull();
    // A key nobody has accounted for still reports.
    expect(toolDetailDiagnostic("edit", { patch: "x", somethingNew: 1 })).toMatchObject({
      unconsumed: ["somethingNew"],
    });
    expect(toolDetailDiagnostic("bash", null)).toBeNull();
  });

  test("carries a typed tool's leftover facts on the item, since its detail cannot hold them", () => {
    const { timeline } = harness();
    timeline.accept({
      type: "tool_execution_end",
      toolCallId: "call-agent",
      toolName: "Agent",
      args: { description: "Audit", prompt: "go", subagent_type: "worker" },
      result: { content: [{ type: "text", text: "Agent started in background." }] },
      details: {
        agentId: "df30",
        subagentType: "worker",
        description: "Audit",
        status: "background",
        tokens: "39.1k",
        toolUses: 9,
        durationMs: 55900,
        modelName: "claude-haiku-5.5",
        tags: ["thinking: high", "background"],
        displayName: "worker",
      },
    });
    const tool = findItem(timeline.items(), "tool:call-agent");
    expect(tool.type === "tool_call" && tool.metadata).toEqual({
      plexuspiFacts: {
        status: "background",
        tokens: "39.1k",
        toolUses: 9,
        durationMs: 55900,
        modelName: "claude-haiku-5.5",
        tags: "2 items",
      },
    });
  });

  test("reduces shell truncation to the facts a row can show", () => {
    const { timeline } = harness();
    timeline.accept({
      type: "tool_execution_end",
      toolCallId: "call-big",
      toolName: "bash",
      args: { command: "cat huge.log" },
      result: { content: [{ type: "text", text: "first line" }] },
      details: {
        fullOutputPath: "/tmp/plexuspi/huge.log",
        truncation: { truncated: true, totalBytes: 251031, totalLines: 8, outputLines: 0 },
      },
    });
    const tool = findItem(timeline.items(), "tool:call-big");
    expect(tool.type === "tool_call" && tool.metadata).toEqual({
      plexuspiFacts: {
        truncated: true,
        totalBytes: 251031,
        totalLines: 8,
        fullOutputPath: "/tmp/plexuspi/huge.log",
      },
    });
    // An ordinary command carries no facts and no metadata.
    timeline.accept({
      type: "tool_execution_end",
      toolCallId: "call-plain",
      toolName: "bash",
      args: { command: "true" },
      result: { content: [{ type: "text", text: "" }] },
      details: null,
    });
    const plain = findItem(timeline.items(), "tool:call-plain");
    expect(plain.type === "tool_call" && plain.metadata).toBeUndefined();
  });

  test("stays quiet for tools whose curated view already covers their details", () => {
    expect(
      toolDetailDiagnostic("get_subagent_result", {
        agentId: "a1",
        operation: "wait",
        subagentType: "worker",
        description: "Audit",
        status: "completed",
      }),
    ).toBeNull();
    expect(
      toolDetailDiagnostic("ask_user_question", { answers: [{}], cancelled: false }),
    ).toBeNull();
    expect(toolDetailDiagnostic("bash", { truncation: {}, fullOutputPath: "/tmp/x" })).toBeNull();
  });

  test("reports a tool once per session, not once per call", () => {
    const diagnostics: ToolDetailDiagnostic[] = [];
    const { timeline } = harness(diagnostics);
    for (const callId of ["call-a", "call-b"]) {
      timeline.accept({
        type: "tool_execution_end",
        toolCallId: callId,
        toolName: "mystery",
        result: { content: [{ type: "text", text: "ok" }] },
        details: { status: "ok" },
      });
    }
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      tool: "mystery",
      kind: "unknown",
      unconsumed: ["status"],
    });
  });
});

describe("mapToolDetail and mapUsage", () => {
  test("carries the child session the agent result names", () => {
    // The log text says "Agent ID: df30…" too, but the details state it, and the
    // sub_agent detail has a field for it.
    expect(
      mapToolDetail(
        "Agent",
        { description: "Audit rows", prompt: "go", subagent_type: "worker" },
        "Agent started in background.\nAgent ID: df3047d8319c",
        { agentId: "df3047d8319c", status: "background", tokens: "" },
      ),
    ).toEqual({
      type: "sub_agent",
      subAgentType: "worker",
      description: "Audit rows",
      childSessionId: "df3047d8319c",
      log: "Agent started in background.\nAgent ID: df3047d8319c",
    });
    // Nothing to point at when the result names no child.
    expect(mapToolDetail("agent", { description: "Audit" }, "started")).toEqual({
      type: "sub_agent",
      description: "Audit",
      log: "started",
    });
  });

  test("carries the slice a read asked for", () => {
    expect(mapToolDetail("read", { path: "a.ts", offset: 501, limit: 100 }, "body")).toEqual({
      type: "read",
      filePath: "a.ts",
      content: "body",
      offset: 501,
      limit: 100,
    });
    // A whole-file read carries neither, so the row need not explain itself.
    expect(mapToolDetail("read", { path: "a.ts" }, "body")).toEqual({
      type: "read",
      filePath: "a.ts",
      content: "body",
    });
  });

  test("renders the written file, not the tool's confirmation line", () => {
    // Pi reports only "Successfully wrote to <path>" on the result; the payload is
    // on the call. Using the result put that confirmation in the file body.
    expect(
      mapToolDetail(
        "write",
        { path: "src/a.ts", content: "export const a = 1;\n" },
        "Successfully wrote to src/a.ts",
      ),
    ).toEqual({ type: "write", filePath: "src/a.ts", content: "export const a = 1;\n" });
    // A write tool that only reports text still has something to show.
    expect(mapToolDetail("write", { path: "b.ts" }, "wrote b.ts")).toEqual({
      type: "write",
      filePath: "b.ts",
      content: "wrote b.ts",
    });
  });

  test("carries the patch Pi reports on the tool result, not just the call arguments", () => {
    const patch = [
      "--- /app/src/a.ts",
      "+++ /app/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-const a = 1;",
      "+const a = 2;",
    ].join("\n");
    expect(
      mapToolDetail(
        "edit",
        { path: "/app/src/a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
        "Successfully replaced 1 block(s)",
        { patch },
      ),
    ).toEqual({
      type: "edit",
      filePath: "/app/src/a.ts",
      oldString: "const a = 1;",
      newString: "const a = 2;",
      unifiedDiff: patch,
    });
  });

  test("ignores Pi's trimmed diff view, which is not a unified diff", () => {
    expect(
      mapToolDetail("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }, "ok", {
        diff: "    ...\n-13   old line\n+13   new line\n    ...",
      }),
    ).toEqual({ type: "edit", filePath: "a.ts", oldString: "x", newString: "y" });
  });

  test("falls back to the unknown detail for unrecognized tools", () => {
    expect(mapToolDetail("mystery", { a: 1 }, "result")).toEqual({
      type: "unknown",
      input: { a: 1 },
      output: "result",
    });
  });

  test("returns null for zeroed or missing usage", () => {
    expect(mapUsage(undefined)).toBeNull();
    expect(mapUsage({ input: 0, output: 0, cacheRead: 0, cost: { total: 0 } })).toBeNull();
    expect(mapUsage({ input: 5, output: 0, cacheRead: 0, cost: { total: 0 } })).toEqual({
      inputTokens: 5,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
    });
  });

  test("passes through reported context window fields", () => {
    expect(
      mapUsage({
        input: 5,
        output: 1,
        cacheRead: 0,
        cost: { total: 0 },
        contextWindowMaxTokens: 200000,
        contextWindowUsedTokens: 175,
      }),
    ).toEqual({
      inputTokens: 5,
      cachedInputTokens: 0,
      outputTokens: 1,
      totalCostUsd: 0,
      contextWindowMaxTokens: 200000,
      contextWindowUsedTokens: 175,
    });
  });
});
