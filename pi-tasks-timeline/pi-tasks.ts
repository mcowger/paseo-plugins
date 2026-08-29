import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin";
import { z } from "zod";

const taskStatusSchema = z.enum(["pending", "in_progress", "completed"]);

const rpivDetailsSchema = z.object({
  tasks: z.array(
    z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        subject: z.string(),
        activeForm: z.string().optional(),
        status: z.enum(["pending", "in_progress", "completed", "deleted"]),
      })
      .passthrough(),
  ),
});

const piExampleDetailsSchema = z.object({
  todos: z.array(
    z
      .object({
        id: z.number().int().optional(),
        text: z.string(),
        done: z.boolean(),
      })
      .passthrough(),
  ),
});

export const piTaskListSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string().optional(),
      text: z.string(),
      activeForm: z.string().optional(),
      status: taskStatusSchema,
    }),
  ),
});

export type PiTask = z.output<typeof piTaskListSchema>["tasks"][number];
type ToolCallTransformer = PluginTimelineTransformerContribution<"tool_call">["transform"];
type ToolCallItem = Parameters<ToolCallTransformer>[0]["item"];

function replacement(tasks: PiTask[]) {
  if (tasks.length === 0) return;
  return {
    items: [
      {
        type: "plugin" as const,
        kind: "pi-task-list",
        version: 1,
        data: { tasks },
      },
    ],
  };
}

export function hasActivePiTasks(tasks: readonly PiTask[]): boolean {
  return tasks.some((task) => task.status !== "completed");
}

export function parsePiTodoToolCall(item: ToolCallItem): PiTask[] | undefined {
  if (item.name !== "todo" || item.status !== "completed" || item.detail.type !== "unknown") {
    return;
  }

  const result = item.detail.output;
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const details = Reflect.get(result, "details");

  const rpiv = rpivDetailsSchema.safeParse(details);
  if (rpiv.success) {
    return rpiv.data.tasks.flatMap((task): PiTask[] => {
      if (task.status === "deleted") return [];
      return [
        {
          ...(task.id !== undefined ? { id: String(task.id) } : {}),
          text: task.subject,
          ...(task.activeForm !== undefined ? { activeForm: task.activeForm } : {}),
          status: task.status,
        },
      ];
    });
  }

  const piExample = piExampleDetailsSchema.safeParse(details);
  if (piExample.success) {
    return piExample.data.todos.map((todo) => ({
      ...(todo.id !== undefined ? { id: String(todo.id) } : {}),
      text: todo.text,
      status: todo.done ? "completed" : "pending",
    }));
  }
}

export const transformPiTodoToolCall: ToolCallTransformer = ({ item }) => {
  const tasks = parsePiTodoToolCall(item);
  return tasks === undefined ? undefined : replacement(tasks);
};
