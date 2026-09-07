import { z } from "zod";

export const todoItemSchema = z.object({
  id: z.string().optional(),
  text: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed"]),
});

export type TodoItem = z.output<typeof todoItemSchema>;

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

export function parseRpivTodoDetails(details: unknown): TodoItem[] | null {
  const rpiv = rpivDetailsSchema.safeParse(details);
  if (rpiv.success) {
    return rpiv.data.tasks.flatMap((task): TodoItem[] => {
      if (task.status === "deleted") return [];
      return [
        {
          ...(task.id !== undefined ? { id: String(task.id) } : {}),
          text: task.subject,
          ...(task.activeForm ? { activeForm: task.activeForm } : {}),
          status: task.status,
        },
      ];
    });
  }

  const example = piExampleDetailsSchema.safeParse(details);
  if (example.success) {
    return example.data.todos.map((todo) => ({
      ...(todo.id !== undefined ? { id: String(todo.id) } : {}),
      text: todo.text,
      status: todo.done ? ("completed" as const) : ("pending" as const),
    }));
  }

  return null;
}
