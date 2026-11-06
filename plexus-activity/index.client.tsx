import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ActivityPanel } from "./client/panel";
import { PlexusSettingsScreen } from "./client/settings-screen";

/**
 * Live activity view, its settings screen, and the ways in.
 *
 * Three entry points, because they cover different host layouts:
 * - a workspace/Explorer **panel** — the desktop tab or right-hand dock;
 * - a **surface** plus **sidebar item** — a full-screen view in the sidebar, which is the one entry
 *   point that exists on compact/mobile layouts (the compact tab switcher offers only new agent and
 *   new terminal, and the compact Explorer overlay has no panel launcher);
 * - **command centre** items for the palette.
 *
 * `openSettings` is captured here because surfaces and panels receive no client context.
 */
export default function contribute(client: PluginClientContext) {
  const openSettings = (screenId: string) => client.openSettings(screenId);

  client.addWorkspacePanel({
    id: "activity",
    title: "Plexus activity",
    icon: "Activity",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: function PlexusActivityPanel(props) {
      return <ActivityPanel {...props} openSettings={openSettings} />;
    },
  });

  client.addSurface("activity", function PlexusActivitySurface(props: PluginSurfaceProps) {
    return <ActivityPanel {...props} openSettings={openSettings} />;
  });

  client.addSidebarItem({
    id: "activity",
    title: "Plexus activity",
    icon: "Activity",
    surface: "activity",
  });

  client.addSettingsScreen({
    id: "settings",
    title: "Plexus activity",
    icon: "SlidersHorizontal",
    Component: PlexusSettingsScreen,
  });

  client.addCommandCenterItem({
    id: "open-plexus-activity",
    title: "Open Plexus activity",
    icon: "Activity",
    keywords: ["plexus", "activity", "requests", "logs", "usage"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("activity");
    },
  });

  client.addCommandCenterItem({
    id: "open-plexus-activity-explorer",
    title: "Open Plexus activity in Explorer",
    icon: "Activity",
    keywords: ["plexus", "activity", "requests", "logs", "usage", "explorer", "dock"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("activity", { location: "explorer" });
    },
  });

  return () => {};
}
