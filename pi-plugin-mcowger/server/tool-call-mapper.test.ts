import { describe, expect, test } from "vitest";

import { mapToolDetail, parseToolArgs, parseToolResult, resolveToolCallName } from "./tool-call-mapper.js";

describe("Pi JSON-RPC tool mapper", () => {
  test("maps a complete shell call", () => {
    const call = parseToolArgs("bash", { command: "echo hello" });
    expect(mapToolDetail(call, parseToolResult({ output: "hello\n", exitCode: 0 }))).toEqual({
      type: "shell", command: "echo hello", output: "hello\n", exitCode: 0,
    });
  });

  test("normalizes MCP proxy tool names", () => {
    const call = parseToolArgs("mcp", { server: "paseo", tool: "paseo_list_agents" });
    expect(resolveToolCallName(call)).toBe("paseo.list_agents");
  });

  test("preserves unknown calls for timeline inspection", () => {
    const call = parseToolArgs("future_tool", { enabled: true });
    expect(mapToolDetail(call, parseToolResult({ text: "done" }))).toEqual({
      type: "unknown", input: { enabled: true }, output: { text: "done" },
    });
  });
});
