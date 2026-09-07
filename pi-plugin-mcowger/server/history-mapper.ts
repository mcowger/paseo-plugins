import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

import type { PiAgentMessage, PiImageContent, PiTextContent } from "../shared/rpc-types.js";
import {
  extractTextFromToolResult,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
  type PiToolResult,
  type PiTrackedToolCall,
} from "./tool-call-mapper.js";
import { extractTodoSnapshot, PI_TODO_TIMELINE_ITEM_ID } from "./todo.js";

export interface PiCapturedUserMessageEntry {
  id: string;
  text: string;
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

export function getUserMessageText(
  content: string | (PiTextContent | PiImageContent)[],
): string {
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

/**
 * Maps pi's persisted message history into provider timeline item snapshots
 * for `history: "replay"` session opens.
 */
export class PiHistoryMapper {
  private readonly pendingToolCalls = new Map<string, PiTrackedToolCall>();
  private userIndex = 0;
  private assistantIndex = 0;
  private reasoningIndex = 0;

  constructor(private readonly userEntries: readonly PiCapturedUserMessageEntry[] = []) {}

  mapMessages(messages: readonly PiAgentMessage[]): ProviderTimelineItem[] {
    const items: ProviderTimelineItem[] = [];

    for (const message of messages) {
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
        case "toolResult": {
          const mapped = this.mapToolResultMessage(message);
          if (mapped) {
            items.push(...mapped);
          }
          break;
        }
        case "bashExecution":
          items.push(this.mapBashExecutionMessage(message));
          break;
      }
    }

    return items;
  }

  private mapUserMessage(
    message: Extract<PiAgentMessage, { role: "user" }>,
  ): ProviderTimelineItem[] {
    const text = getUserMessageText(message.content);
    this.userIndex += 1;
    if (!text) {
      return [];
    }
    const userEntry = this.userEntries[this.userIndex - 1];
    const id = userEntry?.id ?? `pi-history-user-${this.userIndex}`;
    return [
      {
        type: "user_message",
        id,
        text,
        ...(userEntry ? { messageId: userEntry.id, revertToken: userEntry.id } : {}),
      },
    ];
  }

  private mapCustomMessage(
    message: Extract<PiAgentMessage, { role: "custom" }>,
  ): ProviderTimelineItem[] {
    const text = getUserMessageText(message.content);
    return text
      ? [
          {
            type: "assistant_message",
            id: `pi-history-custom-${this.userIndex}-${this.assistantIndex}`,
            text,
          },
        ]
      : [];
  }

  private mapAssistantMessage(
    message: Extract<PiAgentMessage, { role: "assistant" }>,
  ): ProviderTimelineItem[] {
    const items: ProviderTimelineItem[] = [];
    this.assistantIndex += 1;
    const messageId = message.responseId || `pi-history-assistant-${this.assistantIndex}`;
    for (const content of message.content) {
      if (content.type === "text" && content.text) {
        items.push({ type: "assistant_message", id: messageId, text: content.text, messageId });
        continue;
      }
      if (content.type === "thinking" && content.thinking) {
        this.reasoningIndex += 1;
        items.push({
          type: "reasoning",
          id: `pi-history-reasoning-${this.reasoningIndex}`,
          text: content.thinking,
        });
        continue;
      }
      if (content.type === "toolCall") {
        const tracked = parseToolArgs(content.name, content.arguments);
        this.pendingToolCalls.set(content.id, tracked);
        items.push({
          type: "tool_call",
          id: content.id,
          callId: content.id,
          name: tracked.toolName,
          status: "running",
          detail: mapToolDetail(tracked, null),
          error: null,
        });
      }
    }
    return items;
  }

  private mapToolResultMessage(
    message: Extract<PiAgentMessage, { role: "toolResult" }>,
  ): ProviderTimelineItem[] | null {
    const tracked =
      this.pendingToolCalls.get(message.toolCallId) ?? parseToolArgs(message.toolName, null);
    this.pendingToolCalls.delete(message.toolCallId);
    const result: PiToolResult = parseToolResult({ content: message.content, details: message.details });
    const isError = Boolean(message.isError);
    const baseItem = {
      type: "tool_call" as const,
      id: message.toolCallId,
      callId: message.toolCallId,
      name: resolveToolCallName(tracked, result),
      detail: mapToolDetail(tracked, result),
    };
    const items: ProviderTimelineItem[] = [
      isError
        ? {
            ...baseItem,
            status: "failed" as const,
            error: extractTextFromToolResult(result) ?? "Tool call failed",
          }
        : { ...baseItem, status: "completed" as const, error: null },
    ];

    const todos = extractTodoSnapshot(tracked, result);
    if (todos && todos.length > 0) {
      items.push({
        type: "todo",
        id: PI_TODO_TIMELINE_ITEM_ID,
        items: todos.map((todo) => ({
          text: todo.text,
          completed: todo.status === "completed",
          ...(todo.id ? { id: todo.id } : {}),
          status: todo.status,
          ...(todo.activeForm ? { activeForm: todo.activeForm } : {}),
        })),
      });
    }

    return items;
  }

  private mapBashExecutionMessage(
    message: Extract<PiAgentMessage, { role: "bashExecution" }>,
  ): ProviderTimelineItem {
    return {
      type: "tool_call",
      id: `pi-bash-${message.timestamp}`,
      callId: `pi-bash-${message.timestamp}`,
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
}
