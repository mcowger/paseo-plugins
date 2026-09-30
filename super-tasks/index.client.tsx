import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { WorkspaceSubagentsPanel } from "./client/agents/panel";
import { WorkspaceTasksPanel } from "./client/tasks/panel";
import { SuperTasksSidebarItem } from "./client/tasks/sidebar-item";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "tasks",
    title: "Super Tasks",
    icon: "ListChecks",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: WorkspaceTasksPanel,
  });

  // Older client entries predate sidebar header/footer items; skip the row instead of failing
  // the whole plugin on them.
  if (typeof client.addSidebarFooterItem === "function") {
    client.addSidebarFooterItem({
      id: "tasks",
      title: "Super Tasks",
      Component: function SuperTasksSidebarContribution(props: PluginSidebarItemProps) {
        return <SuperTasksSidebarItem {...props} openPanel={client.openPanel} />;
      },
    });
  }
  client.addWorkspacePanel({
    id: "agent-monitor",
    title: "Agent Monitor",
    icon: "Bot",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: WorkspaceSubagentsPanel,
  });
  client.addWorkspacePanel({
    id: "subagents",
    title: "Agent Monitor",
    icon: "Bot",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: WorkspaceSubagentsPanel,
  });

  client.addCommandCenterItem({
    id: "open-tasks-explorer",
    title: "Open Super Tasks in Explorer",
    icon: "ListChecks",
    keywords: ["tasks", "todo", "explorer", "activity", "workspace"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("tasks", { location: "explorer" });
    },
  });
  client.addCommandCenterItem({
    id: "open-agent-monitor-explorer",
    title: "Open Agent Monitor in Explorer",
    icon: "Bot",
    keywords: [
      "agent monitor",
      "monitor",
      "subagents",
      "agents",
      "explorer",
      "activity",
      "workspace",
    ],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("agent-monitor", { location: "explorer" });
    },
  });
  client.addCommandCenterItem({
    id: "open-tasks",
    title: "Open Super Tasks",
    icon: "ListChecks",
    keywords: ["tasks", "todo", "activity", "workspace"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("tasks");
    },
  });
  client.addCommandCenterItem({
    id: "open-agent-monitor",
    title: "Open Agent Monitor",
    icon: "Bot",
    keywords: ["agent monitor", "monitor", "subagents", "agents", "activity", "workspace"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("agent-monitor");
    },
  });

  client.addSlashCommand({
    name: "tasks",
    description: "Open Super Tasks panel",
    argumentHint: "",
    context: "workspace",
    onSubmit({ openPanel }) {
      openPanel("tasks");
    },
  });
  client.addSlashCommand({
    name: "agents",
    description: "Open Agent Monitor panel",
    argumentHint: "",
    context: "workspace",
    onSubmit({ openPanel }) {
      openPanel("agent-monitor");
    },
  });

  return () => {};
}
