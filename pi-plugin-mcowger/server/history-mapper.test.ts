import { describe, expect, test } from "vitest";

import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

import {
  getUserMessageText,
  PiHistoryBudgetError,
  PI_HISTORY_MAX_BYTES,
  PI_HISTORY_MAX_MESSAGES,
  PI_HISTORY_MAX_NODES,
  PiHistoryMapper,
  streamPiHistory,
  type PiCapturedUserMessageEntry,
  type PiHistoryMapperHooks,
} from "./history-mapper.js";
import type { PiAgentMessage } from "./rpc-types.js";

async function collectHistory(
  messages: PiAgentMessage[],
  userEntries: PiCapturedUserMessageEntry[] = [],
  hooks: PiHistoryMapperHooks = {},
): Promise<ProviderTimelineItem[]> {
  const items: ProviderTimelineItem[] = [];
  for await (const item of streamPiHistory("pi", messages, userEntries, hooks)) {
    items.push(item);
  }
  return items;
}

function userMessages(items: ProviderTimelineItem[]) {
  return items.filter((item): item is Extract<ProviderTimelineItem, { type: "user_message" }> => item.type === "user_message");
}

describe("Pi history mapper", () => {
  test("replays user, assistant, reasoning, and completed tool calls", async () => {
    await expect(
      collectHistory([
        {
          role: "user",
          content: [
            { type: "text", text: "read this" },
            { type: "image", data: "base64", mimeType: "image/png" },
            { type: "text", text: "then answer" },
          ],
        },
        {
          role: "assistant",
          responseId: "response-1",
          content: [
            { type: "thinking", thinking: "checking file" },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "note.txt" } },
            { type: "text", text: "done" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "user_message",
        text: "read this\n\nthen answer",
      }),
      expect.objectContaining({ type: "reasoning", text: "checking file" }),
      expect.objectContaining({
        type: "tool_call",
        callId: "tool-1",
        name: "read",
        status: "running",
        detail: {
          type: "read",
          filePath: "note.txt",
          content: undefined,
          offset: undefined,
          limit: undefined,
        },
        error: null,
      }),
      expect.objectContaining({ type: "assistant_message", text: "done", messageId: "response-1" }),
      expect.objectContaining({
        type: "tool_call",
        callId: "tool-1",
        name: "read",
        status: "completed",
        detail: {
          type: "read",
          filePath: "note.txt",
          content: "file contents",
          offset: undefined,
          limit: undefined,
        },
        error: null,
      }),
    ]);
  });

  test("replays bash execution records as completed shell calls", async () => {
    await expect(
      collectHistory([
        {
          role: "bashExecution",
          command: "echo hi",
          output: "hi\n",
          exitCode: 0,
          timestamp: 123,
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "tool_call",
        callId: "pi-bash-123",
        name: "bash",
        status: "completed",
        detail: { type: "shell", command: "echo hi", output: "hi\n", exitCode: 0 },
        error: null,
      }),
    ]);
  });

  test("replays cancelled bash execution as canceled", async () => {
    const items = await collectHistory([
      { role: "bashExecution", command: "sleep 60", timestamp: 7, cancelled: true },
    ]);
    expect(items).toEqual([
      expect.objectContaining({ type: "tool_call", callId: "pi-bash-7", status: "canceled" }),
    ]);
  });

  test("replays non-notice custom messages as assistant text, matching the live path", async () => {
    await expect(
      collectHistory([{ role: "custom", content: "Extension command output" }]),
    ).resolves.toEqual([
      expect.objectContaining({ type: "assistant_message", text: "Extension command output" }),
    ]);
  });

  test("uses Pi tree entry ids for replayed user messages", async () => {
    const minted: string[] = [];
    const items = await collectHistory(
      [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: [{ type: "text", text: "first answer" }] },
        { role: "user", content: "second prompt" },
      ],
      [
        { id: "entry-user-1", text: "first prompt" },
        { id: "entry-user-2", text: "second prompt" },
      ],
      { mintRevertToken: (entryId) => { minted.push(entryId); return `token-for-${entryId}`; } },
    );
    expect(items).toEqual([
      expect.objectContaining({
        type: "user_message",
        id: "entry-user-1",
        messageId: "entry-user-1",
        text: "first prompt",
        revertToken: "token-for-entry-user-1",
      }),
      expect.objectContaining({
        type: "assistant_message",
        text: "first answer",
        messageId: "pi-history-assistant-1",
      }),
      expect.objectContaining({
        type: "user_message",
        id: "entry-user-2",
        messageId: "entry-user-2",
        text: "second prompt",
        revertToken: "token-for-entry-user-2",
      }),
    ]);
    expect(minted).toEqual(["entry-user-1", "entry-user-2"]);
  });

  test("user rows without capture use opaque ids and omit false linkage", async () => {
    const items = userMessages(await collectHistory([{ role: "user", content: "hello" }]));
    expect(items).toHaveLength(1);
    expect(typeof items[0]?.id).toBe("string");
    expect(items[0]?.id).not.toMatch(/^history-user-/);
    expect(items[0]).not.toHaveProperty("messageId");
    expect(items[0]).not.toHaveProperty("revertToken");
  });

  test("skips empty user and custom messages", async () => {
    await expect(collectHistory([{ role: "user", content: "" }])).resolves.toEqual([]);
    await expect(collectHistory([{ role: "custom", content: "" }])).resolves.toEqual([]);
  });

  test("supports caller hooks for custom messages, tool ids, and tool details", async () => {
    const observed: Array<{ toolCallId: string; toolName: string; isError: boolean }> = [];
    const items = await collectHistory(
      [
        { role: "custom", content: "notice text" },
        {
          role: "assistant",
          responseId: "r1",
          content: [{ type: "toolCall", id: "tool-9", name: "read", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: "tool-9", toolName: "read", content: "ok" },
      ],
      [],
      {
        mapCustomMessage: (text) => ({ type: "notification", id: "custom-1", level: "info", message: text }),
        resolveToolCallId: (toolCallId) => `resolved-${toolCallId}`,
        mapToolDetail: () => ({ type: "plain_text", label: "custom" }),
        onToolResult: (toolCallId, toolName, _value, isError) => { observed.push({ toolCallId, toolName, isError }); },
      },
    );
    expect(items[0]).toMatchObject({ type: "notification", id: "custom-1", message: "notice text" });
    expect(items[1]).toMatchObject({ type: "tool_call", callId: "resolved-tool-9", detail: { type: "plain_text" } });
    expect(items[2]).toMatchObject({ type: "tool_call", callId: "resolved-tool-9", status: "completed" });
    expect(observed).toEqual([{ toolCallId: "tool-9", toolName: "read", isError: false }]);
  });

  test("a null detail hook falls back to the default detail instead of dropping the tool", async () => {
    // The running tool_call was already emitted; dropping the result would
    // leave it spinning forever, so null falls back to the default detail.
    const items = await collectHistory(
      [
        {
          role: "assistant",
          responseId: "r1",
          content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: "ok" },
      ],
      [],
      { mapToolDetail: () => null },
    );
    expect(items).toEqual([
      expect.objectContaining({
        type: "tool_call",
        callId: "tool-1",
        status: "running",
        detail: { type: "read", filePath: "a.txt", content: undefined, offset: undefined, limit: undefined },
      }),
      expect.objectContaining({
        type: "tool_call",
        callId: "tool-1",
        status: "completed",
        detail: { type: "read", filePath: "a.txt", content: "ok", offset: undefined, limit: undefined },
      }),
    ]);
  });

  test("replays every block of a multi-block assistant message with unique ids", async () => {
    const items = await collectHistory([
      {
        role: "assistant",
        responseId: "r-multi",
        content: [
          { type: "text", text: "first" },
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "second" },
          { type: "thinking", thinking: "more" },
        ],
      },
    ]);
    expect(items).toEqual([
      expect.objectContaining({ type: "assistant_message", id: "r-multi", messageId: "r-multi", text: "first" }),
      expect.objectContaining({ type: "reasoning", id: "r-multi:thinking", text: "hmm" }),
      expect.objectContaining({ type: "assistant_message", id: "r-multi:text-2", messageId: "r-multi", text: "second" }),
      expect.objectContaining({ type: "reasoning", id: "r-multi:thinking-2", text: "more" }),
    ]);
  });

  test("disambiguates same-millisecond bash executions", async () => {
    const items = await collectHistory([
      { role: "bashExecution", command: "a", timestamp: 42 },
      { role: "bashExecution", command: "b", timestamp: 42 },
    ]);
    expect(items).toMatchObject([
      { type: "tool_call", callId: "pi-bash-42" },
      { type: "tool_call", callId: "pi-bash-42-2" },
    ]);
  });

  test("counts hook-mapped custom content toward replay budgets", () => {
    let notifications = 0;
    const mapper = new PiHistoryMapper("pi", [], {
      mapCustomMessage: (text) => {
        notifications += 1;
        return { type: "notification", id: `custom-${notifications}`, level: "info", message: text };
      },
    });
    const messages = Array.from({ length: 70 }, (): PiAgentMessage => ({
      role: "custom",
      content: "x".repeat(1024 * 1024),
    }));
    expect(() => mapper.mapMessages(messages)).toThrow(PiHistoryBudgetError);
  });

  test("mints no revert tokens when replay exceeds budgets", () => {
    const minted: string[] = [];
    const mapper = new PiHistoryMapper("pi", [{ id: "entry-1", text: "first" }], {
      mintRevertToken: (entryId) => {
        minted.push(entryId);
        return `token-${entryId}`;
      },
    });
    expect(() =>
      mapper.mapMessages([
        { role: "user", content: "first" },
        { role: "user", content: "x".repeat(PI_HISTORY_MAX_BYTES + 1) },
      ]),
    ).toThrow(PiHistoryBudgetError);
    expect(minted).toEqual([]);
  });

  test("fails non-serializable tool results with a budget error instead of a stringify throw", () => {
    const mapper = new PiHistoryMapper("pi");
    expect(() =>
      mapper.mapMessages([
        {
          role: "assistant",
          responseId: "r1",
          content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "x" } }],
        },
        { role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: { value: BigInt(10) } },
      ]),
    ).toThrow(PiHistoryBudgetError);
  });

  test("reports failed tool results with extracted error text", async () => {
    const items = await collectHistory([
      {
        role: "assistant",
        responseId: "r1",
        content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "exit 1" } }],
      },
      { role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: "boom", isError: true },
    ]);
    expect(items[1]).toMatchObject({
      type: "tool_call",
      callId: "tool-1",
      name: "bash",
      status: "failed",
      error: "boom",
    });
  });

  test("falls back to a generic error when failed results carry no text", async () => {
    const items = await collectHistory([
      {
        role: "assistant",
        responseId: "r1",
        content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "exit 1" } }],
      },
      { role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: null, isError: true },
    ]);
    expect(items[1]).toMatchObject({ status: "failed", error: "Tool call failed" });
  });

  test("getUserMessageText joins text blocks and ignores images", () => {
    expect(getUserMessageText("plain")).toBe("plain");
    expect(
      getUserMessageText([
        { type: "text", text: "a" },
        { type: "image", data: "x", mimeType: "image/png" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\n\nb");
  });
});

describe("Pi history replay budgets", () => {
  test(`rejects histories beyond ${PI_HISTORY_MAX_MESSAGES} messages`, () => {
    const mapper = new PiHistoryMapper("pi");
    const messages = Array.from({ length: PI_HISTORY_MAX_MESSAGES + 1 }, (): PiAgentMessage => ({
      role: "user",
      content: "",
    }));
    expect(() => mapper.mapMessages(messages)).toThrow(PiHistoryBudgetError);
  });

  test(`rejects histories beyond ${PI_HISTORY_MAX_BYTES} bytes`, () => {
    const mapper = new PiHistoryMapper("pi");
    expect(() =>
      mapper.mapMessages([{ role: "user", content: "x".repeat(PI_HISTORY_MAX_BYTES + 1) }]),
    ).toThrow(PiHistoryBudgetError);
  });

  test(`rejects histories beyond ${PI_HISTORY_MAX_NODES} nodes`, () => {
    const mapper = new PiHistoryMapper("pi");
    const messages = Array.from({ length: 90_000 }, (): PiAgentMessage => ({
      role: "assistant",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    }));
    expect(() => mapper.mapMessages(messages)).toThrow(PiHistoryBudgetError);
    expect(PI_HISTORY_MAX_NODES).toBe(400_000);
  });

  test("budget failures surface as PiHistoryBudgetError", () => {
    const mapper = new PiHistoryMapper("pi");
    try {
      mapper.mapMessages([{ role: "user", content: "x".repeat(PI_HISTORY_MAX_BYTES + 1) }]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PiHistoryBudgetError);
      expect((error as Error).message).toMatch("budget");
    }
  });
});
