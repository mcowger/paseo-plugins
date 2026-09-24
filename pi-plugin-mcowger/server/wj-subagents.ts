import type { ProviderEvent, ProviderTimelineItem, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import type { PiSessionEntry } from "./rpc-types.js";

const TOOL_NAMES = new Set([
  "get_agent_templates", "spawn_agent", "send_message", "wait_agent",
  "interrupt_agent", "terminate_agent", "get_agent_status", "get_agent_tree",
]);
const CHILD_TOOLS = new Set(["spawn_agent", "send_message", "wait_agent", "interrupt_agent", "terminate_agent", "get_agent_status"]);
const CONVERSATION_SCHEMA = "wj-pi-subagents/conversation";
const ACTIVITY_SCHEMA = "wj-pi-subagents.activity/1";
const TERMINAL_SCHEMA = "wj-pi-subagents/terminal";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_TEXT = 32_768;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_TEXT ? value : undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

function messageText(value: unknown): string | undefined {
  if (typeof value === "string") return text(value);
  if (!Array.isArray(value)) return undefined;
  return text(value.map((part) => record(part)?.type === "text" ? record(part)?.text : "").filter((part) => typeof part === "string").join("\n"));
}

function payload(value: unknown): RecordValue | null {
  const raw = messageText(value);
  if (!raw) return null;
  try { return record(JSON.parse(raw)); } catch { return null; }
}

function toolResponse(value: unknown): RecordValue | null {
  const outer = record(value);
  const detail = record(outer?.details);
  if (detail?.ok === true || detail?.ok === false) return detail;
  return payload(outer?.content ?? value);
}

function childIdFromResponse(value: unknown): string | undefined {
  const result = toolResponse(value);
  return result?.ok === true ? identifier(record(result.data)?.agent_id) : undefined;
}

interface Child {
  id: string;
  parentId?: string;
  toolCallId?: string;
  title?: string;
  description?: string;
  opened: boolean;
  finished: boolean;
  revision: number;
  incarnation?: string;
}

interface PendingTool {
  name: string;
  args: RecordValue;
}

export function isWjTool(name: string): boolean {
  return TOOL_NAMES.has(name);
}

export function wjToolDetail(name: string, args: unknown, result: unknown): ProviderToolCallDetail | null {
  if (!CHILD_TOOLS.has(name)) return null;
  const input = record(args);
  const agentId = identifier(input?.agent_id) ?? childIdFromResponse(result);
  const description = name === "spawn_agent"
    ? text(input?.name) ?? text(input?.template_id)
    : name === "send_message" ? "Message to subagent"
    : name === "wait_agent" ? "Waiting for child agents" : name.replaceAll("_", " ");
  return {
    type: "sub_agent",
    subAgentType: name === "spawn_agent" ? text(input?.template_id) : name,
    description,
    ...(agentId ? { childSessionId: `wj:${agentId}` } : {}),
    log: "",
  };
}

export class WjSubagents {
  private readonly children = new Map<string, Child>();
  private readonly tools = new Map<string, PendingTool>();
  private readonly pending = new Map<string, Array<{ item: ProviderTimelineItem; timestamp?: string }>>();

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly emit: (event: ProviderEvent) => void,
  ) {}

  static isAvailable(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    const names = new Set(value.map((tool) => typeof tool === "string" ? tool : record(tool)?.name));
    return [...TOOL_NAMES].every((name) => names.has(name));
  }

  rootToolStart(callId: string, name: string, args: unknown): void {
    if (!isWjTool(name)) return;
    this.tools.set(callId, { name, args: record(args) ?? {} });
  }

  rootToolEnd(callId: string, name: string, result: unknown): void {
    const tracked = this.tools.get(callId);
    this.tools.delete(callId);
    if (name === "get_agent_tree") this.ingestTree(toolResponse(result));
    if (name !== "spawn_agent" || tracked?.name !== name) return;
    const id = childIdFromResponse(result);
    if (!id) return;
    this.describe(id, {
      toolCallId: callId,
      title: text(tracked.args.name) ?? text(tracked.args.template_id),
      description: text(tracked.args.name),
    });
  }

  custom(customType: string | undefined, content: unknown): boolean {
    if (!customType?.startsWith("wj-pi-subagents-") || customType === "wj-pi-subagents-activity") return false;
    const data = payload(content);
    if (!data) return true;
    const id = identifier(data.agent_id);
    if (!id || data.version !== 1) return true;
    if (customType === "wj-pi-subagents-message" || customType === "wj-pi-subagents-final-report") {
      if (data.schema !== CONVERSATION_SCHEMA) return true;
      const value = text(data.text);
      if (!value) return true;
      this.timeline(id, { type: "assistant_message", id: `${id}:${customType}:${this.child(id).revision}`, text: value });
      if (customType === "wj-pi-subagents-final-report") this.finish(id);
    } else if (customType === "wj-pi-subagents-terminal" && data.schema === TERMINAL_SCHEMA) {
      if (data.state === "failed") this.finish(id, "failed");
      if (data.state === "terminated") this.finish(id, "canceled");
    }
    return true;
  }

  activityEntry(entry: PiSessionEntry): void {
    if (entry.type !== "custom" || entry.customType !== "wj-pi-subagents-activity") return;
    const data = record(entry.data);
    if (!data || data.schema !== ACTIVITY_SCHEMA || data.version !== 1 || data.kind !== "activity") return;
    const id = identifier(data.agent_id);
    const revision = data.revision;
    if (!id || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return;
    const child = this.child(id);
    const activity = record(data.entry);
    const incarnation = identifier(activity?.incarnation_id);
    if (incarnation && child.incarnation !== incarnation) {
      child.incarnation = incarnation;
      child.revision = -1;
    }
    if (revision <= child.revision) return;
    if (data.olderActivityOmitted === true && child.revision < 0) {
      this.timeline(id, { type: "notification", id: `${id}:history-gap`, level: "info", message: "Earlier subagent activity is unavailable" });
    }
    child.revision = revision;
    const body = record(activity?.body);
    if (!body) return;
    const type = text(body.type);
    const summary = record(body.summary);
    if (type === "tool_execution_start" || type === "tool_execution_end") {
      const toolCallId = text(body.toolCallId);
      const toolName = text(body.toolName);
      if (!toolCallId || !toolName) return;
      const parent = id;
      if (type === "tool_execution_start" && toolName === "spawn_agent") {
        this.tools.set(`${parent}:${toolCallId}`, { name: toolName, args: summary ?? {} });
      }
      if (type === "tool_execution_end" && toolName === "spawn_agent") {
        const tracked = this.tools.get(`${parent}:${toolCallId}`);
        this.tools.delete(`${parent}:${toolCallId}`);
        const spawned = identifier(summary?.agent_id) ?? childIdFromResponse(summary?.result);
        if (spawned) this.describe(spawned, { parentId: parent, toolCallId, title: text(tracked?.args.name) });
      }
      const relatedChildId = identifier(summary?.agent_id);
      const detail: ProviderToolCallDetail = CHILD_TOOLS.has(toolName)
        ? {
          type: "sub_agent", subAgentType: text(summary?.template_id) ?? toolName,
          description: text(summary?.name) ?? toolName,
          ...(relatedChildId ? { childSessionId: this.sessionIdFor(relatedChildId) } : {}),
          log: "",
        }
        : { type: "unknown", input: null, output: null };
      if (type === "tool_execution_start") {
        this.timeline(id, { type: "tool_call", id: toolCallId, callId: toolCallId, name: toolName, status: "running", detail, error: null });
      } else if (body.isError === true) {
        this.timeline(id, { type: "tool_call", id: toolCallId, callId: toolCallId, name: toolName, status: "failed", detail, error: text(body.errorText) ?? "Tool failed" });
      } else {
        this.timeline(id, { type: "tool_call", id: toolCallId, callId: toolCallId, name: toolName, status: "completed", detail, error: null });
      }
    } else if (type === "message" || type === "parent_message") {
      const value = messageText(body.content);
      if (value) this.timeline(id, { type: type === "message" ? "assistant_message" : "user_message", id: text(activity?.entry_id) ?? `${id}:${revision}`, text: value });
    } else if (type === "model_call_failure") {
      this.timeline(id, { type: "error", id: text(activity?.entry_id) ?? `${id}:${revision}`, message: text(body.message) ?? "Model call failed" });
    }
  }

  close(): void {
    for (const child of this.children.values()) {
      if (child.opened) this.emit({ type: "session.closed", sessionId: this.sessionIdFor(child.id) });
    }
    this.children.clear();
    this.tools.clear();
    this.pending.clear();
  }

  private child(id: string): Child {
    let child = this.children.get(id);
    if (!child) {
      child = { id, opened: false, finished: false, revision: -1 };
      this.children.set(id, child);
    }
    return child;
  }

  private ingestTree(value: RecordValue | null): void {
    const data = record(value?.data);
    const nodes = data?.agents ?? data?.nodes;
    if (!Array.isArray(nodes)) return;
    const rootIds = new Set(nodes.map(record)
      .filter((snapshot) => snapshot?.parent_agent_id === null)
      .map((snapshot) => identifier(snapshot?.agent_id))
      .filter((id): id is string => id !== undefined));
    const knownIds = new Set(nodes.map(record)
      .map((snapshot) => identifier(snapshot?.agent_id))
      .filter((id): id is string => id !== undefined));
    for (const node of nodes) {
      const snapshot = record(node);
      const id = identifier(snapshot?.agent_id);
      if (!id) continue;
      const parentId = identifier(snapshot?.parent_agent_id);
      if (!parentId) continue;
      this.describe(id, {
        ...(knownIds.has(parentId) && !rootIds.has(parentId) ? { parentId } : {}),
        title: text(snapshot?.name) ?? text(snapshot?.template_id),
      });
    }
  }

  private describe(id: string, change: Partial<Child>): void {
    const child = this.child(id);
    Object.assign(child, change);
    this.open(child);
  }

  private open(child: Child): void {
    if (child.opened) return;
    if (child.parentId && !this.children.get(child.parentId)?.opened) this.open(this.child(child.parentId));
    this.emit({
      type: "session.opened",
      sessionId: this.sessionIdFor(child.id),
      parentSessionId: child.parentId ? this.sessionIdFor(child.parentId) : this.sessionId,
      ...(child.toolCallId ? { toolCallId: child.toolCallId } : {}),
      capabilities: [],
      restoration: "parent",
      title: child.title ?? "Pi subagent",
      ...(child.description ? { description: child.description } : {}),
      cwd: this.cwd,
    });
    child.opened = true;
    this.emit({ type: "session.ready", sessionId: this.sessionIdFor(child.id) });
    this.emit({ type: "session.turn", sessionId: this.sessionIdFor(child.id), turnId: child.id, state: "started" });
    for (const event of this.pending.get(child.id) ?? []) {
      this.emit({ type: "timeline.item", sessionId: this.sessionIdFor(child.id), ...event });
    }
    this.pending.delete(child.id);
  }

  private timeline(id: string, item: ProviderTimelineItem): void {
    const child = this.child(id);
    if (child.finished) {
      child.finished = false;
      this.emit({ type: "session.turn", sessionId: this.sessionIdFor(id), turnId: id, state: "started" });
    }
    if (!child.opened) {
      this.pending.set(id, [...(this.pending.get(id) ?? []), { item }]);
      this.open(child);
      return;
    }
    this.emit({ type: "timeline.item", sessionId: this.sessionIdFor(id), item });
  }

  private finish(id: string, state: "completed" | "failed" | "canceled" = "completed"): void {
    const child = this.child(id);
    this.open(child);
    if (child.finished) return;
    child.finished = true;
    this.emit({ type: "session.turn", sessionId: this.sessionIdFor(id), turnId: id, state, ...(state === "failed" ? { error: { message: "Subagent failed" } } : {}) });
  }

  private sessionIdFor(id: string): string {
    return `wj:${id}`;
  }
}
