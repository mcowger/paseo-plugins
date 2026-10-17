import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow, SidebarSeparator } from "@getpaseo/plugin/client/ui";
import { type ReactElement, useMemo } from "react";
import type { VirtualWorkspaceSummary } from "../shared/rpc";
import { useVirtualWorkspaces } from "./use-virtual-workspaces";

function statusSuffix(item: VirtualWorkspaceSummary): string {
  if (item.state === "teardown-blocked") return "needs cleanup";
  if (item.state === "creating") return "creating";
  if (item.state === "orphaned") return "orphaned";
  if (item.state === "archiving") return "archiving";
  const dirty = item.dirtyRepos > 0 ? `, ${item.dirtyRepos} dirty` : "";
  const ahead = item.aheadRepos > 0 ? `, ${item.aheadRepos} ahead` : "";
  return `${item.constituents.length} repos${dirty}${ahead}`;
}

export function PolyRepoSidebarItem({ openScreen }: PluginSidebarItemProps): ReactElement | null {
  const { items, loading, error } = useVirtualWorkspaces();

  const openHandlers = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.virtualId,
          () => {
            openScreen({ screenId: "polyrepo", params: { virtualId: item.virtualId } });
          },
        ]),
      ),
    [items, openScreen],
  );

  const openList = useMemo(
    () => () => {
      openScreen({ screenId: "polyrepo", params: {} });
    },
    [openScreen],
  );

  const rows = useMemo(
    () =>
      items.map((item) => (
        <SidebarRow
          key={item.virtualId}
          id={item.virtualId}
          icon="FolderGit2"
          label={`${item.feature} (${statusSuffix(item)})`}
          onPress={openHandlers.get(item.virtualId) ?? openList}
        />
      )),
    [items, openHandlers, openList],
  );

  if (loading && items.length === 0) return null;
  if (error && items.length === 0) {
    return <SidebarRow icon="FolderGit2" label="Poly-repo (unavailable)" onPress={openList} />;
  }
  if (items.length === 0) return null;

  return (
    <>
      <SidebarSeparator />
      {rows}
    </>
  );
}
