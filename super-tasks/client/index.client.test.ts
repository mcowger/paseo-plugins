import { describe, expect, test, vi } from "vitest";
import type {
  PluginClientContext,
  PluginClientSlashCommandContribution,
  PluginCommandCenterItemContribution,
  PluginSidebarItemContribution,
  PluginWorkspacePanelContribution,
} from "@getpaseo/plugin/client";

// The real panel components import `react-native` primitives this suite does not
// stub. The entry point under test only wires registrations — it never renders
// these components — so a dummy replaces each one to keep the import graph light.
// vitest hoists `vi.mock` above this import, so the mock applies before `index.client`
// (and its panel imports) evaluate.
vi.mock("../client/agents/panel", () => ({ WorkspaceSubagentsPanel: () => null }));
vi.mock("../client/tasks/panel", () => ({ WorkspaceTasksPanel: () => null }));
vi.mock("../client/tasks/sidebar-item", () => ({ SuperTasksSidebarItem: () => null }));
import contributeClient from "../index.client";

describe("index.client v0.10 entry point", () => {
  test("registers workspace panels, command center items, and slash commands", () => {
    const workspacePanels: PluginWorkspacePanelContribution[] = [];
    const commandCenterItems: PluginCommandCenterItemContribution[] = [];
    const slashCommands: PluginClientSlashCommandContribution[] = [];
    const sidebarItems: PluginSidebarItemContribution[] = [];

    const mockClient = {
      addSettingsScreen: vi.fn(() => () => {}),
      addSurface: vi.fn(() => () => {}),
      addSidebarItem: vi.fn(() => () => {}),
      addWorkspacePanel: vi.fn((contribution) => {
        workspacePanels.push(contribution);
        return () => {};
      }),
      addCommandCenterItem: vi.fn((contribution) => {
        commandCenterItems.push(contribution);
        return () => {};
      }),
      addSlashCommand: vi.fn((contribution) => {
        slashCommands.push(contribution);
        return () => {};
      }),
      addComposerPill: vi.fn(() => () => {}),
      addSidebarFooterItem: vi.fn((contribution) => {
        sidebarItems.push(contribution);
        return () => {};
      }),
      addSidebarHeaderItem: vi.fn(() => () => {}),
      addAttachmentSource: vi.fn(() => () => {}),
      addTheme: vi.fn(() => () => {}),
      addTimelineTransformer: vi.fn(() => () => {}),
      addTimelineRenderer: vi.fn(() => () => {}),
      openPanel: vi.fn(),
      openSurface: vi.fn(),
      openSettings: vi.fn(),
      rpc: vi.fn(),
      paseo: {} as never,
    } as unknown as PluginClientContext;

    const cleanup = contributeClient(mockClient);
    expect(typeof cleanup).toBe("function");

    expect(workspacePanels.map((p) => p.id)).toEqual(["tasks", "agent-monitor", "subagents"]);

    expect(commandCenterItems.map((i) => i.id)).toEqual([
      "open-tasks-explorer",
      "open-agent-monitor-explorer",
      "open-tasks",
      "open-agent-monitor",
    ]);

    expect(slashCommands.map((c) => c.name)).toEqual(["tasks", "agents"]);

    expect(sidebarItems.map((i) => i.id)).toEqual(["tasks"]);
    expect(sidebarItems.map((i) => i.title)).toEqual(["Super Tasks"]);

    const openPanelMock = vi.fn();
    slashCommands[0]?.onSubmit({ openPanel: openPanelMock } as never);
    expect(openPanelMock).toHaveBeenCalledWith("tasks");

    openPanelMock.mockClear();
    slashCommands[1]?.onSubmit({ openPanel: openPanelMock } as never);
    expect(openPanelMock).toHaveBeenCalledWith("agent-monitor");

    cleanup();
  });
});
