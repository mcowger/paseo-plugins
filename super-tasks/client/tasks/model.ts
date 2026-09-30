import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export interface TaskItemViewModel {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly completed: boolean;
  readonly activeForm?: string;
}

export interface AgentTaskCounts {
  readonly total: number;
  readonly pending: number;
  readonly inProgress: number;
  readonly completed: number;
}

export interface AgentTasksGroup {
  readonly agentId: string;
  readonly agentTitle: string;
  readonly isMain: boolean;
  readonly provider: string;
  readonly status: "initializing" | "idle" | "running" | "error" | "closed";
  readonly updatedAt: string;
  readonly tasks: readonly TaskItemViewModel[];
  readonly counts: AgentTaskCounts;
}

export type TaskStatusFilter = "all" | "in_progress" | "pending" | "completed";

/**
 * Walks an agent's timeline from the newest entry backwards and maps the first `todo` snapshot it
 * finds. Each item carries the full list, so older snapshots are ignored.
 */
export function extractLatestTodoSnapshot(
  items: readonly AgentTimelineItem[],
): TaskItemViewModel[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && item.type === "todo" && Array.isArray(item.items)) {
      return item.items.map((t, idx) => {
        const status: "pending" | "in_progress" | "completed" =
          t.status === "completed" || t.status === "in_progress" || t.status === "pending"
            ? t.status
            : t.completed
              ? "completed"
              : "pending";

        return {
          id: t.id || `task-${idx}-${t.text.slice(0, 16)}`,
          text: t.text || "(empty task)",
          status,
          completed: status === "completed" || !!t.completed,
          activeForm: t.activeForm,
        };
      });
    }
  }
  return [];
}

export function countTasks(tasks: readonly TaskItemViewModel[]): AgentTaskCounts {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const task of tasks) {
    if (task.status === "pending") pending += 1;
    else if (task.status === "in_progress") inProgress += 1;
    else completed += 1;
  }
  return { total: tasks.length, pending, inProgress, completed };
}

export function sumCounts(groups: readonly AgentTasksGroup[]): AgentTaskCounts {
  let total = 0;
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const group of groups) {
    total += group.counts.total;
    pending += group.counts.pending;
    inProgress += group.counts.inProgress;
    completed += group.counts.completed;
  }
  return { total, pending, inProgress, completed };
}

/** The present-participle label of the first in-progress task, if any. */
export function findActiveTaskLabel(groups: readonly AgentTasksGroup[]): string | null {
  for (const group of groups) {
    for (const task of group.tasks) {
      if (task.status === "in_progress") return task.activeForm || task.text;
    }
  }
  return null;
}
