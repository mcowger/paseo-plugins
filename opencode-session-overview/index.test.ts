import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import contribute from "./index.client";

vi.mock("./client/overview", () => ({
  OpenCodeSessionOverviewPanel: () => null,
}));

describe("OpenCode session overview registration", () => {
  it("registers a valid Command Center item ID", () => {
    const addCommandCenterItem = vi.fn();
    const client = {
      addCommandCenterItem,
      addWorkspacePanel: vi.fn(),
    } as unknown as PluginClientContext;

    contribute(client);

    expect(addCommandCenterItem).toHaveBeenCalledWith(expect.objectContaining({
      id: "opencode-session-overview-open",
    }));
  });
});
