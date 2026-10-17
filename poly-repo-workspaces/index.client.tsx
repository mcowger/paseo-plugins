import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PolyRepoPanel } from "./client/panel";
import { PolyRepoScreen } from "./client/screen";
import { PolyRepoSettingsScreen } from "./client/settings-screen";
import { PolyRepoSidebarItem } from "./client/sidebar-item";

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "polyrepo",
    title: "Poly-repo",
    Component: PolyRepoScreen,
  });

  if (typeof client.addSidebarHeaderItem === "function") {
    client.addSidebarHeaderItem({
      id: "polyrepo",
      title: "Poly-repo workspaces",
      Component: PolyRepoSidebarItem,
    });
  }

  client.addWorkspacePanel({
    id: "polyrepo",
    title: "Poly-repo",
    icon: "FolderGit2",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: PolyRepoPanel,
  });

  client.addSettingsScreen({
    id: "polyrepo",
    title: "Poly-repo",
    icon: "FolderGit2",
    Component: PolyRepoSettingsScreen,
  });

  client.addCommandCenterItem({
    id: "open-polyrepo",
    title: "Open poly-repo workspaces",
    icon: "FolderGit2",
    keywords: ["poly-repo", "multi-repo", "virtual workspace", "worktree"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "polyrepo", params: {} });
    },
  });

  client.addCommandCenterItem({
    id: "open-polyrepo-panel",
    title: "Open poly-repo panel",
    icon: "FolderGit2",
    keywords: ["poly-repo", "repos", "worktree status"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("polyrepo");
    },
  });

  return () => {};
}
