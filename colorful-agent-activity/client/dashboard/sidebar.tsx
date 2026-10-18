import { type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useReplyCodeStyles } from "../prefs";

export const DASHBOARD_SCREEN_ID = "dashboard";

/**
 * The sidebar entry for the dashboard.
 *
 * The web-only reply restyle is kept in step from here and from the activity
 * renderers, because a user can hide this row while still using the timeline.
 */
export function DashboardSidebarItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  useReplyCodeStyles(theme);
  return (
    <SidebarRow
      active={currentScreen?.screenId === DASHBOARD_SCREEN_ID}
      icon="Palette"
      onPress={() => openScreen({ screenId: DASHBOARD_SCREEN_ID })}
    />
  );
}
