import type { AgentTaskItem, AgentTimelineItem, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";

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
  readonly outcome: string | null;
}

const TASK_TOOL_NAMES = new Set(["todo", "todowrite", "update_plan", "updateplan"]);
const COMPLETED_STATUS = "completed";
const IN_PROGRESS_STATUS = "in_progress";

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

export function reduceTimeline(items: readonly AgentTimelineItem[]): SessionSummary {
  let initialPrompt: string | null = null;
  let latestTasks: SummaryTask[] = [];
  let outcome: string | null = null;
  const thoughts: SummaryThought[] = [];

  for (const item of items) {
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
  for (const call of uniqueToolCalls(items)) {
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
    outcome,
  };
}
