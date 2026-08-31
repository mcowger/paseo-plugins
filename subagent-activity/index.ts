import type { PluginContext } from "@getpaseo/plugin";
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

  return () => {};
}
