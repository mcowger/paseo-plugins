import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";

vi.mock("./client/review-panel", () => ({ ReviewPanel: () => null }));
vi.mock("./client/settings", () => ({ OcrSettings: () => null }));

import contribute, { REVIEW_PANEL_ID } from "./index.client";

interface RecordedCall {
  method: string;
  contribution: Record<string, unknown>;
}

function createRecordingClient() {
  const calls: RecordedCall[] = [];
  const remover = vi.fn();
  const record =
    (method: string) =>
    (contribution: Record<string, unknown>): (() => void) => {
      calls.push({ method, contribution });
      return remover;
    };
  const client = {
    addWorkspacePanel: vi.fn(record("addWorkspacePanel")),
    addAttachmentSource: vi.fn(record("addAttachmentSource")),
    addSettingsScreen: vi.fn(record("addSettingsScreen")),
    addCommandCenterItem: vi.fn(record("addCommandCenterItem")),
    addSlashCommand: vi.fn(record("addSlashCommand")),
  } as unknown as PluginClientContext;
  return { client, calls, remover };
}

function callsOf(calls: RecordedCall[], method: string): Record<string, unknown>[] {
  return calls.filter((call) => call.method === method).map((call) => call.contribution);
}

describe("client entry registrations", () => {
  it("registers the workspace panel with both locations", () => {
    const { client, calls } = createRecordingClient();
    contribute(client);
    const panels = callsOf(calls, "addWorkspacePanel");
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({
      id: REVIEW_PANEL_ID,
      context: "workspace",
      locations: ["workspace", "explorer"],
    });
  });

  it("registers workspace and agent command palette openers", () => {
    const { client, calls } = createRecordingClient();
    contribute(client);
    const items = callsOf(calls, "addCommandCenterItem");
    expect(items.map((item) => item.context).sort()).toEqual(["agent", "workspace"]);
    for (const item of items) {
      const openPanel = vi.fn();
      const onSelect = item.onSelect as (context: unknown) => void;
      onSelect({ openPanel });
      expect(openPanel).toHaveBeenCalledWith(REVIEW_PANEL_ID);
    }
  });

  it("registers workspace and agent /ocr slash commands", () => {
    const { client, calls } = createRecordingClient();
    contribute(client);
    const commands = callsOf(calls, "addSlashCommand");
    expect(commands.map((command) => command.context).sort()).toEqual(["agent", "workspace"]);
    for (const command of commands) {
      expect(command.name).toBe("ocr");
      const openPanel = vi.fn();
      const onSubmit = command.onSubmit as (context: unknown) => void;
      onSubmit({ openPanel });
      expect(openPanel).toHaveBeenCalledWith(REVIEW_PANEL_ID);
    }
  });

  it("cleanup removes every registration", () => {
    const { client, remover } = createRecordingClient();
    const cleanup = contribute(client);
    cleanup();
    expect(remover).toHaveBeenCalledTimes(7);
  });
});
