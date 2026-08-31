import type { PluginAgentCommandContext, PluginContext } from "@getpaseo/plugin";
import { SubagentActivityPanel } from "./subagent-activity.client";

export default function contribute(plugin: PluginContext) {
  plugin.addWorkspacePanel({
    id: "subagent-activity",
    title: "Subagent activity",
    icon: "Bot",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: SubagentActivityPanel,
  });

  plugin.addCommandCenterItem({
    id: "subagent-activity-open",
    title: "Open subagent activity",
    icon: "Bot",
    keywords: ["subagent", "agent", "activity", "children"],
    context: "agent",
    onSelect(context: PluginAgentCommandContext) {
      context.openPanel("subagent-activity", { location: "workspace" });
    },
  });

  return () => {};
}
