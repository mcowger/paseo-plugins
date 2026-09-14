import { describe, expect, it, vi } from "vitest";

import type { PiAgentSessionLike, PiModelRuntimeLike, PiResourceLoaderLike, PiSessionManagerLike, PiToolDefinition } from "../shared/pi-sdk-types.js";
import { discoverGlobalPiTools, type PiToolDiscoveryDependencies } from "./tool-discovery.js";

function dependencies(options: {
  extensionTools?: string[];
  tools?: Array<{ name: string; description?: string }>;
  active?: string[];
  failWhenListing?: boolean;
}) {
  const dispose = vi.fn();
  const session = {
    getActiveToolNames: () => options.active ?? [],
    getAllTools: () => {
      if (options.failWhenListing) throw new Error("tool listing failed");
      return options.tools ?? [];
    },
    dispose,
  } as unknown as PiAgentSessionLike;
  const sessionManager = {
    getBranch: () => [],
    getLeafId: () => null,
  } as unknown as PiSessionManagerLike;
  const extensionTools = new Map((options.extensionTools ?? []).map((name) => [name, {}]));
  const loader = {
    reload: vi.fn(async () => undefined),
    getExtensions: () => ({ errors: [], extensions: [{ tools: extensionTools, commands: new Map() }] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getThemes: () => ({ diagnostics: [] }),
  } as unknown as PiResourceLoaderLike;
  let customTools: PiToolDefinition[] | undefined;
  const value: PiToolDiscoveryDependencies = {
    createAgentSession: async (input) => {
      customTools = input.customTools;
      return { session };
    },
    createModelRuntime: async () => ({ getModel: () => null, getAvailable: async () => [] }) as PiModelRuntimeLike,
    createResourceLoader: () => loader,
    createSessionManager: () => sessionManager,
    getAgentDir: () => "/agent",
  };
  return { dependencies: value, dispose, getCustomTools: () => customTools };
}

describe("discoverGlobalPiTools", () => {
  it("returns bounded presentation data and includes the fallback todo tool", async () => {
    const setup = dependencies({
      tools: [
        { name: "read", description: "Read files" },
        { name: "todo", description: "Manage tasks" },
      ],
      active: ["read"],
    });

    await expect(discoverGlobalPiTools({ cwd: "/workspace", dependencies: setup.dependencies })).resolves.toEqual([
      { name: "read", description: "Read files", source: "builtin", baselineActive: true },
      { name: "todo", description: "Manage tasks", source: "fallback", baselineActive: false }
    ]);
    expect(setup.getCustomTools()?.map((tool) => tool.name)).toEqual(["todo"]);
    expect(setup.dispose).toHaveBeenCalledOnce();
  });

  it("caps discovery during iteration while preserving source order", async () => {
    const setup = dependencies({
      tools: Array.from({ length: 513 }, (_, index) => ({ name: `tool-${index}` })),
    });

    const tools = await discoverGlobalPiTools({ dependencies: setup.dependencies });

    expect(tools).toHaveLength(512);
    expect(tools[0]?.name).toBe("tool-0");
    expect(tools[511]?.name).toBe("tool-511");
    expect(tools[512]).toBeUndefined();
  });

  it("does not inject the fallback when an extension provides todo", async () => {
    const setup = dependencies({
      extensionTools: ["todo", "review"],
      tools: [{ name: "todo" }, { name: "review", description: "Review code" }],
      active: ["todo"],
    });

    await expect(discoverGlobalPiTools({ dependencies: setup.dependencies })).resolves.toEqual([
      { name: "todo", source: "extension", baselineActive: true },
      { name: "review", description: "Review code", source: "extension", baselineActive: false }
    ]);
    expect(setup.getCustomTools()).toBeUndefined();
  });

  it("disposes the temporary session when discovery fails", async () => {
    const setup = dependencies({ failWhenListing: true });

    await expect(discoverGlobalPiTools({ dependencies: setup.dependencies })).rejects.toThrow(
      "tool listing failed",
    );
    expect(setup.dispose).toHaveBeenCalledOnce();
  });
});
