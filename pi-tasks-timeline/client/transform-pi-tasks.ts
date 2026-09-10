import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import type { PiTask } from "../shared/pi-tasks";
import { parsePiTodoToolCall } from "../shared/pi-tasks";

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

export const transformPiTodoToolCall: ToolCallTransformer = ({ item }) => {
  const tasks = parsePiTodoToolCall(item as ToolCallItem);
  return tasks === undefined ? undefined : replacement(tasks);
};
