import { describe, expect, test } from "vitest";
import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { createTimeline, mapToolDetail, mapUsage } from "./timeline";

function harness() {
  const events: ProviderEvent[] = [];
  const timeline = createTimeline({
    sessionId: "session-1",
    emit: (event) => events.push(event),
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
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" },
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
        toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: { path: "fixture.txt" } },
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
      detail: { type: "write", filePath: "out.txt", content: "wrote out.txt" },
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

describe("mapToolDetail and mapUsage", () => {
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
    expect(mapUsage({
      input: 5,
      output: 1,
      cacheRead: 0,
      cost: { total: 0 },
      contextWindowMaxTokens: 200000,
      contextWindowUsedTokens: 175,
    })).toEqual({
      inputTokens: 5,
      cachedInputTokens: 0,
      outputTokens: 1,
      totalCostUsd: 0,
      contextWindowMaxTokens: 200000,
      contextWindowUsedTokens: 175,
    });
  });
});
