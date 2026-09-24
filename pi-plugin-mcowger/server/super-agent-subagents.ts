import type { ProviderEvent, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

import type { PiSessionEntry } from "./rpc-types.js";
import { ProviderSubagentProjector } from "./subagent-projector.js";
import {
  extractTextFromToolResult,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
  type PiToolResult,
  type PiTrackedToolCall,
} from "./tool-call-mapper.js";

const TOOLS = new Set(["agent", "agent_wait", "agent_stop", "agent_status"]);
const EVENT_TYPE = "super-agents-event";
const RESULT_TYPE = "super-agents-result";
const RUN_ID = /^[a-z0-9]{8}$/u;
const MAX_TEXT = 32_768;
const MAX_RESULT_TEXT = 131_072;
const REPORT_HEADER = /^### (.+?) \(([^)\n]+)\) — (completed|failed|aborted|turn_limited) \[id: ([a-z0-9]{8})\]\r?\n/gmu;

type Value = Record<string, unknown>;
type RunStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "turn_limited";

function record(value: unknown): Value | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_TEXT ? value : undefined;
}

function runId(value: unknown): string | undefined {
  return typeof value === "string" && RUN_ID.test(value) ? value : undefined;
}

function status(value: unknown): RunStatus | undefined {
  return value === "queued" || value === "running" || value === "completed"
    || value === "failed" || value === "aborted" || value === "turn_limited" ? value : undefined;
}

function resultText(value: unknown): string | undefined {
  const raw = record(value);
  const content = raw?.content ?? value;
  if (typeof content === "string") return content.length <= MAX_RESULT_TEXT ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts = content.map((part) => record(part))
    .filter((part) => part?.type === "text")
    .map((part) => typeof part?.text === "string" ? part.text : undefined)
    .filter((part): part is string => part !== undefined);
  const joined = parts.join("\n");
  return joined.length <= MAX_RESULT_TEXT ? joined : undefined;
}

function toolResult(value: unknown): PiToolResult {
  const raw = record(value);
  if (raw && typeof raw.content === "string") {
    return parseToolResult({
      ...raw,
      content: [{ type: "text", text: raw.content }],
    });
  }
  return parseToolResult(value);
}

function toolError(result: PiToolResult): string {
  const output = extractTextFromToolResult(result);
  return output !== undefined && output.length <= MAX_RESULT_TEXT ? output : "Tool failed";
}

function runs(value: unknown): Value[] {
  const details = record(record(value)?.details);
  return Array.isArray(details?.runs) ? details.runs.map(record).filter((run): run is Value => run !== null) : [];
}

function reports(content: string): Map<string, { name: string; slug: string; status: RunStatus; body: string }> {
  const headers = [...content.matchAll(REPORT_HEADER)];
  const parsed = new Map<string, { name: string; slug: string; status: RunStatus; body: string }>();
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const id = runId(header[4]);
    const name = text(header[1]);
    const slug = text(header[2]);
    const state = status(header[3]);
    if (!id || !name || !slug || !state) continue;
    const body = content.slice(header.index! + header[0].length, headers[index + 1]?.index ?? content.length).trim();
    parsed.set(id, { name, slug, status: state, body: body.slice(0, MAX_TEXT) });
  }
  return parsed;
}

export class SuperAgentSubagents {
  private readonly projector: ProviderSubagentProjector;
  private readonly sequences = new Map<string, number>();
  private readonly reported = new Map<string, string>();
  private readonly liveBodies = new Map<string, Set<string>>();
  private readonly truncated = new Set<string>();
  private readonly pendingToolCalls = new Map<string, PiTrackedToolCall>();
  private pendingResults: Array<{ result: unknown; toolCallId: string | undefined }> | null = null;
  private readonly emit: (event: ProviderEvent) => void;

  constructor(sessionId: string, cwd: string, emit: (event: ProviderEvent) => void) {
    this.emit = emit;
    this.projector = new ProviderSubagentProjector("super-agents", sessionId, cwd, emit);
  }

  static isAvailable(names: ReadonlySet<string>): boolean {
    return [...TOOLS].every((name) => names.has(name));
  }

  handlesTool(name: string): boolean {
    return TOOLS.has(name);
  }

  toolDetail(name: string, args: unknown, result: unknown): ProviderToolCallDetail | null {
    if (!this.handlesTool(name) || name === "agent_status") return null;
    const tasks = record(args)?.tasks;
    const task = Array.isArray(tasks) && tasks.length === 1 ? record(tasks[0]) : null;
    const summaries = runs(result);
    const single = summaries.length === 1 ? summaries[0] : null;
    const id = runId(single?.id);
    return {
      type: "sub_agent",
      subAgentType: text(task?.agent) ?? text(single?.slug) ?? name,
      description: text(task?.name) ?? text(single?.name) ?? (name === "agent" ? "Run sub-agents" : name.replaceAll("_", " ")),
      ...(id ? { childSessionId: this.projector.sessionId(id) } : {}),
      log: "",
    };
  }

  rootToolStart(_callId: string, _name: string, _args: unknown): void {}

  rootToolEnd(callId: string, name: string, result: unknown): void {
    if (!this.handlesTool(name)) return;
    const toolCallId = name === "agent" ? callId : undefined;
    if (this.pendingResults) this.pendingResults.push({ result, toolCallId });
    else this.ingestResult(result, toolCallId);
  }

  handlesCustomMessage(customType: string | undefined): boolean {
    return customType === RESULT_TYPE;
  }

  custom(customType: string | undefined, content: unknown): boolean {
    if (customType !== RESULT_TYPE) return false;
    if (this.pendingResults) this.pendingResults.push({ result: { content }, toolCallId: undefined });
    else this.ingestResult({ content }, undefined);
    return true;
  }

  beginReplay(): void {
    this.pendingResults = [];
  }

  endReplay(): void {
    const pending = this.pendingResults ?? [];
    this.pendingResults = null;
    for (const item of pending) this.ingestResult(item.result, item.toolCallId);
  }

  activityEntry(entry: PiSessionEntry): void {
    if (entry.type !== "custom" || entry.customType !== EVENT_TYPE) return;
    const data = record(entry.data);
    const id = runId(data?.agentId);
    const seq = data?.seq;
    if (data?.v !== 1 || !id || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0
      || typeof data?.parentToolCallId !== "string" || !data.parentToolCallId) return;
    if (data.kind !== "lifecycle" && data.kind !== "session") return;
    if (data.kind === "lifecycle" && data.phase !== "queued" && data.phase !== "started" && data.phase !== "finished") return;
    if (data.kind === "session" && typeof record(data.event)?.type !== "string") return;
    if (seq <= (this.sequences.get(id) ?? -1)) return;
    this.sequences.set(id, seq);
    this.projector.describe(id, {
      title: text(data.name) ?? text(data.slug),
      description: text(data.slug),
      toolCallId: text(data.parentToolCallId),
    });
    if (data.kind === "lifecycle") {
      if (data.phase === "finished") this.finish(id, record(data.data)?.status);
      return;
    }
    const event = record(data.event);
    if (event?.type === "message_end") {
      const message = record(event.message);
      const body = text(resultText(message?.content));
      // Prose that never fits the bounds is dropped entirely: surface the
      // loss here (tool I/O, lifecycle, and progress shrinkage stays silent).
      if (!body) {
        this.markTruncated(id);
        return;
      }
      const role = message?.role;
      if (role !== "assistant" && role !== "user") return;
      // The terminal report carries the same final prose: skip live text
      // already delivered via a report, regardless of arrival order.
      if (role === "assistant" && this.reported.get(id) === body.trim()) return;
      this.projector.timeline(id, {
        type: role === "assistant" ? "assistant_message" : "user_message",
        id: `${id}:event:${seq}`, text: body,
      }, false);
      if (role === "assistant") this.trackLiveBody(id, body);
      if (data.truncated === true) this.markTruncated(id);
    } else if (event?.type === "tool_execution_start" || event?.type === "tool_execution_end") {
      const callId = text(event.toolCallId);
      const toolName = text(event.toolName);
      if (!callId || !toolName) return;
      const key = `${id}:${callId}`;
      const isStart = event.type === "tool_execution_start";
      const tracked = isStart
        ? parseToolArgs(toolName, event.args)
        : this.pendingToolCalls.get(key) ?? parseToolArgs(toolName, event.args);
      const result = isStart ? null : toolResult(event.result);
      if (isStart) this.pendingToolCalls.set(key, tracked);
      else this.pendingToolCalls.delete(key);
      const base = {
        type: "tool_call" as const,
        id: `${id}:${callId}`,
        callId: `${id}:${callId}`,
        name: resolveToolCallName(tracked, result),
        detail: mapToolDetail(tracked, result),
      };
      if (isStart) {
        this.projector.timeline(id, { ...base, status: "running", error: null }, false);
      } else if (event.isError === true) {
        this.projector.timeline(id, {
          ...base, status: "failed", error: toolError(result),
        }, false);
      } else {
        this.projector.timeline(id, { ...base, status: "completed", error: null }, false);
      }
    }
  }

  close(): void {
    this.projector.close();
    this.sequences.clear();
    this.reported.clear();
    this.liveBodies.clear();
    this.truncated.clear();
    this.pendingToolCalls.clear();
    this.pendingResults = null;
  }

  private ingestResult(result: unknown, toolCallId: string | undefined): void {
    const content = resultText(result);
    const sections = reports(content ?? "");
    const summaries = runs(result);
    for (const [id, section] of sections) {
      if (!summaries.some((summary) => summary.id === id)) summaries.push({ id, ...section });
    }
    for (const summary of summaries) {
      const id = runId(summary.id);
      if (!id) continue;
      const section = sections.get(id);
      this.projector.describe(id, {
        title: text(summary.name) ?? section?.name,
        description: text(summary.slug) ?? section?.slug,
        ...(toolCallId ? { toolCallId } : {}),
      });
      // The terminal report duplicates the final live assistant message, so
      // skip report text already shown live. Children with no live events
      // (telemetry disabled) still get their result from the report.
      if (section?.body && !this.liveBodies.get(id)?.has(section.body) && this.reported.get(id) !== section.body) {
        this.reported.set(id, section.body);
        this.projector.timeline(id, { type: "assistant_message", id: `${id}:result`, text: section.body }, false);
      }
      const usage = record(summary.usage);
      const tokens = record(usage?.tokens);
      const inputTokens = tokens?.input;
      const outputTokens = tokens?.output;
      const cost = usage?.cost;
      if (typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens >= 0
        && typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens >= 0) {
        this.emit({
          type: "session.usage", sessionId: this.projector.sessionId(id), turnId: id,
          usage: {
            inputTokens, outputTokens,
            ...(typeof tokens?.cacheRead === "number" && Number.isFinite(tokens.cacheRead) && tokens.cacheRead >= 0
              ? { cachedInputTokens: tokens.cacheRead } : {}),
            ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { totalCostUsd: cost } : {}),
          },
        });
      }
      this.finish(id, summary.status, text(summary.error));
    }
  }

  private trackLiveBody(id: string, body: string): void {
    let bodies = this.liveBodies.get(id);
    if (!bodies) {
      bodies = new Set();
      this.liveBodies.set(id, bodies);
    }
    bodies.add(body.trim());
  }

  // Truncation banners are scoped to message prose: tool I/O, lifecycle, and
  // progress events shrink routinely (and recover via terminal reports), so
  // flagging those would warn on nearly every run with large tool output.
  private markTruncated(id: string): void {
    if (this.truncated.has(id)) return;
    this.truncated.add(id);
    this.projector.timeline(id, {
      type: "notification", id: `${id}:truncated`, level: "info",
      message: "Some subagent activity was truncated",
    }, false);
  }

  private finish(id: string, raw: unknown, error?: string): void {
    const state = status(raw);
    if (state === "completed") this.projector.finish(id);
    else if (state === "aborted") this.projector.finish(id, "canceled");
    else if (state === "failed" || state === "turn_limited") {
      this.projector.finish(id, "failed", error ?? (state === "turn_limited" ? "Subagent turn limit reached" : undefined));
    }
  }
}
