// Diff-on-touch source: paseo checkout, packages/server/src/server/agent/providers/pi/history-mapper.ts
// Intentional divergences (never "fix" on diff):
// - Output is ProviderTimelineItem (plugin SDK) instead of AgentStreamEvent
//   (in-tree agent-sdk-types); the host has no separate assign-ids step.
// - Every emitted item carries a stable `id`. User rows backed by a captured
//   tree entry use the entry id; user rows without capture use an opaque
//   generated id and omit `messageId` (no false linkage, no history-user-N).
// - `mintRevertToken` / `onToolResult` hooks: revert-token minting and
//   NicoSubagentProjector.observeHistory stay owned by session.ts so this
//   module remains pure and unit-testable without session state.
// - Replay budgets (message/byte/node caps, NG item 4): mapping throws
//   PiHistoryBudgetError before the caller emits anything, so replay is
//   all-or-nothing and never partial-and-unmarked. Revert-token mints are
//   deferred until mapping succeeds so a failed replay mints nothing;
//   onToolResult stays inline because the session-owned mapToolDetail hook
//   reads projector parent-links populated by it during the same replay.
// - Multi-block assistant messages: timeline items upsert by id, so the
//   first text block keeps the bare messageId for linkage and later blocks
//   (and repeated thinking blocks) are suffixed to unique ids.
import { randomUUID } from "node:crypto";

import type { ProviderTimelineItem, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

import { boundedJsonBytes, utf8Bytes } from "./bounds.js";

import type { PiAgentMessage, PiImageContent, PiTextContent } from "./rpc-types.js";
import {
  extractTextFromToolResult,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
  type PiToolResult,
  type PiTrackedToolCall,
} from "./tool-call-mapper.js";

export const PI_HISTORY_MAX_MESSAGES = 100_000;
export const PI_HISTORY_MAX_BYTES = 64 * 1024 * 1024;
export const PI_HISTORY_MAX_NODES = 400_000;

export class PiHistoryBudgetError extends Error {
  constructor(limit: string) {
    super(`Pi history replay exceeded the ${limit} budget`);
    this.name = "PiHistoryBudgetError";
  }
}

export interface PiCapturedUserMessageEntry {
  id: string;
  text: string;
}

export interface PiHistoryMapperHooks {
  mapCustomMessage?: (text: string) => ProviderTimelineItem | null;
  resolveToolCallId?: (toolCallId: string, toolCall: PiTrackedToolCall) => string;
  mapToolDetail?: (
    toolCall: PiTrackedToolCall,
    result: PiToolResult,
    context: { toolCallId: string },
  ) => ProviderToolCallDetail | null;
  mintRevertToken?: (entryId: string) => string;
  onToolResult?: (
    toolCallId: string,
    toolName: string,
    value: { content: unknown; details: unknown },
    isError: boolean,
  ) => void;
}

function isTextContentBlock(block: unknown): block is PiTextContent {
  return (
    typeof block === "object" &&
    block !== null &&
    !Array.isArray(block) &&
    Reflect.get(block, "type") === "text" &&
    typeof Reflect.get(block, "text") === "string"
  );
}

export function getUserMessageText(content: string | (PiTextContent | PiImageContent)[]): string {
  if (typeof content === "string") {
    return content;
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (isTextContentBlock(block)) {
      textParts.push(block.text);
    }
  }
  return textParts.join("\n\n");
}

export class PiHistoryMapper {
  private readonly pendingToolCalls = new Map<string, PiTrackedToolCall>();
  private readonly pendingRevertMints: Array<{
    item: Extract<ProviderTimelineItem, { type: "user_message" }>;
    entryId: string;
  }> = [];
  private readonly usedTimelineIds = new Set<string>();
  private userIndex = 0;
  private assistantIndex = 0;
  private messageCount = 0;
  private byteCount = 0;
  private nodeCount = 0;

  constructor(
    private readonly provider: string,
    private readonly userEntries: readonly PiCapturedUserMessageEntry[] = [],
    private readonly hooks: PiHistoryMapperHooks = {},
  ) {}

  mapMessages(messages: readonly PiAgentMessage[]): ProviderTimelineItem[] {
    const items: ProviderTimelineItem[] = [];

    for (const message of messages) {
      this.countMessage();
      switch (message.role) {
        case "user":
          items.push(...this.mapUserMessage(message));
          break;
        case "custom":
          items.push(...this.mapCustomMessage(message));
          break;
        case "assistant":
          items.push(...this.mapAssistantMessage(message));
          break;
        case "toolResult":
          items.push(this.mapToolResultMessage(message));
          break;
        case "bashExecution":
          items.push(this.mapBashExecutionMessage(message));
          break;
      }
    }

    // Mint revert tokens only after the whole replay fits the budgets, so a
    // failed replay leaves no orphan tokens behind in the session map.
    const mint = this.hooks.mintRevertToken;
    if (mint) {
      for (const pending of this.pendingRevertMints.splice(0)) {
        pending.item.revertToken = mint(pending.entryId);
      }
    }

    return items;
  }

  private mapUserMessage(message: Extract<PiAgentMessage, { role: "user" }>): ProviderTimelineItem[] {
    const text = getUserMessageText(message.content);
    this.userIndex += 1;
    if (!text) {
      return [];
    }
    this.addBytes(utf8Bytes(text));
    this.addNodes(2);
    const userEntry = this.userEntries[this.userIndex - 1];
    if (userEntry) {
      const item: Extract<ProviderTimelineItem, { type: "user_message" }> = {
        type: "user_message",
        id: userEntry.id,
        messageId: userEntry.id,
        text,
      };
      if (this.hooks.mintRevertToken) {
        this.pendingRevertMints.push({ item, entryId: userEntry.id });
      }
      return [item];
    }
    return [
      {
        type: "user_message",
        id: randomUUID(),
        text,
      },
    ];
  }

  private mapCustomMessage(
    message: Extract<PiAgentMessage, { role: "custom" }>,
  ): ProviderTimelineItem[] {
    const text = getUserMessageText(message.content);
    const mappedItem = text ? this.hooks.mapCustomMessage?.(text) : null;
    if (mappedItem) {
      // Hook-mapped content still counts toward the replay budgets.
      this.addBytes(utf8Bytes(text));
      this.addNodes(2);
      return [mappedItem];
    }
    if (!text) {
      return [];
    }
    this.addBytes(utf8Bytes(text));
    this.addNodes(2);
    return [
      {
        type: "assistant_message",
        id: randomUUID(),
        text,
      },
    ];
  }

  private mapAssistantMessage(
    message: Extract<PiAgentMessage, { role: "assistant" }>,
  ): ProviderTimelineItem[] {
    const items: ProviderTimelineItem[] = [];
    this.assistantIndex += 1;
    this.addNodes(1);
    const messageId =
      message.responseId || `${this.provider}-history-assistant-${this.assistantIndex}`;
    let textBlocks = 0;
    let thinkingBlocks = 0;
    for (const content of message.content) {
      this.addNodes(1);
      if (content.type === "text" && content.text) {
        this.addBytes(utf8Bytes(content.text));
        this.addNodes(1);
        textBlocks += 1;
        items.push({
          type: "assistant_message",
          id: textBlocks === 1 ? messageId : `${messageId}:text-${textBlocks}`,
          messageId,
          text: content.text,
        });
        continue;
      }
      if (content.type === "thinking" && content.thinking) {
        this.addBytes(utf8Bytes(content.thinking));
        this.addNodes(1);
        thinkingBlocks += 1;
        const thinkingBase = `${messageId}:thinking`;
        items.push({
          type: "reasoning",
          id: thinkingBlocks === 1 ? thinkingBase : `${thinkingBase}-${thinkingBlocks}`,
          text: content.thinking,
        });
        continue;
      }
      if (content.type === "toolCall") {
        this.addBytes(utf8Bytes(content.name));
        this.addJsonBytes(content.arguments ?? null);
        this.addNodes(1);
        const tracked = parseToolArgs(content.name, content.arguments);
        this.pendingToolCalls.set(content.id, tracked);
        const detail = this.mapToolDetail(content.id, tracked, null);
        const callId = this.resolveToolCallId(content.id, tracked);
        items.push({
          type: "tool_call",
          id: callId,
          callId,
          name: tracked.toolName,
          status: "running",
          detail,
          error: null,
        });
      }
    }
    return items;
  }

  private mapToolResultMessage(
    message: Extract<PiAgentMessage, { role: "toolResult" }>,
  ): ProviderTimelineItem {
    const tracked =
      this.pendingToolCalls.get(message.toolCallId) ?? parseToolArgs(message.toolName, null);
    this.pendingToolCalls.delete(message.toolCallId);
    // Normalize string content to text blocks: parseToolResult only accepts the
    // object shape with a content array, and the wrapper must not drop details
    // (edit diffs, xdev unwraps, mcp server/tool names) the way passing
    // message.content alone would.
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    const stored = { content, details: message.details };
    this.hooks.onToolResult?.(message.toolCallId, message.toolName, stored, Boolean(message.isError));
    const result = parseToolResult(stored);
    this.addJsonBytes(stored);
    this.addNodes(2);
    const detail = this.mapToolDetail(message.toolCallId, tracked, result);
    const callId = this.resolveToolCallId(message.toolCallId, tracked);
    const name = resolveToolCallName(tracked, result);
    if (message.isError) {
      return {
        type: "tool_call",
        id: callId,
        callId,
        name,
        status: "failed",
        detail,
        error: extractTextFromToolResult(result) ?? "Tool call failed",
      };
    }
    return {
      type: "tool_call",
      id: callId,
      callId,
      name,
      status: "completed",
      detail,
      error: null,
    };
  }

  private mapBashExecutionMessage(
    message: Extract<PiAgentMessage, { role: "bashExecution" }>,
  ): ProviderTimelineItem {
    // Same-millisecond executions share a timestamp; disambiguate repeats so
    // earlier executions are not overwritten on id upsert.
    const callId = this.uniqueTimelineId(`${this.provider}-bash-${message.timestamp}`);
    this.addBytes(utf8Bytes(message.command) + utf8Bytes(message.output ?? ""));
    this.addNodes(2);
    return {
      type: "tool_call",
      id: callId,
      callId,
      name: "bash",
      status: message.cancelled ? "canceled" : "completed",
      detail: {
        type: "shell",
        command: message.command,
        output: message.output,
        exitCode: message.exitCode ?? null,
      },
      error: null,
    };
  }

  private resolveToolCallId(toolCallId: string, toolCall: PiTrackedToolCall): string {
    return this.hooks.resolveToolCallId?.(toolCallId, toolCall) ?? toolCallId;
  }

  private mapToolDetail(
    toolCallId: string,
    toolCall: PiTrackedToolCall,
    result: PiToolResult,
  ): ProviderToolCallDetail {
    const hook = this.hooks.mapToolDetail;
    // A null hook result must not drop the item: the matching tool_call was
    // already emitted as running, so dropping it would spin forever in
    // replay. Fall back to the default detail instead.
    return hook?.(toolCall, result, { toolCallId }) ?? mapToolDetail(toolCall, result);
  }

  /** First use keeps the stable base id; repeats get a -2/-3 suffix. */
  private uniqueTimelineId(baseId: string): string {
    let candidate = baseId;
    let suffix = 2;
    while (this.usedTimelineIds.has(candidate)) {
      candidate = `${baseId}-${suffix}`;
      suffix += 1;
    }
    this.usedTimelineIds.add(candidate);
    return candidate;
  }

  /**
   * Account arbitrary in-process values without serializing them:
   * JSON.stringify would double peak memory on large outputs and throw a raw
   * TypeError on non-serializable values (BigInt) instead of a budget error.
   */
  private addJsonBytes(value: unknown): void {
    const size = boundedJsonBytes(value, PI_HISTORY_MAX_BYTES - this.byteCount);
    if (size === Number.POSITIVE_INFINITY) {
      throw new PiHistoryBudgetError(`byte (${PI_HISTORY_MAX_BYTES})`);
    }
    this.addBytes(size);
  }

  private countMessage(): void {
    this.messageCount += 1;
    this.addNodes(1);
    if (this.messageCount > PI_HISTORY_MAX_MESSAGES) {
      throw new PiHistoryBudgetError(`message (${PI_HISTORY_MAX_MESSAGES})`);
    }
  }

  private addBytes(count: number): void {
    this.byteCount += count;
    if (this.byteCount > PI_HISTORY_MAX_BYTES) {
      throw new PiHistoryBudgetError(`byte (${PI_HISTORY_MAX_BYTES})`);
    }
  }

  private addNodes(count: number): void {
    this.nodeCount += count;
    if (this.nodeCount > PI_HISTORY_MAX_NODES) {
      throw new PiHistoryBudgetError(`node (${PI_HISTORY_MAX_NODES})`);
    }
  }
}

export async function* streamPiHistory(
  provider: string,
  messages: PiAgentMessage[],
  userEntries: readonly PiCapturedUserMessageEntry[] = [],
  hooks: PiHistoryMapperHooks = {},
): AsyncGenerator<ProviderTimelineItem> {
  const mapper = new PiHistoryMapper(provider, userEntries, hooks);
  for (const item of mapper.mapMessages(messages)) {
    yield item;
  }
}
