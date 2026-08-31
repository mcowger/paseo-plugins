import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@getpaseo/plugin";
import contribute from "./index";

vi.mock("./overview.client", () => ({
  OpenCodeSessionOverviewPanel: () => null,
}));

describe("OpenCode session overview registration", () => {
  it("registers a valid Command Center item ID", () => {
    const addCommandCenterItem = vi.fn();
    const plugin = {
      addCommandCenterItem,
      addWorkspacePanel: vi.fn(),
    } as unknown as PluginContext;

    contribute(plugin);

    expect(addCommandCenterItem).toHaveBeenCalledWith(expect.objectContaining({
      id: "opencode-session-overview-open",
    }));
  });
});
