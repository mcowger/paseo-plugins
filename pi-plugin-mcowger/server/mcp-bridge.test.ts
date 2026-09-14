import { describe, expect, it, vi } from "vitest";

const mockMcp = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
  closeCalls: 0,
  throwOnDefineName: undefined as string | undefined,
  tools: [] as Array<Array<{ name: string; description?: string }>>,
}));

vi.mock("./pi-sdk.js", () => ({
  Client: class {
    readonly close = vi.fn(async () => {
      mockMcp.closeCalls += 1;
    });
    readonly callTool = vi.fn(async (request: { name: string; arguments: Record<string, unknown> }) => {
      mockMcp.calls.push(request);
      return { content: [] };
    });

    async connect(): Promise<void> {}

    async listTools(): Promise<{ tools: Array<{ name: string; description?: string }> }> {
      return { tools: mockMcp.tools.shift() ?? [] };
    }
  },
  SSEClientTransport: class {},
  StdioClientTransport: class {},
  StreamableHTTPClientTransport: class {},
  defineTool: (tool: unknown) => {
    if (mockMcp.throwOnDefineName === (tool as { name?: string }).name) {
      throw new Error("tool definition failed");
    }
    return tool;
  },
}));

vi.mock("./tool-policy.js", () => ({
  filterPaseoToolNames: (names: readonly string[], policy: { enabled: boolean; disabledTools: string[] }) =>
    policy.enabled ? names.filter((name) => !policy.disabledTools.includes(name)) : [],
  filterPaseoToolNamesForProfile: (names: readonly string[], allowed: readonly string[]) =>
    names.filter((name) => allowed.includes(name)),
}));

import { createMcpBridge } from "./mcp-bridge.js";

function queueClient(tools: Array<{ name: string; description?: string }>): void {
  mockMcp.tools.push(tools);
}

describe("createMcpBridge", () => {
  it("filters Paseo tools by canonical name when the server has an alias", async () => {
    queueClient([
      { name: "create_agent" },
      { name: "create_workspace" },
    ]);

    const bridge = await createMcpBridge(
      {
        host_tools: {
          type: "http",
          url: "https://paseo.example.test/mcp/agents",
        },
      },
      { enabled: true, disabledTools: ["create_workspace"] },
      () => {},
    );

    try {
      expect(bridge.tools.map((tool) => tool.name)).toEqual(["mcp_host_tools_create_agent"]);
      await (bridge.tools[0] as unknown as {
        execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown>;
      }).execute("call-1", {});
      expect(mockMcp.calls).toEqual([{ name: "create_agent", arguments: {} }]);
      expect(bridge.getToolMetadata("mcp_host_tools_create_agent")).toEqual({
        piToolName: "mcp_host_tools_create_agent",
        mcpToolName: "create_agent",
        serverName: "host_tools",
        source: "paseo",
      });
      expect(bridge.getToolMetadata("mcp_host_tools_create_workspace")).toBeUndefined();
      expect([...bridge.toolMetadata.values()]).toEqual([
        {
          piToolName: "mcp_host_tools_create_agent",
          mcpToolName: "create_agent",
          serverName: "host_tools",
          source: "paseo",
        },
      ]);
    } finally {
      await bridge.close();
    }
  });

  it("filters Paseo tools by the profile's exact canonical allow set before registration", async () => {
    queueClient([
      { name: "create_agent" },
      { name: "create_agent_extra" },
    ]);

    const bridge = await createMcpBridge(
      {
        paseo: {
          type: "http",
          url: "https://paseo.example.test/mcp/agents",
        },
      },
      { enabled: true, disabledTools: [] },
      () => {},
      ["create_agent"],
    );

    try {
      expect(bridge.tools.map((tool) => tool.name)).toEqual(["mcp_paseo_create_agent"]);
      expect(bridge.visiblePaseoToolCount).toBe(1);
    } finally {
      await bridge.close();
    }
  });

  it("rejects colliding generated names instead of keeping ambiguous metadata", async () => {
    queueClient([{ name: "tool" }]);
    queueClient([{ name: "tool" }]);

    const bridge = await createMcpBridge(
      {
        "foo-bar": { type: "http", url: "https://one.example.test/mcp/tools" },
        foo_bar: { type: "http", url: "https://two.example.test/mcp/tools" },
      },
      { enabled: true, disabledTools: [] },
      () => {},
    );

    try {
      expect(bridge.tools).toEqual([]);
      expect(bridge.getToolMetadata("mcp_foo_bar_tool")).toBeUndefined();
    } finally {
      await bridge.close();
    }
  });

  it("closes every connected client when tool definition fails", async () => {
    queueClient([{ name: "bad" }]);
    queueClient([{ name: "good" }]);
    mockMcp.throwOnDefineName = "mcp_bad_bad";
    const closeCallsBefore = mockMcp.closeCalls;

    await expect(createMcpBridge(
      {
        bad: { type: "http", url: "https://bad.example.test/mcp/tools" },
        good: { type: "http", url: "https://good.example.test/mcp/tools" },
      },
      { enabled: true, disabledTools: [] },
      () => {},
    )).rejects.toThrow("tool definition failed");

    expect(mockMcp.closeCalls - closeCallsBefore).toBe(2);
    mockMcp.throwOnDefineName = undefined;
  });

  it("keeps external MCP tools and marks their origin without using generated names", async () => {
    queueClient([{ name: "create_agent" }]);

    const bridge = await createMcpBridge(
      {
        paseo: {
          type: "http",
          url: "https://external.example.test/mcp/tools",
        },
      },
      { enabled: false, disabledTools: [] },
      () => {},
    );

    try {
      expect(bridge.tools.map((tool) => tool.name)).toEqual(["mcp_paseo_create_agent"]);
      expect(bridge.getToolMetadata("mcp_paseo_create_agent")).toEqual({
        piToolName: "mcp_paseo_create_agent",
        mcpToolName: "create_agent",
        serverName: "paseo",
        source: "external",
      });
    } finally {
      await bridge.close();
    }
  });
});
