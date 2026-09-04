import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { z } from "zod";

export const overviewTaskSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});

export const overviewSubagentSchema = z.object({
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  status: z.enum(["initializing", "idle", "running", "error", "closed"]),
  model: z.string().nullable(),
  cost: z.number().nullable(),
});

export const overviewUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  contextWindowMaxTokens: z.number().positive().nullable(),
  contextWindowUsedTokens: z.number().nonnegative().nullable(),
});

export const sessionOverviewSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  status: z.enum(["initializing", "idle", "running", "error", "closed"]),
  title: z.string().nullable(),
  model: z.string().nullable(),
  mode: z.string().nullable(),
  cwd: z.string(),
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  usage: overviewUsageSchema.nullable(),
  tasks: z.array(overviewTaskSchema),
  subagents: z.array(overviewSubagentSchema),
  commands: z.object({
    count: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
    error: z.string().nullable(),
  }),
  project: z.object({
    name: z.string(),
    directory: z.string(),
    branch: z.string().nullable(),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
  }).nullable(),
  unavailableReason: z.string().nullable(),
});

export type SessionOverview = z.output<typeof sessionOverviewSchema>;
export type OverviewUsage = z.output<typeof overviewUsageSchema>;
export type OverviewTask = z.output<typeof overviewTaskSchema>;
export type OverviewSubagent = z.output<typeof overviewSubagentSchema>;

export const OVERVIEW_REFRESH_INTERVAL_MS = 10_000;

export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return "—";
  return `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}

export function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return "—";
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 100_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export function contextPercent(usage: OverviewUsage | null): number | null {
  if (usage?.contextWindowUsedTokens === null || usage?.contextWindowUsedTokens === undefined || !usage.contextWindowMaxTokens) {
    return null;
  }
  return Math.min(100, Math.round((usage.contextWindowUsedTokens / usage.contextWindowMaxTokens) * 100));
}

export function taskStatus(item: { status?: string; completed?: boolean }): OverviewTask["status"] {
  if (item.status === "completed" || item.completed) return "completed";
  if (item.status === "in_progress") return "in_progress";
  return "pending";
}

export function extractTasks(items: readonly AgentTimelineItem[]): OverviewTask[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type !== "todo") continue;
    return item.items.map((task) => ({
      id: task.id ?? task.text,
      text: task.text,
      status: taskStatus(task),
    }));
  }
  return [];
}

export function countCompletedTasks(tasks: readonly OverviewTask[]): number {
  return tasks.filter((task) => task.status === "completed").length;
}
