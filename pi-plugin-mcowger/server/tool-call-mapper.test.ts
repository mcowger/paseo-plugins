import { describe, expect, it } from "vitest";

import {
  isTaskToolCall,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
} from "./tool-call-mapper.js";

describe("parseToolArgs / mapToolDetail", () => {
  it("maps bash calls to shell detail", () => {
    const call = parseToolArgs("bash", { command: "ls -la" });
    const detail = mapToolDetail(call, parseToolResult({ output: "file.ts", exitCode: 0 }));
    expect(detail).toEqual({ type: "shell", command: "ls -la", output: "file.ts", exitCode: 0 });
  });

  it("maps edit calls with diffs", () => {
    const call = parseToolArgs("edit", {
      path: "a.ts",
      edits: [{ oldText: "a", newText: "b" }],
    });
    const detail = mapToolDetail(
      call,
      parseToolResult({ content: [{ type: "text", text: "ok" }], details: { diff: "@@" } }),
    );
    expect(detail).toEqual({
      type: "edit",
      filePath: "a.ts",
      oldString: "a",
      newString: "b",
      unifiedDiff: "@@",
    });
  });

  it("maps unknown tools to unknown detail", () => {
    const call = parseToolArgs("todo", { action: "list" });
    const detail = mapToolDetail(call, null);
    expect(detail.type).toBe("unknown");
  });
});

describe("subagent (task) tool mapping", () => {
  it("detects the task tool", () => {
    expect(isTaskToolCall(parseToolArgs("task", { agent: "scout", task: "find things" }))).toBe(
      true,
    );
  });

  it("detects pi-subagents delegate calls", () => {
    const call = parseToolArgs("subagent", { agent: "scout", task: "survey the repo" });
    expect(isTaskToolCall(call)).toBe(true);
    const detail = mapToolDetail(call, parseToolResult({ output: "partial log" }));
    expect(detail).toEqual({
      type: "sub_agent",
      subAgentType: "scout",
      description: "survey the repo",
      log: "partial log",
    });
  });

  it("ignores subagent management actions", () => {
    expect(isTaskToolCall(parseToolArgs("subagent", { action: "list" }))).toBe(false);
  });
});

describe("resolveToolCallName", () => {
  it("passes through regular tools", () => {
    expect(resolveToolCallName(parseToolArgs("bash", { command: "ls" }))).toBe("bash");
  });

  it("resolves mcp proxy names from result details", () => {
    const call = parseToolArgs("mcp", { tool: "linear_search" });
    expect(
      resolveToolCallName(call, { details: { server: "linear", tool: "search" } }),
    ).toBe("linear.search");
  });
});
