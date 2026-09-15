import { createHash } from "node:crypto";

import type { ProviderConfigState, ProviderEvent, ProviderTimelineItem, ProviderToolCallDetail, ProviderUsage } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const MAX_SUBAGENT_CHILDREN_PER_TOOL = 128;
const MAX_SUBAGENT_CHILDREN_PER_SESSION = 1_024;
const MAX_SUBAGENT_TEXT_BYTES = 64 * 1024;
const MAX_SUBAGENT_TOOL_ARGS_BYTES = 16 * 1024;
const MAX_SUBAGENT_RECENT_OUTPUT_ITEMS = 32;
const MAX_SUBAGENT_RECENT_TOOLS = 128;

const progressSchema = z.object({
  index: z.number().int().nonnegative(),
  agent: z.string().min(1),
  sessionName: z.string().optional(),
  task: z.string().optional(),
  status: z.string().optional(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  tokens: z.number().optional(),
  durationMs: z.number().optional(),
  currentTool: z.string().optional(),
  currentToolArgs: z.string().optional(),
  currentToolStartedAt: z.number().optional(),
  currentPath: z.string().optional(),
  toolCount: z.number().optional(),
  turnCount: z.number().optional(),
  window: z.number().optional(),
  windowPeak: z.number().optional(),
  lastActivityAt: z.number().optional(),
  recentTools: z.array(z.object({ tool: z.string().min(1), args: z.string().optional(), endMs: z.number().optional() }).strip()).optional(),
  recentOutput: z.array(z.string()).optional(),
}).strip();

const usageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  cost: z.number().optional(),
  turns: z.number().optional(),
}).strip();

const resultSchema = z.object({
  index: z.number().int().nonnegative(),
  workflowKey: z.string().min(1).optional(),
  agent: z.string().min(1),
  sessionName: z.string().optional(),
  task: z.string().optional(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  usage: usageSchema.optional(),
  exitCode: z.number().optional(),
  error: z.string().optional(),
  finalOutput: z.string().optional(),
  toolCalls: z.array(z.object({ text: z.string().optional(), expandedText: z.string().optional() }).strip()).optional(),
  progressSummary: z.object({
    toolCount: z.number().optional(),
    tokens: z.number().optional(),
    durationMs: z.number().optional(),
  }).strip().optional(),
  progress: progressSchema.optional(),
}).strip();

const workflowChildActivitySchema = z.object({
  currentTool: z.string().optional(),
  currentToolStartedAt: z.number().optional(),
  lastActivityAt: z.number().optional(),
  durationMs: z.number().optional(),
  toolCount: z.number().optional(),
  turnCount: z.number().optional(),
  tokens: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
}).strip();

const workflowChildSchema = z.object({
  childId: z.string().min(1),
  agent: z.string().min(1).optional(),
  sessionName: z.string().optional(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  state: z.string().optional(),
  activity: workflowChildActivitySchema.optional(),
}).strip();

interface ChildUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  turns?: number;
}

interface ChildSnapshot {
  identity: string;
  index: number;
  workflowKey?: string;
  agent: string;
  sessionName?: string;
  task?: string;
  status?: string;
  model?: string;
  thinking?: string;
  inputTokens?: number;
  outputTokens?: number;
  tokens?: number;
  durationMs?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  toolCount?: number;
  turnCount?: number;
  window?: number;
  windowPeak?: number;
  lastActivityAt?: number;
  recentTools: Array<{ tool: string; args?: string; endMs?: number }>;
  recentOutput: string[];
  usage?: ChildUsage;
  exitCode?: number;
  error?: string;
  content?: string;
  contentFromEnvelope?: boolean;
  toolCalls: Array<{ text?: string; expandedText?: string }>;
}

interface ActiveTool {
  id: string;
  name: string;
  args?: string;
  startedAt?: number;
}

interface RecordedTool {
  id: string;
  name: string;
  args?: string;
  detail: ProviderToolCallDetail;
}

interface RecordedToolState extends RecordedTool {
  status: "running" | "completed" | "failed";
}

interface ChildState {
  key: string;
  sessionId: string;
  parentToolCallId: string;
  turnId: string;
  title: string;
  description?: string;
  status: "running" | "completed" | "failed" | "canceled";
  opened: boolean;
  ready: boolean;
  started: boolean;
  terminal: boolean;
  model?: string;
  thinking?: string;
  activeTool?: ActiveTool;
  recentToolFingerprints: Set<string>;
  recordedTools: Map<string, RecordedToolState>;
  lastPreview?: string;
  lastUsage?: ProviderUsage;
  promptPublished: boolean;
}

interface PendingDelegation {
  parentToolCallId: string;
  candidate: boolean;
  task?: string;
  children: Set<string>;
  terminal: boolean;
}

interface ParsedDetails {
  runId: string;
  children: ChildSnapshot[];
  hasChildFinalOutput: boolean;
  workflow: boolean;
}

export class NicoSubagentProjector {
  private readonly pending = new Map<string, PendingDelegation>();
  private readonly children = new Map<string, ChildState>();
  private readonly parentLinks = new Map<string, string>();
  private readonly bufferedEvents: ProviderEvent[] = [];
  private rootReady = false;
  private closed = false;

  constructor(
    private readonly options: {
      rootSessionId: string;
      cwd: string;
      enabled: boolean;
      emit(event: ProviderEvent): void;
    },
  ) {}

  markRootReady(): void {
    this.rootReady = true;
    for (const event of this.bufferedEvents.splice(0)) this.options.emit(event);
  }

  parentChildSessionId(parentToolCallId: string): string | undefined {
    return this.parentLinks.get(parentToolCallId);
  }

  observeStart(toolCallId: string, toolName: string, args: unknown): void {
    if (!this.options.enabled || toolName !== "subagent" || !isObject(args)) return;
    const task = typeof args.task === "string" ? truncate(args.task) : undefined;
    this.pending.set(toolCallId, { parentToolCallId: toolCallId, candidate: true, task, children: new Set(), terminal: false });
  }

  observeUpdate(toolCallId: string, value: unknown): void {
    if (!this.options.enabled) return;
    const details = parseDetails(value, true);
    if (!details) return;
    this.fold(toolCallId, details, value, false);
  }

  observeEnd(toolCallId: string, value: unknown, isError: boolean): void {
    if (!this.options.enabled) return;
    const details = parseDetails(value, true);
    if (details) this.fold(toolCallId, details, value, true, isError ? "failed" : undefined);
    const delegation = this.pending.get(toolCallId);
    if (!delegation) return;
    delegation.terminal = true;
    for (const key of delegation.children) {
      const child = this.children.get(key);
      if (child && !child.terminal) this.finishChild(child, isError ? "failed" : "completed");
    }
  }

  observeHistory(toolCallId: string, toolName: string, value: unknown, isError = false): void {
    if (!this.options.enabled || toolName !== "subagent") return;
    this.observeStart(toolCallId, toolName, {});
    this.observeEnd(toolCallId, value, isError);
  }

  cancelActive(): void {
    for (const child of this.children.values()) {
      if (!child.terminal) this.finishChild(child, "canceled");
    }
    this.clear();
  }

  finishActive(status: "completed" | "failed"): void {
    for (const child of this.children.values()) {
      if (!child.terminal) this.finishChild(child, status);
    }
  }

  clear(): void {
    this.pending.clear();
    this.children.clear();
    this.parentLinks.clear();
    this.bufferedEvents.length = 0;
    this.closed = true;
  }

  private fold(toolCallId: string, details: ParsedDetails, raw: unknown, terminal: boolean, terminalStatusOverride?: ChildState["status"]): void {
    if (this.closed) return;
    const delegation = this.pending.get(toolCallId) ?? {
      parentToolCallId: toolCallId,
      candidate: false,
      children: new Set<string>(),
      terminal: false,
    };
    delegation.candidate = true;
    this.pending.set(toolCallId, delegation);
    const snapshots = details.children.slice(0, MAX_SUBAGENT_CHILDREN_PER_TOOL);
    for (const snapshot of snapshots) {
      const key = childKey(details.runId, snapshot);
      if (delegation.children.size >= MAX_SUBAGENT_CHILDREN_PER_TOOL && !delegation.children.has(key)) continue;
      if (!delegation.children.has(key) && this.children.size >= MAX_SUBAGENT_CHILDREN_PER_SESSION) continue;
      delegation.children.add(key);
      let child = this.children.get(key);
      if (!child) {
        child = this.openChild(key, snapshot, toolCallId, delegation.task, terminal || hasTerminalEvidence(snapshot));
        this.children.set(key, child);
      }
      this.updateChild(child, snapshot, terminal, raw, terminalStatusOverride, details.hasChildFinalOutput);
    }
  }

  private openChild(key: string, snapshot: ChildSnapshot, parentToolCallId: string, task: string | undefined, terminal: boolean): ChildState {
    const sessionId = `pi:subsession:${hash(`${this.options.rootSessionId}:${key}`)}`;
    const child: ChildState = {
      key,
      sessionId,
      parentToolCallId,
      turnId: `${sessionId}:turn`,
      title: snapshot.agent,
      ...(snapshot.sessionName && snapshot.sessionName !== snapshot.agent ? { description: snapshot.sessionName } : {}),
      status: terminal ? terminalStatus(snapshot) : "running",
      opened: false,
      ready: false,
      started: false,
      terminal: false,
      recentToolFingerprints: new Set(),
      recordedTools: new Map(),
      promptPublished: false,
    };
    this.emit({ type: "session.opened", sessionId, parentSessionId: this.options.rootSessionId, capabilities: [], restoration: "parent", cwd: this.options.cwd, title: child.title, ...(child.description ? { description: child.description } : {}) });
    child.opened = true;
    this.emit({ type: "session.ready", sessionId });
    child.ready = true;
    if (!terminal || hasTerminalEvidence(snapshot)) this.startChild(child);
    this.publishPrompt(child, task ?? visibleTask(snapshot.task));
    if (!this.parentLinks.has(parentToolCallId)) this.parentLinks.set(parentToolCallId, sessionId);
    return child;
  }

  private updateChild(child: ChildState, snapshot: ChildSnapshot, terminal: boolean, raw: unknown, terminalStatusOverride?: ChildState["status"], hasChildFinalOutput = false): void {
    if (child.terminal) return;
    child.title = snapshot.agent;
    child.description = snapshot.sessionName && snapshot.sessionName !== snapshot.agent ? snapshot.sessionName : undefined;
    this.publishPrompt(child, visibleTask(snapshot.task));
    if (snapshot.model !== child.model || snapshot.thinking !== child.thinking) {
      child.model = snapshot.model ?? child.model;
      child.thinking = snapshot.thinking ?? child.thinking;
      this.emitConfig(child);
    }
    const recordedTools = snapshot.toolCalls
      .map((tool, index) => parseRecordedTool(child, tool, index))
      .filter((tool): tool is RecordedTool => tool !== undefined);
    const currentTool = snapshot.currentTool
      ? activeTool(child, snapshot.currentTool, snapshot.currentToolArgs, snapshot.currentToolStartedAt)
      : undefined;
    const currentRecordedTool = currentTool && findCurrentRecordedTool(recordedTools, currentTool);
    const fallbackActiveTool = currentRecordedTool ? undefined : currentTool;
    if (!sameTool(fallbackActiveTool, child.activeTool)) {
      if (child.activeTool) this.emitChildTool(child, child.activeTool, "completed");
      child.activeTool = fallbackActiveTool;
      if (fallbackActiveTool) this.emitChildTool(child, fallbackActiveTool, "running");
    }
    const recentTools = snapshot.recentTools.slice(0, MAX_SUBAGENT_RECENT_TOOLS);
    for (const tool of recordedTools) {
      const status = recordedToolStatus(tool, currentRecordedTool, recentTools, terminal || isTerminalStatus(snapshot.status), terminalStatusOverride);
      this.emitRecordedTool(child, tool, status);
    }
    for (const tool of recentTools) {
      if (recordedTools.some((recorded) => recordedMatchesSummary(recorded, tool))) continue;
      const fingerprint = JSON.stringify(tool);
      if (child.recentToolFingerprints.has(fingerprint)) continue;
      child.recentToolFingerprints.add(fingerprint);
      if (equivalentToolName(child.activeTool?.name, tool.tool) && (!child.activeTool?.startedAt || !tool.endMs || tool.endMs >= child.activeTool.startedAt)) {
        if (child.activeTool) this.emitChildTool(child, child.activeTool, "completed");
        child.activeTool = undefined;
      } else {
        this.emitChildTool(child, activeTool(child, tool.tool, tool.args, tool.endMs), "completed");
      }
    }
    if (snapshot.content && !(terminal && snapshot.contentFromEnvelope && !hasChildFinalOutput)) {
      const preview = truncate(snapshot.content);
      if (preview && preview !== child.lastPreview) {
        child.lastPreview = preview;
        this.timeline(child, { type: "assistant_message", id: `${child.sessionId}:assistant-preview`, messageId: `${child.sessionId}:assistant-preview`, text: preview });
      }
    }
    const usage = mapChildUsage(snapshot);
    if (usage) {
      const nextUsage = preferProviderUsage(child.lastUsage, usage);
      if (JSON.stringify(nextUsage) !== JSON.stringify(child.lastUsage)) {
        child.lastUsage = nextUsage;
        this.emit({ type: "session.usage", sessionId: child.sessionId, turnId: child.turnId, usage: nextUsage });
      }
    }
    if (terminalStatusOverride) this.finishChild(child, terminalStatusOverride);
    else if (terminal || isTerminalStatus(snapshot.status)) this.finishChild(child, terminalStatus(snapshot));
    void raw;
  }

  private startChild(child: ChildState): void {
    if (child.started || child.terminal) return;
    child.started = true;
    this.emit({ type: "session.turn", sessionId: child.sessionId, turnId: child.turnId, state: "started" });
  }

  private finishChild(child: ChildState, status: ChildState["status"]): void {
    if (child.terminal) return;
    if (child.activeTool) {
      this.emitChildTool(child, child.activeTool, status === "failed" ? "failed" : "completed");
      child.activeTool = undefined;
    }
    for (const tool of child.recordedTools.values()) {
      if (tool.status === "running") {
        const recordedStatus = status === "failed" ? "failed" : "completed";
        tool.status = recordedStatus;
        this.emitToolTimeline(child, tool.id, tool.name, tool.detail, recordedStatus);
      }
    }
    this.startChild(child);
    child.status = status;
    child.terminal = true;
    this.emit({ type: "session.turn", sessionId: child.sessionId, turnId: child.turnId, state: status === "running" ? "started" : status, ...(status === "failed" ? { error: { message: "Subagent failed" } } : {}) });
  }

  private emitConfig(child: ChildState): void {
    const config: ProviderConfigState = { ...(child.model ? { model: child.model } : {}), ...(child.thinking ? { thinkingOption: child.thinking } : {}), models: [], modes: [], thinkingOptions: [], settings: [] };
    this.emit({ type: "session.config", sessionId: child.sessionId, config });
  }

  private emitChildTool(child: ChildState, tool: ActiveTool, status: "running" | "completed" | "failed"): void {
    this.emitToolTimeline(child, tool.id, tool.name, mapSummaryTool(tool), status);
  }

  private publishPrompt(child: ChildState, task: string | undefined): void {
    if (child.promptPublished || !task?.trim()) return;
    child.promptPublished = true;
    this.timeline(child, { type: "user_message", id: `${child.sessionId}:prompt`, messageId: `${child.sessionId}:prompt`, text: truncate(task) });
  }

  private emitRecordedTool(child: ChildState, tool: RecordedTool, status: "running" | "completed" | "failed"): void {
    const previous = child.recordedTools.get(tool.id);
    if (previous?.status === status) return;
    child.recordedTools.set(tool.id, { ...tool, status });
    this.emitToolTimeline(child, tool.id, tool.name, tool.detail, status);
  }

  private emitToolTimeline(child: ChildState, id: string, name: string, detail: ProviderToolCallDetail, status: "running" | "completed" | "failed"): void {
    if (status === "failed") {
      this.timeline(child, { type: "tool_call", id, callId: id, name, detail, status, error: "Subagent failed" });
      return;
    }
    this.timeline(child, { type: "tool_call", id, callId: id, name, detail, status, error: null });
  }

  private timeline(child: ChildState, item: ProviderTimelineItem): void {
    this.emit({ type: "timeline.item", sessionId: child.sessionId, item });
  }

  private emit(event: ProviderEvent): void {
    if (this.rootReady) this.options.emit(event);
    else this.bufferedEvents.push(event);
  }
}

function parseDetails(value: unknown, useEnvelopeContent: boolean): ParsedDetails | undefined {
  if (!isObject(value)) return undefined;
  const details = value.details;
  if (!isObject(details)) return undefined;
  const parsed = z.object({
    runId: z.string().min(1),
    mode: z.string().optional(),
    results: z.array(z.unknown()).optional(),
    progress: z.array(z.unknown()).optional(),
  }).strip().safeParse(details);
  if (!parsed.success) return undefined;
  const snapshots = new Map<string, ChildSnapshot>();
  let hasChildFinalOutput = false;
  for (const value of parsed.data.results ?? []) {
    const result = resultSchema.safeParse(value);
    if (!result.success) continue;
    const identity = snapshotIdentity(result.data.index, result.data.workflowKey);
    snapshots.set(identity, {
      identity,
      index: result.data.index,
      workflowKey: result.data.workflowKey,
      agent: result.data.agent,
      sessionName: result.data.sessionName,
      task: result.data.task,
      model: result.data.model,
      thinking: result.data.thinking,
      usage: result.data.usage,
      exitCode: result.data.exitCode,
      error: result.data.error,
      content: result.data.finalOutput,
      toolCalls: result.data.toolCalls ?? [],
      recentTools: [],
      recentOutput: [],
      ...(result.data.progressSummary ? progressSummarySnapshot(result.data.progressSummary) : {}),
      ...(result.data.progress ? progressSnapshot(result.data.progress) : {}),
    });
    hasChildFinalOutput ||= result.data.finalOutput !== undefined;
  }
  for (const value of parsed.data.progress ?? []) {
    const parsedProgress = progressSchema.safeParse(value);
    if (!parsedProgress.success) continue;
    const progress = parsedProgress.data;
    const matchingIdentities = [...snapshots.values()]
      .filter((snapshot) => snapshot.index === progress.index)
      .map((snapshot) => snapshot.identity);
    if (matchingIdentities.length > 1) continue;
    const identity = matchingIdentities[0] ?? snapshotIdentity(progress.index);
    const existing = snapshots.get(identity);
    snapshots.set(identity, {
      ...(existing ?? { identity, index: progress.index, agent: progress.agent, toolCalls: [], recentTools: [], recentOutput: [] }),
      ...progressSnapshot(progress),
      agent: progress.agent,
      ...(existing?.model ? { model: existing.model } : {}),
      ...(existing?.thinking ? { thinking: existing.thinking } : {}),
    });
  }
  const workflowChildren = parseWorkflowChildren(details.workflowChildren);
  for (const workflowChild of workflowChildren) {
    const existing = snapshots.get(workflowChild.identity);
    snapshots.set(workflowChild.identity, existing ? mergeWorkflowChildSnapshot(existing, workflowChild) : workflowChild);
  }
  const children = [...snapshots.values()]
    .filter((snapshot) => snapshot.agent.length > 0)
    .sort((left, right) => left.index - right.index)
    .slice(0, MAX_SUBAGENT_CHILDREN_PER_TOOL);
  if (children.length === 0) return undefined;
  const workflow = parsed.data.mode === "workflow" || workflowChildren.length > 0;
  const content = useEnvelopeContent && !workflow ? extractText(value.content) : undefined;
  if (content) for (const child of children) if (!child.content) {
    child.content = content;
    child.contentFromEnvelope = true;
  }
  return { runId: parsed.data.runId, children, hasChildFinalOutput, workflow };
}

function parseWorkflowChildren(value: unknown): ChildSnapshot[] {
  if (!isObject(value) || !Array.isArray(value.children)) return [];
  const snapshots = new Map<string, ChildSnapshot>();
  for (const childValue of value.children) {
    const child = workflowChildSchema.safeParse(childValue);
    if (!child.success) continue;
    const identity = snapshotIdentity(0, child.data.childId);
    const activity = child.data.activity;
    snapshots.set(identity, {
      identity,
      index: 0,
      workflowKey: child.data.childId,
      agent: child.data.agent ?? child.data.childId,
      sessionName: child.data.sessionName,
      status: child.data.state,
      model: child.data.model,
      thinking: child.data.thinking,
      inputTokens: finiteCounter(activity?.inputTokens),
      outputTokens: finiteCounter(activity?.outputTokens),
      tokens: finiteCounter(activity?.tokens),
      durationMs: finiteCounter(activity?.durationMs),
      currentTool: activity?.currentTool,
      currentToolStartedAt: finiteCounter(activity?.currentToolStartedAt),
      toolCount: finiteCounter(activity?.toolCount),
      turnCount: finiteCounter(activity?.turnCount),
      lastActivityAt: finiteCounter(activity?.lastActivityAt),
      toolCalls: [],
      recentTools: [],
      recentOutput: [],
    });
  }
  return [...snapshots.values()];
}

function mergeWorkflowChildSnapshot(result: ChildSnapshot, workflowChild: ChildSnapshot): ChildSnapshot {
  return {
    ...result,
    workflowKey: result.workflowKey ?? workflowChild.workflowKey,
    sessionName: result.sessionName ?? workflowChild.sessionName,
    status: terminalOrPrimaryStatus(result.status, workflowChild.status),
    model: result.model ?? workflowChild.model,
    thinking: result.thinking ?? workflowChild.thinking,
    inputTokens: result.inputTokens ?? workflowChild.inputTokens,
    outputTokens: result.outputTokens ?? workflowChild.outputTokens,
    tokens: result.tokens ?? workflowChild.tokens,
    durationMs: result.durationMs ?? workflowChild.durationMs,
    currentTool: result.currentTool ?? workflowChild.currentTool,
    currentToolStartedAt: result.currentToolStartedAt ?? workflowChild.currentToolStartedAt,
    toolCount: result.toolCount ?? workflowChild.toolCount,
    turnCount: result.turnCount ?? workflowChild.turnCount,
    lastActivityAt: result.lastActivityAt ?? workflowChild.lastActivityAt,
  };
}

function terminalOrPrimaryStatus(primary: string | undefined, secondary: string | undefined): string | undefined {
  if (isTerminalStatus(primary)) return primary;
  if (isTerminalStatus(secondary)) return secondary;
  return primary ?? secondary;
}

function progressSnapshot(progress: z.infer<typeof progressSchema>): Partial<ChildSnapshot> {
  return {
    agent: progress.agent,
    sessionName: progress.sessionName,
    task: progress.task,
    status: progress.status,
    model: progress.model,
    thinking: progress.thinking,
    inputTokens: finiteCounter(progress.inputTokens),
    outputTokens: finiteCounter(progress.outputTokens),
    tokens: finiteCounter(progress.tokens),
    durationMs: finiteCounter(progress.durationMs),
    currentTool: progress.currentTool,
    currentToolArgs: progress.currentToolArgs,
    currentToolStartedAt: finiteCounter(progress.currentToolStartedAt),
    currentPath: progress.currentPath,
    toolCount: finiteCounter(progress.toolCount),
    turnCount: finiteCounter(progress.turnCount),
    window: finiteCounter(progress.window),
    windowPeak: finiteCounter(progress.windowPeak),
    lastActivityAt: finiteCounter(progress.lastActivityAt),
    recentTools: progress.recentTools?.slice(0, MAX_SUBAGENT_RECENT_TOOLS) ?? [],
    recentOutput: progress.recentOutput?.slice(0, MAX_SUBAGENT_RECENT_OUTPUT_ITEMS).map((item) => truncate(item)) ?? [],
  };
}

function progressSummarySnapshot(progress: NonNullable<z.infer<typeof resultSchema>["progressSummary"]>): Partial<ChildSnapshot> {
  return {
    toolCount: finiteCounter(progress.toolCount),
    tokens: finiteCounter(progress.tokens),
    durationMs: finiteCounter(progress.durationMs),
  };
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return truncate(value);
  if (!Array.isArray(value)) return undefined;
  const text = value.filter(isObject).filter((item) => item.type === "text" && typeof item.text === "string").map((item) => item.text as string).join("\n\n");
  return text ? truncate(text) : undefined;
}

function visibleTask(value: string | undefined): string | undefined {
  return value?.trim() && value !== "[prompt redacted]" ? value : undefined;
}

function terminalStatus(snapshot: ChildSnapshot): ChildState["status"] {
  const status = snapshot.status?.toLowerCase();
  if (["aborted", "canceled", "cancelled", "detached", "paused", "stopped"].includes(status ?? "")) return "canceled";
  if (["failed", "rejected"].includes(status ?? "") || snapshot.error || snapshot.exitCode !== undefined && snapshot.exitCode !== 0) return "failed";
  return "completed";
}

function hasTerminalEvidence(snapshot: ChildSnapshot): boolean {
  return isTerminalStatus(snapshot.status) || snapshot.error !== undefined || snapshot.exitCode !== undefined;
}

function isTerminalStatus(value: string | undefined): boolean {
  if (!value) return false;
  return !["pending", "running"].includes(value.toLowerCase());
}

function mapUsage(usage: ChildUsage, contextWindowUsedTokens?: number): ProviderUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cachedInputTokens: usage.cacheRead,
    totalCostUsd: usage.cost,
    ...(contextWindowUsedTokens !== undefined ? { contextWindowUsedTokens } : {}),
  };
}

function mapChildUsage(snapshot: ChildSnapshot): ProviderUsage | undefined {
  const progressUsage = snapshot.inputTokens !== undefined || snapshot.outputTokens !== undefined || snapshot.window !== undefined
    ? {
      ...(snapshot.inputTokens !== undefined ? { inputTokens: snapshot.inputTokens } : {}),
      ...(snapshot.outputTokens !== undefined ? { outputTokens: snapshot.outputTokens } : {}),
      ...(snapshot.window !== undefined ? { contextWindowUsedTokens: snapshot.window } : {}),
    }
    : undefined;
  if (!snapshot.usage) return progressUsage;
  return {
    ...mapUsage(snapshot.usage, snapshot.window),
    ...progressUsage,
  };
}

function preferProviderUsage(previous: ProviderUsage | undefined, next: ProviderUsage): ProviderUsage {
  if (!previous) return next;
  return {
    inputTokens: max(previous.inputTokens, next.inputTokens),
    outputTokens: max(previous.outputTokens, next.outputTokens),
    cachedInputTokens: max(previous.cachedInputTokens, next.cachedInputTokens),
    totalCostUsd: max(previous.totalCostUsd, next.totalCostUsd),
    contextWindowUsedTokens: max(previous.contextWindowUsedTokens, next.contextWindowUsedTokens),
  };
}

function mapSummaryTool(tool: ActiveTool): ProviderToolCallDetail {
  const name = tool.name.toLowerCase();
  const args = tool.args ? truncate(tool.args, MAX_SUBAGENT_TOOL_ARGS_BYTES) : undefined;
  if (["bash", "shell", "exec", "run_command"].includes(name)) {
    return { type: "shell", command: args ?? tool.name };
  }
  if (name === "read") return { type: "read", filePath: args ?? tool.name };
  if (name === "write") return { type: "write", filePath: args ?? tool.name };
  if (["grep", "glob", "find", "search", "web_search"].includes(name)) {
    return {
      type: "search",
      query: args ?? tool.name,
      toolName: name === "grep" ? "grep" : name === "glob" ? "glob" : name === "web_search" ? "web_search" : "search",
    };
  }
  if (["fetch", "web_fetch"].includes(name) && args && /^https?:\/\//u.test(args)) return { type: "fetch", url: args };
  return {
    type: "plain_text",
    label: tool.name,
    ...(args ? { text: args } : {}),
    icon: "wrench",
  };
}

function parseRecordedTool(child: ChildState, tool: { text?: string; expandedText?: string }, index: number): RecordedTool | undefined {
  const text = (tool.expandedText ?? tool.text)?.trim();
  if (!text) return undefined;
  const id = `${child.sessionId}:recorded-tool:${hash(`${index}:${text}`)}`;
  if (text.startsWith("$")) {
    const command = text.slice(1).trim();
    return command ? {
      id,
      name: "bash",
      args: command,
      detail: { type: "shell", command: truncate(command, MAX_SUBAGENT_TOOL_ARGS_BYTES) },
    } : undefined;
  }
  const match = /^(\S+)(?:\s+([\s\S]+))?$/u.exec(text);
  if (!match) return undefined;
  const name = match[1];
  const rawArgs = match[2];
  const args = parseRecordedToolArgs(rawArgs);
  const primaryArgument = typeof args.path === "string"
    ? args.path
    : typeof args.pattern === "string"
      ? args.pattern
      : typeof args.query === "string"
        ? args.query
        : rawArgs;
  const summary: ActiveTool = { id, name, ...(primaryArgument ? { args: primaryArgument } : {}) };
  return { id, name, ...(primaryArgument ? { args: primaryArgument } : {}), detail: mapSummaryTool(summary) };
}

function parseRecordedToolArgs(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function recordedToolStatus(
  tool: RecordedTool,
  current: RecordedTool | undefined,
  recentTools: Array<{ tool: string; args?: string; endMs?: number }>,
  terminal: boolean,
  terminalStatusOverride?: ChildState["status"],
): "running" | "completed" | "failed" {
  if (recentTools.some((recent) => recordedMatchesSummary(tool, recent))) return "completed";
  if (current?.id !== tool.id) return "completed";
  if (terminalStatusOverride === "failed") return "failed";
  return terminal ? "completed" : "running";
}

function recordedMatchesSummary(tool: RecordedTool, summary: { tool: string; args?: string }): boolean {
  return equivalentToolName(tool.name, summary.tool) && (!summary.args || tool.args === summary.args);
}

function finiteCounter(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function max(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined ? right : right === undefined ? left : Math.max(left, right);
}

function snapshotIdentity(index: number, workflowKey?: string): string {
  return workflowKey ? `workflow:${workflowKey.length}:${workflowKey}:${index}` : `index:${index}`;
}
function childKey(runId: string, snapshot: ChildSnapshot): string {
  return snapshot.workflowKey ? `${runId}:workflow:${snapshot.workflowKey.length}:${snapshot.workflowKey}:${snapshot.index}` : `${runId}:${snapshot.index}`;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function activeTool(child: ChildState, name: string, args?: string, startedAt?: number): ActiveTool {
  const fingerprint = `${name}\u0000${args ?? ""}\u0000${startedAt ?? ""}`;
  return {
    id: `${child.sessionId}:tool:${hash(fingerprint)}`,
    name,
    ...(args ? { args } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
}
function findCurrentRecordedTool(tools: RecordedTool[], current: ActiveTool): RecordedTool | undefined {
  return tools.find((tool) => equivalentToolName(tool.name, current.name) && tool.args === current.args)
    ?? tools.find((tool) => equivalentToolName(tool.name, current.name));
}
function sameTool(left: ActiveTool | undefined, right: ActiveTool | undefined): boolean {
  return equivalentToolName(left?.name, right?.name) && left?.args === right?.args;
}
function equivalentToolName(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return normalizeToolName(left) === normalizeToolName(right);
}
function normalizeToolName(name: string): string { return name === "shell" ? "bash" : name; }
function truncate(value: string, maxBytes = MAX_SUBAGENT_TEXT_BYTES): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
