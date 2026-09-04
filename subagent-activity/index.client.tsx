import type { PluginAgentCommandContext, PluginClientContext } from "@getpaseo/plugin";
import { SubagentActivityPanel } from "./client/subagent-activity";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "subagent-activity",
    title: "Subagent activity",
    icon: "Bot",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: SubagentActivityPanel,
  });

  client.addCommandCenterItem({
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
