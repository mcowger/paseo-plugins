import { parseRpivTodoDetails, type TodoItem } from "../shared/todo-schemas.js";
import type { PiToolResult, PiTrackedToolCall } from "./tool-call-mapper.js";

export const PI_TODO_TIMELINE_ITEM_ID = "pi-todos";

/**
 * Extract a full todo-list snapshot from a completed `todo` tool result.
 * Supports the @juicesharp/rpiv-todo shape (`details.tasks`) and the pi
 * example shape (`details.todos`). Returns null when the result carries no
 * recognizable todo snapshot.
 */
export function extractTodoSnapshot(
  toolCall: PiTrackedToolCall,
  result: PiToolResult,
): TodoItem[] | null {
  if (toolCall.toolName !== "todo" || !result || typeof result === "string") {
    return null;
  }
  return parseRpivTodoDetails(result.details);
}
