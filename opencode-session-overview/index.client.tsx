import type { PluginAgentCommandContext, PluginClientContext } from "@getpaseo/plugin";
import { OpenCodeSessionOverviewPanel } from "./client/overview";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "opencode-session-overview",
    title: "OpenCode session",
    icon: "Activity",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: OpenCodeSessionOverviewPanel,
  });
  client.addCommandCenterItem({
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
