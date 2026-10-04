import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  ProviderEvent,
  ProviderTimelineItem,
  ProviderToolCallDetail,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";

/**
 * Pi RPC JSONL record folded into canonical Paseo timeline snapshots.
 *
 * `timeline.ts` is pure: it performs no I/O and only forwards `ProviderEvent`
 * values through the supplied `emit` callback. Records arrive as decoded JSON
 * objects from the Pi transport; the transport owns framing and correlation.
 */

export interface TimelineContext {
  /** Host message identity used to replace the optimistic user row. */
  clientMessageId?: string;
  /** Active host turn identity carried onto usage events. */
  turnId?: string;
}

export interface Timeline {
  readonly sessionId: string;
  accept(record: unknown, context?: TimelineContext): void;
  replay(messages: readonly unknown[]): void;
  items(): readonly ProviderTimelineItem[];
  usage(): ProviderUsage | null;
  size(): number;
  reset(): void;
}

export function createTimeline(input: {
  sessionId: string;
  emit: (event: ProviderEvent) => void;
}): Timeline {
  const { sessionId, emit } = input;
  const order: string[] = [];
  const byId = new Map<string, ProviderTimelineItem>();
  const toolArgs = new Map<string, unknown>();
  const toolNames = new Map<string, string>();
  let stream: StreamingTurn | null = null;
  let activeTurnId: string | undefined;
  let lastUsage: ProviderUsage | null = null;
  let lastUsageKey: string | null = null;

  function toTimestamp(value: unknown): string | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === "string" && value.length > 0) return value;
    return undefined;
  }

  function upsert(item: ProviderTimelineItem, timestamp: unknown): void {
    if (!byId.has(item.id)) order.push(item.id);
    byId.set(item.id, item);
    const iso = toTimestamp(timestamp);
    emit({
      type: "timeline.item",
      sessionId,
      item,
      ...(iso ? { timestamp: iso } : {}),
    });
  }

  function remove(id: string): void {
    if (!byId.delete(id)) return;
    const index = order.indexOf(id);
    if (index >= 0) order.splice(index, 1);
  }

  function emitUsage(usage: unknown): void {
    const mapped = mapUsage(usage);
    if (!mapped) return;
    const key = JSON.stringify(mapped);
    if (key === lastUsageKey) return;
    lastUsageKey = key;
    lastUsage = mapped;
    emit({
      type: "session.usage",
      sessionId,
      usage: { ...mapped },
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
  }

  function accept(record: unknown, context: TimelineContext = {}): void {
    if (!isRecord(record)) return;
    if (context.turnId) activeTurnId = context.turnId;
    switch (record.type) {
      case "message_start":
        acceptMessageStart(record.message, context);
        break;
      case "message_update":
        acceptMessageUpdate(record);
        break;
      case "message_end":
        acceptMessageEnd(record.message, context);
        break;
      case "tool_execution_start":
        acceptToolExecutionStart(record);
        break;
      case "tool_execution_update":
        acceptToolExecutionUpdate(record);
        break;
      case "tool_execution_end":
        acceptToolExecutionEnd(record);
        break;
      default:
        break;
    }
  }

  function acceptMessageStart(message: unknown, context: TimelineContext): void {
    if (!isRecord(message)) return;
    switch (message.role) {
      case "assistant":
        stream = {
          nativeKey: nativeMessageKey(message),
          text: new Map(),
          thinking: new Map(),
          tools: new Map(),
        };
        break;
      case "user":
        upsertUser(message, context.clientMessageId);
        break;
      case "toolResult":
        applyToolResult(message);
        break;
      default:
        break;
    }
  }

  function acceptMessageUpdate(record: Record<string, unknown>): void {
    emitUsage(record.usage);
    const event = isRecord(record.assistantMessageEvent)
      ? record.assistantMessageEvent
      : undefined;
    if (!event || !stream) return;
    const index = typeof event.contentIndex === "number" ? event.contentIndex : 0;
    const kind = typeof event.type === "string" ? event.type : "";
    switch (kind) {
      case "text_start":
        stream.text.set(index, "");
        break;
      case "text_delta":
        stream.text.set(index, `${stream.text.get(index) ?? ""}${asText(event.delta)}`);
        emitAssistantText();
        break;
      case "text_end":
        stream.text.set(index, asText(event.content));
        emitAssistantText();
        break;
      case "thinking_start":
        stream.thinking.set(index, "");
        break;
      case "thinking_delta":
        stream.thinking.set(index, `${stream.thinking.get(index) ?? ""}${asText(event.delta)}`);
        emitReasoning(index);
        break;
      case "thinking_end":
        // Canonical field is the protocol `content`; `thinking` is a legacy
        // SuperPi-test alias. When both are present, `content` wins so a
        // merged summary+content pair is never concatenated here.
        stream.thinking.set(index, asText(event.content ?? event.thinking));
        emitReasoning(index);
        break;
      case "toolcall_start": {
        const tool = stream.tools.get(index) ?? { argsText: "", args: undefined };
        applyToolIdentity(tool, toolCallBlock(event, index));
        stream.tools.set(index, tool);
        emitTool(index);
        break;
      }
      case "toolcall_delta": {
        const tool = stream.tools.get(index);
        if (!tool) break;
        applyToolIdentity(tool, toolCallBlock(event, index));
        tool.argsText += asText(event.delta);
        const parsed = tryParseJson(tool.argsText);
        if (parsed !== undefined) tool.args = parsed;
        emitTool(index);
        break;
      }
      case "toolcall_end": {
        const tool = stream.tools.get(index) ?? { argsText: "", args: undefined };
        const call = isRecord(event.toolCall) ? event.toolCall : undefined;
        const block = toolCallBlock(event, index);
        const callId = asText(call?.id) || asText(block?.id) || tool.callId;
        if (!callId) break;
        tool.callId = callId;
        tool.name = asText(call?.name) || asText(block?.name) || tool.name;
        if (call?.arguments !== undefined) tool.args = call.arguments;
        else if (block?.arguments !== undefined) tool.args = block.arguments;
        else if (tool.args === undefined) tool.args = tryParseJson(tool.argsText);
        stream.tools.set(index, tool);
        emitTool(index);
        break;
      }
      default:
        break;
    }
  }

  function acceptMessageEnd(message: unknown, context: TimelineContext): void {
    applyMessage(message, context);
  }

  function applyMessage(message: unknown, context: TimelineContext = {}, emitUsageEvents = true): void {
    if (!isRecord(message)) return;
    if (emitUsageEvents) emitUsage(message.usage);
    switch (message.role) {
      case "user":
        upsertUser(message, context.clientMessageId);
        break;
      case "assistant":
        applyAssistant(message);
        break;
      case "toolResult":
        applyToolResult(message);
        break;
      default:
        break;
    }
  }

  /**
   * Canonical native identity shared by live folding, message completion, and
   * replay. Pi messages always carry `timestamp`; provider `responseId` values
   * may only surface at `message_end`, so timestamp outranks responseId to keep
   * the streaming item id stable when the authoritative message arrives.
   */
  function nativeMessageKey(message: Record<string, unknown>): string {
    return (
      idText(message.timestamp) ||
      idText(message.messageId) ||
      idText(message.responseId) ||
      "unknown"
    );
  }

  function applyAssistant(message: Record<string, unknown>): void {
    const nativeKey = nativeMessageKey(message);
    const content = Array.isArray(message.content) ? message.content : [];
    const joined = content
      .filter(isRecord)
      .filter((block) => block.type === "text")
      .map((block) => asText(block.text))
      .join("");
    let emittedText = false;
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index];
      if (!isRecord(block)) continue;
      if (block.type === "text") {
        if (!emittedText && joined.length > 0) {
          upsert(
            { type: "assistant_message", id: assistantItemId(nativeKey), text: joined },
            message.timestamp,
          );
          emittedText = true;
        }
      } else if (block.type === "thinking") {
        const thinking = canonicalThinkingText(block);
        if (thinking.length > 0) {
          upsert(
            {
              type: "reasoning",
              id: reasoningItemId(nativeKey, index),
              text: thinking,
            },
            message.timestamp,
          );
        }
      } else if (block.type === "toolCall") {
        const callId = asText(block.id);
        if (!callId) continue;
        upsertTool(callId, asText(block.name), block.arguments, undefined, undefined, "running", message.timestamp);
      }
    }
    if (stream && stream.nativeKey !== nativeKey) {
      for (const tool of stream.tools.values()) {
        if (tool.callId) remove(toolItemId(tool.callId));
      }
      remove(assistantItemId(stream.nativeKey));
      for (const index of stream.thinking.keys()) {
        remove(reasoningItemId(stream.nativeKey, index));
      }
    }
    stream = null;
  }

  function upsertUser(message: Record<string, unknown>, clientMessageId?: string): void {
    const id = userItemId(message, clientMessageId);
    const text = extractText(message.content);
    upsert(
      {
        type: "user_message",
        id,
        text,
        ...(asText(message.messageId) ? { messageId: asText(message.messageId) } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
      },
      message.timestamp,
    );
  }

  function emitAssistantText(): void {
    if (!stream) return;
    const text = joinIndexedText(stream.text);
    if (text.length === 0) return;
    upsert({ type: "assistant_message", id: assistantItemId(stream.nativeKey), text }, undefined);
  }

  function emitReasoning(index: number): void {
    if (!stream) return;
    const text = stream.thinking.get(index) ?? "";
    if (text.length === 0) return;
    upsert(
      { type: "reasoning", id: reasoningItemId(stream.nativeKey, index), text },
      undefined,
    );
  }

  function emitTool(index: number): void {
    if (!stream) return;
    const tool = stream.tools.get(index);
    if (!tool?.callId) return;
    upsertTool(tool.callId, tool.name ?? "", tool.args, undefined, undefined, "running", undefined);
  }

  function upsertTool(
    callId: string,
    name: string,
    args: unknown,
    output: string | undefined,
    error: unknown,
    status: "running" | "completed" | "canceled" | "failed",
    timestamp: unknown,
  ): void {
    if (args !== undefined) toolArgs.set(callId, args);
    const resolvedArgs = args !== undefined ? args : toolArgs.get(callId);
    if (name) toolNames.set(callId, name);
    const resolvedName = name || toolNames.get(callId) || "";
    const failed = status === "failed";
    upsert(
      {
        type: "tool_call",
        id: toolItemId(callId),
        callId,
        name: resolvedName,
        detail: mapToolDetail(resolvedName, resolvedArgs, output),
        status,
        error: failed ? (error ?? { message: output ?? "Tool failed" }) : null,
      } as ProviderTimelineItem,
      timestamp,
    );
  }

  function applyToolResult(message: Record<string, unknown>): void {
    const callId = asText(message.toolCallId);
    if (!callId) return;
    const failed = message.isError === true;
    upsertTool(
      callId,
      asText(message.toolName),
      undefined,
      extractResultText(message),
      isRecord(message.details) ? message.details : undefined,
      failed ? "failed" : "completed",
      message.timestamp,
    );
  }

  function acceptToolExecutionStart(record: Record<string, unknown>): void {
    const callId = asText(record.toolCallId);
    if (!callId) return;
    upsertTool(callId, asText(record.toolName), record.args, undefined, undefined, "running", undefined);
  }

  function acceptToolExecutionUpdate(record: Record<string, unknown>): void {
    const callId = asText(record.toolCallId);
    if (!callId) return;
    upsertTool(
      callId,
      asText(record.toolName),
      record.args,
      extractResultText(record.partialResult),
      undefined,
      "running",
      undefined,
    );
  }

  function acceptToolExecutionEnd(record: Record<string, unknown>): void {
    const callId = asText(record.toolCallId);
    if (!callId) return;
    const failed = record.isError === true;
    upsertTool(
      callId,
      asText(record.toolName),
      record.args,
      extractResultText(record.result),
      isRecord(record.details) ? record.details : undefined,
      failed ? "failed" : "completed",
      undefined,
    );
  }

  function replay(messages: readonly unknown[]): void {
    reset();
    for (const message of messages) applyMessage(message, {}, false);
  }

  function reset(): void {
    order.length = 0;
    byId.clear();
    toolArgs.clear();
    toolNames.clear();
    stream = null;
    activeTurnId = undefined;
    lastUsage = null;
    lastUsageKey = null;
  }

  return {
    sessionId,
    accept,
    replay,
    items: () => order.map((id) => byId.get(id)).filter((item): item is ProviderTimelineItem => Boolean(item)),
    usage: () => (lastUsage ? { ...lastUsage } : null),
    size: () => order.length,
    reset,
  };
}

interface StreamingTool {
  callId?: string;
  name?: string;
  argsText: string;
  args: unknown;
}

interface StreamingTurn {
  nativeKey: string;
  text: Map<number, string>;
  thinking: Map<number, string>;
  tools: Map<number, StreamingTool>;
}

/**
 * Pi's `toolcall_start`/`toolcall_delta` events carry only `{ contentIndex, partial }`;
 * the call id, name, and arguments live on the partial message's toolCall block.
 * Returns undefined until that block exists so no provisional row is published.
 */
function toolCallBlock(
  event: Record<string, unknown>,
  index: number,
): Record<string, unknown> | undefined {
  const partial = isRecord(event.partial) ? event.partial : undefined;
  const content = partial && Array.isArray(partial.content) ? partial.content : [];
  const block = content[index];
  return isRecord(block) && block.type === "toolCall" ? block : undefined;
}

function applyToolIdentity(tool: StreamingTool, block: Record<string, unknown> | undefined): void {
  if (!block) return;
  const callId = asText(block.id);
  const name = asText(block.name);
  if (callId) tool.callId = callId;
  if (name) tool.name = name;
  if (block.arguments !== undefined) tool.args = block.arguments;
}

export function assistantItemId(nativeKey: string): string {
  return `assistant:${nativeKey}`;
}

export function reasoningItemId(nativeKey: string, index: number): string {
  return `reasoning:${nativeKey}:${index}`;
}

export function toolItemId(callId: string): string {
  return `tool:${callId}`;
}

export function userItemId(message: Record<string, unknown>, _clientMessageId?: string): string {
  // Identity must match across live admission and replay. Pi user messages are
  // identified by their native timestamp; `clientMessageId` is preserved as a
  // field purely for optimistic correlation and never forms the id.
  const timestamp = idText(message.timestamp);
  if (timestamp) return `user:${timestamp}`;
  const messageId = idText(message.messageId);
  if (messageId) return `user:${messageId}`;
  return "user:unknown";
}

export function mapUsage(usage: unknown): ProviderUsage | null {
  if (!isRecord(usage)) return null;
  const mapped: ProviderUsage = {};
  const input = numberValue(usage.input);
  const cached = numberValue(usage.cacheRead);
  const output = numberValue(usage.output);
  const total = isRecord(usage.cost) ? numberValue(usage.cost.total) : undefined;
  if (input !== undefined) mapped.inputTokens = input;
  if (cached !== undefined) mapped.cachedInputTokens = cached;
  if (output !== undefined) mapped.outputTokens = output;
  if (total !== undefined) mapped.totalCostUsd = total;
  // Pi's streaming usage deltas do not carry context capacity today, but pass
  // the fields through when a future Pi (or bridge) reports them so the host
  // meter can use them without another adapter change.
  const maxTokens = numberValue(usage.contextWindowMaxTokens);
  const usedTokens = numberValue(usage.contextWindowUsedTokens);
  if (maxTokens !== undefined) mapped.contextWindowMaxTokens = maxTokens;
  if (usedTokens !== undefined) mapped.contextWindowUsedTokens = usedTokens;
  const hasSignal = Object.values(mapped).some((value) => value !== 0);
  return hasSignal ? mapped : null;
}

export function mapToolDetail(
  name: string,
  args: unknown,
  output?: string,
): ProviderToolCallDetail {
  const record = isRecord(args) ? args : {};
  const tool = name.toLowerCase();
  const filePath =
    asText(record.path) ||
    asText(record.filePath) ||
    asText(record.file_path) ||
    asText(record.filename);
  if (tool === "read") {
    return { type: "read", filePath, content: output };
  }
  if (tool === "bash" || tool === "shell" || tool === "execute" || tool === "run") {
    const exitCode = numberValue(record.exitCode);
    return {
      type: "shell",
      command: asText(record.command),
      ...(asText(record.cwd) ? { cwd: asText(record.cwd) } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }
  if (tool === "edit" || tool === "apply_patch" || tool === "str_replace") {
    const oldString = asText(record.oldText) || asText(record.old_string);
    const newString = asText(record.newText) || asText(record.new_string);
    const unifiedDiff = asText(record.diff) || asText(record.unifiedDiff);
    return {
      type: "edit",
      filePath,
      ...(oldString ? { oldString } : {}),
      ...(newString ? { newString } : {}),
      ...(unifiedDiff ? { unifiedDiff } : {}),
    };
  }
  if (tool === "write" || tool === "create_file") {
    return { type: "write", filePath, content: output ?? asText(record.content) };
  }
  if (
    tool === "grep" ||
    tool === "glob" ||
    tool === "search" ||
    tool === "web_search" ||
    tool === "find"
  ) {
    const toolName =
      tool === "grep" || tool === "glob" || tool === "web_search" ? tool : "search";
    return {
      type: "search",
      query: asText(record.pattern) || asText(record.query) || asText(record.glob),
      toolName,
      ...(output !== undefined ? { content: output } : {}),
    };
  }
  if (tool === "fetch" || tool === "web_fetch" || tool === "http") {
    return {
      type: "fetch",
      url: asText(record.url),
      ...(output !== undefined ? { result: output } : {}),
    };
  }
  if (tool === "agent" || tool === "subagent" || tool === "task") {
    return {
      type: "sub_agent",
      ...(asText(record.subagent_type) || asText(record.agent)
        ? { subAgentType: asText(record.subagent_type) || asText(record.agent) }
        : {}),
      ...(asText(record.description) || asText(record.prompt)
        ? { description: asText(record.description) || asText(record.prompt) }
        : {}),
      log: output ?? "",
    };
  }
  if (tool === "todo") {
    return { type: "plain_text", label: "Todo", text: output, icon: "sparkles" };
  }
  if (tool === "plan") {
    return { type: "plan", text: output ?? asText(record.text) };
  }
  return {
    type: "unknown",
    input: toJson(args),
    output: toJson(output),
  };
}

function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}

function extractResultText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = extractText(value);
    return text.length > 0 ? text : undefined;
  }
  if (isRecord(value)) {
    if (value.content !== undefined) {
      const text = extractResultText(value.content);
      if (text !== undefined) return text;
    }
    if (typeof value.text === "string") return value.text;
  }
  return undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) ? asText(block.text ?? block.thinking) : ""))
      .join("");
  }
  if (isRecord(content)) return asText(content.text ?? content.thinking);
  return "";
}

function joinIndexedText(map: Map<number, string>): string {
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .join("");
}

function tryParseJson(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Join display text from a Responses reasoning item's summary/content array. */
function joinReasoningTexts(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.text === "string" && entry.text.length > 0) parts.push(entry.text);
  }
  return parts.join("\n\n");
}

/**
 * Canonical display text for a final thinking block.
 *
 * Pi merges provider reasoning channels before SuperPi sees them, so a final
 * block's `thinking` string can hold a summary+content duplication for
 * Responses-style models. When the block carries the structured Responses
 * reasoning item in `thinkingSignature`, prefer its `summary` array (the
 * provider's display channel), then `content`. The signature itself is replay
 * metadata and is left untouched. Anything else falls back to the block's own
 * `thinking`/`text` field.
 */
function canonicalThinkingText(block: Record<string, unknown>): string {
  const fallback = asText(block.thinking ?? block.text);
  const signature = block.thinkingSignature;
  if (typeof signature !== "string" || signature.length === 0 || signature.length > 262144) {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(signature);
  } catch {
    return fallback;
  }
  if (!isRecord(parsed)) return fallback;
  const summaryText = joinReasoningTexts(parsed.summary);
  if (summaryText.length > 0) return summaryText;
  const contentText = joinReasoningTexts(parsed.content);
  if (contentText.length > 0) return contentText;
  return fallback;
}

function idText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
