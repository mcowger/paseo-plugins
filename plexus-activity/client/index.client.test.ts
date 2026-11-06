import type {
  PluginClientContext,
  PluginCommandCenterItemContribution,
  PluginSidebarContribution,
  PluginWorkspacePanelContribution,
} from "@getpaseo/plugin/client";
import { describe, expect, test, vi } from "vitest";

// The panel renders react-native primitives this suite does not stub. The entry point under test only
// wires registrations, so a dummy replaces each component to keep the import graph light.
vi.mock("./panel", () => ({ ActivityPanel: () => null }));
vi.mock("./settings-screen", () => ({ PlexusSettingsScreen: () => null }));

import contributeClient from "../index.client";

/**
 * The mobile entry point depends entirely on these registrations: a workspace panel is invisible to the
 * compact tab switcher, so the sidebar item plus its surface is what makes the view reachable on a phone.
 */
describe("index.client registrations", () => {
  function register() {
    const workspacePanels: PluginWorkspacePanelContribution[] = [];
    const sidebarItems: PluginSidebarContribution[] = [];
    const commandItems: PluginCommandCenterItemContribution[] = [];
    const surfaces: string[] = [];
    const settingsScreens: string[] = [];

    const client = {
      addSettingsScreen: vi.fn((contribution: { id: string }) => {
        settingsScreens.push(contribution.id);
        return () => {};
      }),
      addSurface: vi.fn((id: string) => {
        surfaces.push(id);
        return () => {};
      }),
      addSidebarItem: vi.fn((contribution: PluginSidebarContribution) => {
        sidebarItems.push(contribution);
        return () => {};
      }),
      addWorkspacePanel: vi.fn((contribution: PluginWorkspacePanelContribution) => {
        workspacePanels.push(contribution);
        return () => {};
      }),
      addCommandCenterItem: vi.fn((contribution: PluginCommandCenterItemContribution) => {
        commandItems.push(contribution);
        return () => {};
      }),
      openSettings: vi.fn(),
      openPanel: vi.fn(),
    } as unknown as PluginClientContext;

    const cleanup = contributeClient(client);
    return {
      client,
      cleanup,
      workspacePanels,
      sidebarItems,
      commandItems,
      surfaces,
      settingsScreens,
    };
  }

  test("registers the activity panel for both hosts", () => {
    const { workspacePanels } = register();
    expect(workspacePanels).toHaveLength(1);
    expect(workspacePanels[0]).toMatchObject({
      id: "activity",
      context: "workspace",
      locations: ["workspace", "explorer"],
    });
  });

  test("registers a sidebar-reachable surface for compact layouts", () => {
    const { sidebarItems, surfaces } = register();
    expect(surfaces).toEqual(["activity"]);
    expect(sidebarItems).toEqual([
      { id: "activity", title: "Plexus activity", icon: "Activity", surface: "activity" },
    ]);
  });

  test("registers the settings screen", () => {
    const { settingsScreens } = register();
    expect(settingsScreens).toEqual(["settings"]);
  });

  test("offers plain and explorer-scoped open commands", () => {
    const { commandItems } = register();
    expect(commandItems.map((item) => item.id)).toEqual([
      "open-plexus-activity",
      "open-plexus-activity-explorer",
    ]);
    expect(commandItems.every((item) => item.context === "workspace")).toBe(true);
  });

  test("returns a cleanup function", () => {
    const { cleanup } = register();
    expect(typeof cleanup).toBe("function");
  });
});
