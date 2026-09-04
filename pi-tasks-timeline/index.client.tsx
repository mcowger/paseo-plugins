import type { PluginClientContext } from "@getpaseo/plugin";
import { PiTaskList, PiTasksPanel } from "./client/pi-tasks";
import { contributeClient } from "./client/pi-tasks-controller";
import { piTaskListSchema, transformPiTodoToolCall } from "./shared/pi-tasks";

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "pi-tasks",
    query: { itemType: "tool_call" },
    transform: transformPiTodoToolCall,
  });
  client.addTimelineRenderer({
    kind: "pi-task-list",
    version: 1,
    schema: piTaskListSchema,
    Component: PiTaskList,
  });
  client.addWorkspacePanel({
    id: "pi-tasks",
    title: "Active Pi tasks",
    icon: "ListChecks",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: PiTasksPanel,
  });
  return contributeClient(client);
}
