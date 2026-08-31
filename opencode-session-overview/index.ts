import type { PluginAgentCommandContext, PluginContext } from "@getpaseo/plugin";
import { OpenCodeSessionOverviewPanel } from "./overview.client";

export default function contribute(plugin: PluginContext) {
  plugin.addWorkspacePanel({
    id: "opencode-session-overview",
    title: "OpenCode session",
    icon: "Activity",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: OpenCodeSessionOverviewPanel,
  });
  plugin.addCommandCenterItem({
    id: "opencode-session-overview-open",
    title: "Open OpenCode session overview",
    icon: "Activity",
    keywords: ["opencode", "session", "usage", "context"],
    context: "agent",
    onSelect(context: PluginAgentCommandContext) {
      context.openPanel("opencode-session-overview", { location: "workspace" });
    },
  });
  return () => {};
}
