import type {
  ProviderEvent,
  ProviderTimelineItem,
  ProviderToolCallDetail,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

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
  /** Called once per tool name whose result details the mapping leaves unread. */
  onDiagnostic?: (diagnostic: ToolDetailDiagnostic) => void;
}): Timeline {
  const { sessionId, emit, onDiagnostic } = input;
  const order: string[] = [];
  const byId = new Map<string, ProviderTimelineItem>();
  const toolArgs = new Map<string, unknown>();
  const toolNames = new Map<string, string>();
  // One report per tool name per session: a diagnostic is a prompt to write a
  // parser, not a per-call event.
  const diagnosedTools = new Set<ToolDetailKind>();
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
    const event = isRecord(record.assistantMessageEvent) ? record.assistantMessageEvent : undefined;
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
        // PlexusPi-test alias. When both are present, `content` wins so a
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

  function applyMessage(
    message: unknown,
    context: TimelineContext = {},
    emitUsageEvents = true,
  ): void {
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
        const thinking = normalizeThinkingSnapshot(canonicalThinkingText(block));
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
        upsertTool(
          callId,
          asText(block.name),
          block.arguments,
          undefined,
          undefined,
          "running",
          message.timestamp,
        );
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
    const text = normalizeThinkingSnapshot(stream.thinking.get(index) ?? "");
    if (text.length === 0) return;
    upsert({ type: "reasoning", id: reasoningItemId(stream.nativeKey, index), text }, undefined);
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
    resultDetails?: unknown,
  ): void {
    if (args !== undefined) toolArgs.set(callId, args);
    const resolvedArgs = args !== undefined ? args : toolArgs.get(callId);
    if (name) toolNames.set(callId, name);
    const resolvedName = name || toolNames.get(callId) || "";
    const failed = status === "failed";
    reportUnreadDetails(resolvedName, resultDetails);
    if (isTodoToolName(resolvedName)) {
      const items = failed ? null : todoItemsFromDetails(resultDetails);
      if (items) {
        // The card replaces the tool row, the way Paseo's own providers do it:
        // "Created #3 …" would only repeat what the list already shows.
        upsert({ type: "todo", id: todoItemId(callId), items } as ProviderTimelineItem, timestamp);
        return;
      }
      // A running call has no list yet, and a placeholder row would outlive it.
      if (status === "running") return;
    }
    upsert(
      {
        type: "tool_call",
        id: toolItemId(callId),
        callId,
        name: resolvedName,
        detail: mapToolDetail(resolvedName, resolvedArgs, output, resultDetails),
        status,
        error: failed ? (error ?? { message: output ?? "Tool failed" }) : null,
      } as ProviderTimelineItem,
      timestamp,
    );
  }

  /** Tells the host which detail keys of a tool the mapping has no use for. */
  function reportUnreadDetails(tool: string, details: unknown): void {
    if (!onDiagnostic) return;
    const kind = toolDetailKind(tool);
    if (diagnosedTools.has(kind)) return;
    const diagnostic = toolDetailDiagnostic(tool, details);
    if (!diagnostic) return;
    diagnosedTools.add(kind);
    onDiagnostic(diagnostic);
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
      undefined,
      failed ? "failed" : "completed",
      message.timestamp,
      isRecord(message.details) ? message.details : undefined,
    );
  }

  function acceptToolExecutionStart(record: Record<string, unknown>): void {
    const callId = asText(record.toolCallId);
    if (!callId) return;
    upsertTool(
      callId,
      asText(record.toolName),
      record.args,
      undefined,
      undefined,
      "running",
      undefined,
    );
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
      record.error,
      failed ? "failed" : "completed",
      undefined,
      isRecord(record.details) ? record.details : undefined,
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
    items: () =>
      order.map((id) => byId.get(id)).filter((item): item is ProviderTimelineItem => Boolean(item)),
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

/** The mapping branch a tool name lands in; `unknown` means no branch handles it. */
export type ToolDetailKind =
  | "read"
  | "bash"
  | "edit"
  | "write"
  | "search"
  | "fetch"
  | "agent"
  | "todo"
  | "plan"
  | "unknown";

/** Pi tool names and their aliases, resolved to the branch that maps them. */
export function toolDetailKind(name: string): ToolDetailKind {
  const tool = name.trim().toLowerCase();
  if (tool === "read") return "read";
  if (tool === "bash" || tool === "shell" || tool === "execute" || tool === "run") return "bash";
  if (tool === "edit" || tool === "apply_patch" || tool === "str_replace") return "edit";
  if (tool === "write" || tool === "create_file") return "write";
  if (
    tool === "grep" ||
    tool === "glob" ||
    tool === "search" ||
    tool === "web_search" ||
    tool === "find"
  )
    return "search";
  if (tool === "fetch" || tool === "web_fetch" || tool === "http") return "fetch";
  if (tool === "agent" || tool === "subagent" || tool === "task") return "agent";
  if (tool === "todo") return "todo";
  if (tool === "plan") return "plan";
  return "unknown";
}

/**
 * Result-detail keys each branch actually reads. Everything else in a tool's
 * details is unread, which is what the diagnostic reports: a tool whose details
 * are mostly unread is a candidate for a real mapping.
 */
const CONSUMED_DETAIL_KEYS: Partial<Record<ToolDetailKind, readonly string[]>> = {
  edit: ["patch", "unifiedDiff"],
  agent: ["agentId", "sessionId"],
  todo: ["tasks"],
};

const MAX_DETAIL_FIELDS = 12;
const MAX_DETAIL_CHARS = 1_000;
const MAX_DETAIL_VALUE_CHARS = 120;

/** A flat, bounded view of result details for a tool no branch handles. */
export interface DetailProjection {
  fields: Record<string, string | number | boolean>;
  omitted: number;
}

/**
 * Reduce arbitrary result details to facts a person can scan: scalars as-is,
 * aggregates as counts, long strings clipped. This is not a JSON dump on purpose:
 * a row has to stay readable without the reader knowing the tool's schema.
 */
export function projectToolDetails(details: unknown): DetailProjection | null {
  if (!isRecord(details)) return null;
  const fields: Record<string, string | number | boolean> = {};
  let chars = 0;
  let omitted = 0;
  for (const [key, value] of Object.entries(details)) {
    const fact = detailFact(value);
    if (fact === undefined) continue;
    const next = chars + key.length + String(fact).length;
    if (Object.keys(fields).length >= MAX_DETAIL_FIELDS || next > MAX_DETAIL_CHARS) {
      omitted += 1;
      continue;
    }
    fields[key] = fact;
    chars = next;
  }
  return Object.keys(fields).length > 0 ? { fields, omitted } : null;
}

function detailFact(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    return text.length > MAX_DETAIL_VALUE_CHARS
      ? `${text.slice(0, MAX_DETAIL_VALUE_CHARS - 1)}…`
      : text;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0 ? countLabel(value.length, "item") : undefined;
  if (isRecord(value)) {
    const size = Object.keys(value).length;
    return size > 0 ? countLabel(size, "field") : undefined;
  }
  return undefined;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The log line a provider writes for a diagnostic; key names only, never values. */
export function formatToolDetailDiagnostic(diagnostic: ToolDetailDiagnostic): string {
  return `unconsumed tool details for "${diagnostic.tool}" (${diagnostic.kind}): ${diagnostic.unconsumed.join(", ")}`;
}

/** What the mapping did with a tool's result details, for the diagnostic log. */
export interface ToolDetailDiagnostic {
  tool: string;
  kind: ToolDetailKind;
  consumed: string[];
  unconsumed: string[];
}

export function toolDetailDiagnostic(tool: string, details: unknown): ToolDetailDiagnostic | null {
  if (!isRecord(details)) return null;
  const kind = toolDetailKind(tool);
  const consumed = CONSUMED_DETAIL_KEYS[kind] ?? [];
  const unconsumed = Object.keys(details).filter((key) => !consumed.includes(key));
  if (unconsumed.length === 0) return null;
  return { tool, kind, consumed: [...consumed], unconsumed };
}

/** One task card per todo call, so a replay re-folds the same item instead of adding one. */
export function todoItemId(callId: string): string {
  return `todo:${callId}`;
}

function isTodoToolName(name: string): boolean {
  return name.trim().toLowerCase() === "todo";
}

type TodoTimelineItem = Extract<ProviderTimelineItem, { type: "todo" }>;

/**
 * Pi reports the whole task list on the todo tool result:
 * `details.tasks: [{ id, subject, status, description }]`. It is a first-class
 * timeline item in the provider API, so the list renders as a task card instead
 * of a text row that can only describe one task.
 */
function todoItemsFromDetails(details: unknown): TodoTimelineItem["items"] | null {
  const record = isRecord(details) ? details : null;
  const tasks = record && Array.isArray(record.tasks) ? record.tasks : null;
  if (!tasks) return null;
  const items = tasks.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const text = asText(entry.subject) || asText(entry.text) || asText(entry.description);
    if (!text) return [];
    const status = todoStatus(entry.status);
    return [{ text, status, completed: status === "completed", id: todoTaskId(entry.id, index) }];
  });
  return items.length > 0 ? items : null;
}

function todoStatus(value: unknown): "pending" | "in_progress" | "completed" {
  return value === "completed" || value === "in_progress" ? value : "pending";
}

function todoTaskId(value: unknown, index: number): string {
  const id = numberValue(value);
  return String(id ?? index + 1);
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
  resultDetails?: unknown,
): ProviderToolCallDetail {
  const record = isRecord(args) ? args : {};
  // What the call actually did lives on the result for several tools; the
  // arguments only describe what was asked for.
  const details = isRecord(resultDetails) ? resultDetails : {};
  const tool = name.toLowerCase();
  const filePath =
    asText(record.path) ||
    asText(record.filePath) ||
    asText(record.file_path) ||
    asText(record.filename);
  if (tool === "read") {
    const offset = numberValue(record.offset);
    const limit = numberValue(record.limit);
    return {
      type: "read",
      filePath,
      ...(output !== undefined ? { content: output } : {}),
      // A slice of a file that does not say it is a slice reads as the whole file.
      ...(offset !== undefined && offset > 0 ? { offset } : {}),
      ...(limit !== undefined && limit > 0 ? { limit } : {}),
    };
  }
  if (tool === "bash" || tool === "shell" || tool === "execute" || tool === "run") {
    // No exit code: Pi reports one nowhere. Its bash args are `{ command, timeout }`
    // and the result details are null, so a shell row cannot show a status.
    return {
      type: "shell",
      command: asText(record.command),
      ...(asText(record.cwd) ? { cwd: asText(record.cwd) } : {}),
      ...(output !== undefined ? { output } : {}),
    };
  }
  if (tool === "edit" || tool === "apply_patch" || tool === "str_replace") {
    // Pi's edit tool takes `edits: [{ oldText, newText }, ...]` and reports the
    // applied change on the tool result as a unified `patch`. Reading only the
    // arguments left the row with a file path and nothing to expand.
    const edits = Array.isArray(record.edits) ? record.edits : [];
    // A single edit can stand in as an old/new pair; several cannot, because one
    // pair would report a smaller diff than the call actually made.
    const onlyEdit = edits.length === 1 && isRecord(edits[0]) ? edits[0] : {};
    const oldString =
      asText(record.oldText) || asText(record.old_string) || asText(onlyEdit.oldText);
    const newString =
      asText(record.newText) || asText(record.new_string) || asText(onlyEdit.newText);
    // `details.diff` is Pi's trimmed view with line-number prefixes, not a
    // unified diff: only `patch` (or an explicit unified diff) can be rendered.
    const unifiedDiff =
      asText(record.diff) ||
      asText(record.unifiedDiff) ||
      asText(details.patch) ||
      asText(details.unifiedDiff);
    return {
      type: "edit",
      filePath,
      ...(oldString ? { oldString } : {}),
      ...(newString ? { newString } : {}),
      ...(unifiedDiff ? { unifiedDiff } : {}),
    };
  }
  if (tool === "write" || tool === "create_file") {
    // The call carries the file; the result only reports that it landed
    // ("Successfully wrote to …"). Preferring the result put that confirmation
    // where the file body belongs.
    return { type: "write", filePath, content: asText(record.content) || output };
  }
  if (
    tool === "grep" ||
    tool === "glob" ||
    tool === "search" ||
    tool === "web_search" ||
    tool === "find"
  ) {
    const toolName = tool === "grep" || tool === "glob" || tool === "web_search" ? tool : "search";
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
    // The result reports the child this call started. Reading it from the log text
    // means parsing prose for an id Pi already states structurally.
    const childSessionId = asText(details.agentId) || asText(details.sessionId);
    return {
      type: "sub_agent",
      ...(asText(record.subagent_type) || asText(record.agent)
        ? { subAgentType: asText(record.subagent_type) || asText(record.agent) }
        : {}),
      ...(asText(record.description) || asText(record.prompt)
        ? { description: asText(record.description) || asText(record.prompt) }
        : {}),
      ...(childSessionId ? { childSessionId } : {}),
      log: output ?? "",
    };
  }
  if (tool === "todo") {
    return { type: "plain_text", label: "Todo", text: output, icon: "sparkles" };
  }
  if (tool === "plan") {
    return { type: "plan", text: output ?? asText(record.text) };
  }
  // A tool no branch handles still reports what it did in its details. Carry a
  // bounded, flat view of them so the row can show facts instead of JSON soup.
  const projection = projectToolDetails(details);
  return {
    type: "unknown",
    input: toJson(args),
    output: projection
      ? (toJson({
          content: output ?? "",
          details: projection.fields,
          ...(projection.omitted > 0 ? { detailsOmitted: projection.omitted } : {}),
        }) as JsonValue)
      : toJson(output),
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

/**
 * Strip trailing whitespace from an emitted thinking snapshot.
 *
 * Pi appends `"\n\n"` to the streaming thinking block for every Responses
 * summary part (`response.reasoning_summary_part.done`), but the final
 * `output_item.done` overwrite joins summary parts with no trailing
 * separator. The host diffs provider snapshots by prefix and concatenates
 * adjacent reasoning rows, so a final snapshot shorter than the streamed one
 * is appended as a second row and renders the same paragraph twice.
 * Trimming trailing whitespace keeps every snapshot prefix-monotonic so the
 * final collapses onto the streamed rows instead of duplicating them.
 */
function normalizeThinkingSnapshot(text: string): string {
  return text.replace(/\s+$/, "");
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
 * Pi merges provider reasoning channels before PlexusPi sees them, so a final
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
