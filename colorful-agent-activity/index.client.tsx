import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ColorfulReasoning, ColorfulTodo, ColorfulToolCall } from "./client/activity";
import { Dashboard } from "./client/dashboard";
import { DashboardSidebarItem, DASHBOARD_SCREEN_ID } from "./client/dashboard/sidebar";
import { AgentSummaryPanel } from "./client/summary/panel";
import { syncReplyCodeStyles } from "./client/prefs";
import { transformReasoning, transformTodo, transformToolCall } from "./client/transform";
import { installColorfulFonts } from "./client/web";
import {
  REASONING_RENDERER_KIND,
  REASONING_RENDERER_VERSION,
  reasoningItemDataSchema,
  TODO_RENDERER_KIND,
  TODO_RENDERER_VERSION,
  TOOL_CALL_RENDERER_KIND,
  TOOL_CALL_RENDERER_VERSION,
  todoItemDataSchema,
  toolCallItemDataSchema,
} from "./shared/timeline";

export default function contribute(client: PluginClientContext) {
  const removeFonts = installColorfulFonts();
  client.addScreen({
    id: DASHBOARD_SCREEN_ID,
    title: "Colorful Activity",
    Component: Dashboard,
  });
  client.addSidebarHeaderItem({
    id: DASHBOARD_SCREEN_ID,
    title: "Colorful Activity",
    Component: DashboardSidebarItem,
  });
  client.addCommandCenterItem({
    id: "open-dashboard",
    title: "Open Colorful Activity settings",
    icon: "Palette",
    keywords: ["colorful", "activity", "display", "palette", "settings"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: DASHBOARD_SCREEN_ID });
    },
  });
  client.addWorkspacePanel({
    id: "summary",
    title: "Activity Summary",
    icon: "Activity",
    context: "agent",
    Component: AgentSummaryPanel,
  });
  client.addCommandCenterItem({
    id: "open-agent-summary",
    title: "Open Activity Summary",
    icon: "Activity",
    keywords: ["summary", "activity", "tools", "thinking", "status"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("summary");
    },
  });
  client.addTimelineTransformer({
    id: "reasoning",
    query: { itemType: "reasoning" },
    transform: transformReasoning,
  });
  client.addTimelineTransformer({
    id: "todos",
    query: { itemType: "todo" },
    transform: transformTodo,
  });
  client.addTimelineTransformer({
    id: "tool-calls",
    query: { itemType: "tool_call" },
    transform: transformToolCall,
  });
  client.addTimelineRenderer({
    kind: TODO_RENDERER_KIND,
    version: TODO_RENDERER_VERSION,
    schema: todoItemDataSchema,
    Component: ColorfulTodo,
  });
  client.addTimelineRenderer({
    kind: REASONING_RENDERER_KIND,
    version: REASONING_RENDERER_VERSION,
    schema: reasoningItemDataSchema,
    Component: ColorfulReasoning,
  });
  client.addTimelineRenderer({
    kind: TOOL_CALL_RENDERER_KIND,
    version: TOOL_CALL_RENDERER_VERSION,
    schema: toolCallItemDataSchema,
    Component: ColorfulToolCall,
  });
  return () => {
    removeFonts();
    // Drop the web reply stylesheet with the plugin, not with the next theme change.
    syncReplyCodeStyles(false, null);
  };
}
