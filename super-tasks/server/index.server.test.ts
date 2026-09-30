import { describe, expect, test, vi } from "vitest";
import contributeServer from "../index.server";
import type { PluginServerContext } from "@getpaseo/plugin/server";

describe("index.server v0.8 entry point", () => {
  test("registers all RPC contracts", () => {
    const handledNames: string[] = [];

    const mockServer = {
      handle: vi.fn((contract) => {
        handledNames.push(contract.name);
      }),
      on: vi.fn(() => () => {}),
      before: vi.fn(() => () => {}),
      registerSettings: vi.fn(),
      registerProvider: vi.fn(),
    } as unknown as PluginServerContext;

    const cleanup = contributeServer(mockServer);
    expect(typeof cleanup).toBe("function");

    expect(handledNames).toEqual([
      "super-tasks.agent.cancel",
      "super-tasks.subagents.list",
      "super-tasks.subagents.timeline",
    ]);

    cleanup();
  });
});
