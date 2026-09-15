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

  test("maps pi-microgpt apply_patch calls as edits", () => {
    const patch = "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-old\n+new\n*** End Patch";
    expect(mapToolDetail(parseToolArgs("apply_patch", { patch }))).toEqual({
      type: "edit",
      filePath: "src/index.ts",
      newString: patch,
    });
  });

  test("maps pi-microgpt subagent calls", () => {
    const call = parseToolArgs("spawn_agent", { agent_type: "researcher", message: "Review the API" });
    expect(mapToolDetail(call, parseToolResult({ text: "{\n  \"task_name\": \"research\"\n}" }))).toEqual({
      type: "sub_agent",
      subAgentType: "researcher",
      description: "Review the API",
      log: "{\n  \"task_name\": \"research\"\n}",
    });
  });

  test("preserves unknown calls for timeline inspection", () => {
    const call = parseToolArgs("future_tool", { enabled: true });
    expect(mapToolDetail(call, parseToolResult({ text: "done" }))).toEqual({
      type: "unknown", input: { enabled: true }, output: { text: "done" },
    });
  });
});
