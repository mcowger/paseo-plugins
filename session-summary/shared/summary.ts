import type { AgentTaskItem, AgentTimelineItem, AgentUsage, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";

export type SummaryTaskStatus = "pending" | "in_progress" | "completed";

export interface SummaryTask {
  readonly id: string;
  readonly text: string;
  readonly status: SummaryTaskStatus;
}

export interface ToolFrequency {
  readonly name: string;
  readonly count: number;
}

export interface SummaryToolCall {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly status: ToolCallTimelineItem["status"];
}

export interface SummaryThought {
  readonly id: string;
  readonly title: string | null;
  readonly text: string;
}

export interface SessionSummary {
  readonly initialPrompt: string | null;
  readonly totalToolCalls: number;
  readonly tools: readonly ToolFrequency[];
  readonly tasks: readonly SummaryTask[];
  readonly completedTaskCount: number;
  readonly thoughts: readonly SummaryThought[];
  readonly recentToolCalls: readonly SummaryToolCall[];
  readonly outcome: string | null;
}

export interface SessionStats {
  readonly totalUsage: AgentUsage | null;
  readonly lastTurnUsage: AgentUsage | null;
  readonly lastTurnDurationMs: number | null;
  readonly currentTurnStartedAt: string | null;
}

export interface SummaryTimelineEntry {
  readonly item: AgentTimelineItem;
  readonly timestamp: string;
  readonly turnId?: string;
  readonly seq?: number;
}

export const EMPTY_SESSION_STATS: SessionStats = {
  totalUsage: null,
  lastTurnUsage: null,
  lastTurnDurationMs: null,
  currentTurnStartedAt: null,
};

const TASK_TOOL_NAMES = new Set(["todo", "todowrite", "update_plan", "updateplan"]);
const COMPLETED_STATUS = "completed";
const IN_PROGRESS_STATUS = "in_progress";

const USAGE_FIELDS = ["inputTokens", "cachedInputTokens", "outputTokens", "totalCostUsd"] as const;

export function usageChanged(current: AgentUsage | null, previous: AgentUsage | null): boolean {
  return USAGE_FIELDS.some((field) => current?.[field] !== previous?.[field]);
}

export function usageDelta(current: AgentUsage | null, previous: AgentUsage | null): AgentUsage | null {
  if (!current) return null;
  const result: AgentUsage = { ...current };
  for (const field of USAGE_FIELDS) {
    const value = current[field];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const prior = previous?.[field];
    result[field] = Math.max(0, value - (typeof prior === "number" ? prior : 0));
  }
  return result;
}

export function usageForTurn(current: AgentUsage | null, previous: AgentUsage | null): AgentUsage | null {
  if (!current || !previous) return current;
  const comparableFields = USAGE_FIELDS.filter(
    (field) => typeof current[field] === "number" && typeof previous[field] === "number",
  );
  const isCumulative = comparableFields.length > 0 && comparableFields.every((field) => {
    const currentValue = current[field];
    const previousValue = previous[field];
    return typeof currentValue === "number" && typeof previousValue === "number" && currentValue >= previousValue;
  });
  return isCumulative ? usageDelta(current, previous) : current;
}

function durationBetween(start: string | null, end: string): number | null {
  if (!start) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isNaN(startMs) || Number.isNaN(endMs) ? null : Math.max(0, endMs - startMs);
}

export function lastTurnDuration(
  entries: readonly SummaryTimelineEntry[],
  activeTurnId: string | null,
): number | null {
  const turns: { id: string; start: string | null; end: string }[] = [];
  let current: { id: string; start: string | null; end: string } | null = null;
  let legacyTurn = 0;

  for (const entry of entries) {
    const id: string = entry.turnId
      ?? (entry.item.type === "user_message" ? `legacy:${legacyTurn++}` : current?.id ?? `orphan:${legacyTurn}`);
    if (!current || current.id !== id) {
      if (current) turns.push(current);
      current = {
        id,
        start: entry.item.type === "user_message" ? entry.timestamp : null,
        end: entry.timestamp,
      };
      continue;
    }
    current.end = entry.timestamp;
  }
  if (current) turns.push(current);

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn || turn.id === activeTurnId) continue;
    const durationMs = durationBetween(turn.start, turn.end);
    if (durationMs !== null) return durationMs;
  }
  return null;
}

export function elapsedDuration(startedAt: string | null, now = Date.now()): number | null {
  if (!startedAt) return null;
  const startMs = Date.parse(startedAt);
  return Number.isNaN(startMs) ? null : Math.max(0, now - startMs);
}

export function formatTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trimNumber(value / 1_000)}k`;
  return String(Math.round(value));
}

export function cacheHitRate(usage: AgentUsage | null | undefined): number | null {
  if (!usage) return null;
  const inputTokens = usage.inputTokens ?? 0;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const totalInputTokens = inputTokens + cachedInputTokens;
  return totalInputTokens > 0 ? cachedInputTokens / totalInputTokens : null;
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return "—";
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function trimNumber(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function taskStatus(value: unknown, completed: unknown): SummaryTaskStatus {
  if (value === COMPLETED_STATUS || completed === true) return COMPLETED_STATUS;
  if (value === IN_PROGRESS_STATUS) return IN_PROGRESS_STATUS;
  return "pending";
}

function taskText(task: UnknownRecord): string | null {
  return textValue(task.subject) ?? textValue(task.text) ?? textValue(task.content) ?? textValue(task.title);
}

function taskId(task: UnknownRecord, fallback: string): string {
  const id = task.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : fallback;
}

function normalizeTasks(tasks: readonly unknown[], source: string): SummaryTask[] {
  return tasks.flatMap((candidate, index) => {
    if (!isRecord(candidate)) return [];
    const text = taskText(candidate);
    if (!text) return [];
    return [{
      id: `${source}:${taskId(candidate, String(index))}`,
      text,
      status: taskStatus(candidate.status, candidate.completed ?? candidate.done),
    }];
  });
}

function tasksFromNativeTodo(items: readonly AgentTaskItem[]): SummaryTask[] {
  return items.map((task, index) => ({
    id: `todo:${task.id ?? index}`,
    text: task.text,
    status: taskStatus(task.status, task.completed),
  }));
}

function tasksFromUnknownDetail(detail: ToolCallTimelineItem["detail"]): SummaryTask[] | undefined {
  if (detail.type !== "unknown") return;
  const output = isRecord(detail.output) ? detail.output : null;
  const details = output && isRecord(output.details) ? output.details : output;
  if (!details) return;

  const tasks = Array.isArray(details.tasks) ? normalizeTasks(details.tasks, "tool-task") : [];
  const todos = Array.isArray(details.todos) ? normalizeTasks(details.todos, "tool-todo") : [];
  if (tasks.length === 0 && todos.length === 0 && !Array.isArray(details.tasks) && !Array.isArray(details.todos)) return;
  return [...tasks, ...todos];
}

function tasksFromPlan(text: string): SummaryTask[] | undefined {
  const tasks = text.split("\n").flatMap((line, index) => {
    const match = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const task = textValue(match[2]);
    if (!task) return [];
    const status: SummaryTaskStatus = match[1]?.toLowerCase() === "x" ? COMPLETED_STATUS : "pending";
    return [{
      id: `plan:${index}:${task}`,
      text: task,
      status,
    }];
  });
  return tasks.length > 0 ? tasks : undefined;
}

export function tasksFromTimelineItem(item: AgentTimelineItem): SummaryTask[] | undefined {
  if (item.type === "todo") return tasksFromNativeTodo(item.items);
  if (item.type !== "tool_call") return;
  if (item.detail.type === "plan") return tasksFromPlan(item.detail.text);
  if (!TASK_TOOL_NAMES.has(item.name.toLowerCase())) return;
  return tasksFromUnknownDetail(item.detail);
}

function thoughtTitle(text: string): string | null {
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  const header = /^#{1,6}\s+(.+)$/.exec(firstLine);
  return header?.[1]?.trim() || null;
}

export function formatThinkingText(text: string): string {
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(/(\*\*[^*\s\n](?:[^*\n]*?[^*\s\n])?\*\*)\s*(?=\*\*)/g, "$1\n\n");
    })
    .join("");
}

function uniqueToolCalls(items: readonly AgentTimelineItem[]): ToolCallTimelineItem[] {
  const calls = new Map<string, ToolCallTimelineItem>();
  for (const item of items) {
    if (item.type === "tool_call") calls.set(item.callId, item);
  }
  return [...calls.values()];
}

function toolCallSummary(call: ToolCallTimelineItem): string {
  switch (call.detail.type) {
    case "shell":
      return truncate(call.detail.command, 72);
    case "read":
    case "edit":
    case "write":
      return call.detail.filePath;
    case "search":
      return truncate(call.detail.query, 72);
    case "fetch":
      return truncate(call.detail.url, 72);
    case "worktree_setup":
      return call.detail.branchName;
    case "sub_agent":
      return truncate(call.detail.description || call.detail.subAgentType || "provider subagent", 72);
    case "plain_text":
      return truncate(call.detail.label || call.detail.text || "message", 72);
    case "plan":
      return truncate(call.detail.text, 72);
    case "unknown":
      return "tool result";
  }
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function coalesceReasoningItems(items: readonly AgentTimelineItem[]): AgentTimelineItem[] {
  const result: AgentTimelineItem[] = [];
  for (const item of items) {
    const previous = result.at(-1);
    if (previous?.type === "reasoning" && item.type === "reasoning") {
      result[result.length - 1] = { type: "reasoning", text: `${previous.text}${item.text}` };
    } else {
      result.push(item);
    }
  }
  return result;
}

export function reduceTimeline(items: readonly AgentTimelineItem[]): SessionSummary {
  let initialPrompt: string | null = null;
  let latestTasks: SummaryTask[] = [];
  let outcome: string | null = null;
  const thoughts: SummaryThought[] = [];

  for (const item of coalesceReasoningItems(items)) {
    if (item.type === "user_message" && initialPrompt === null) initialPrompt = textValue(item.text);
    if (item.type === "assistant_message") outcome = textValue(item.text) ?? outcome;
    if (item.type === "reasoning") {
      const text = textValue(formatThinkingText(item.text));
      if (text) thoughts.push({ id: `thought:${thoughts.length}`, title: thoughtTitle(text), text });
    }
    const tasks = tasksFromTimelineItem(item);
    if (tasks !== undefined) latestTasks = tasks;
  }

  const frequencies = new Map<string, number>();
  const toolCalls = uniqueToolCalls(items);
  for (const call of toolCalls) {
    const name = textValue(call.name)?.toLowerCase() ?? "unknown";
    frequencies.set(name, (frequencies.get(name) ?? 0) + 1);
  }
  const tools = [...frequencies.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

  return {
    initialPrompt,
    totalToolCalls: [...frequencies.values()].reduce((total, count) => total + count, 0),
    tools,
    tasks: latestTasks,
    completedTaskCount: latestTasks.filter((task) => task.status === COMPLETED_STATUS).length,
    thoughts,
    recentToolCalls: toolCalls.slice(-3).reverse().map((call) => ({
      id: call.callId,
      name: textValue(call.name)?.toLowerCase() ?? "unknown",
      summary: toolCallSummary(call),
      status: call.status,
    })),
    outcome,
  };
}
