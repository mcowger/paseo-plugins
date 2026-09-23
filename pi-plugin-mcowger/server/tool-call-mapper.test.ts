import { describe, expect, test } from "vitest";

import {
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
} from "./tool-call-mapper.js";

describe("Pi tool call mapper", () => {
  test("maps bash args and result to shell detail", () => {
    const toolCall = parseToolArgs("bash", { command: "echo hello" });
    const result = parseToolResult({ output: "hello\n", exitCode: 0 });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "shell",
      command: "echo hello",
      output: "hello\n",
      exitCode: 0,
    });
  });

  test("maps legacy edit args to edit detail with diff", () => {
    const toolCall = parseToolArgs("edit", {
      path: "app.ts",
      old_string: "before",
      new_string: "after",
    });
    const result = parseToolResult({ details: { diff: "-before\n+after" } });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "edit",
      filePath: "app.ts",
      oldString: "before",
      newString: "after",
      unifiedDiff: "-before\n+after",
    });
  });

  test("preserves ordinary writes as write details", () => {
    const toolCall = parseToolArgs("write", {
      path: "notes.txt",
      content: "unchanged\n",
    });

    expect(mapToolDetail(toolCall, parseToolResult({ text: "Wrote notes.txt" }))).toEqual({
      type: "write",
      filePath: "notes.txt",
      content: "unchanged\n",
    });
  });

  test("maps executed xdev writes to their wrapped tool detail", () => {
    const toolCall = parseToolArgs("write", {
      path: "xd://browser",
      content: "{}",
    });
    const result = parseToolResult({
      content: [{ type: "text", text: "Opened Example Domain" }],
      details: {
        xdev: {
          tool: "browser",
          mode: "execute",
          args: { action: "open", url: "https://example.com" },
          inner: { title: "Example Domain" },
        },
      },
    });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "unknown",
      input: { action: "open", url: "https://example.com" },
      output: {
        content: [{ type: "text", text: "Opened Example Domain" }],
        details: { title: "Example Domain" },
      },
    });
    expect(resolveToolCallName(toolCall, result)).toBe("browser");
  });

  test("does not treat xdev help metadata as an executed inner tool", () => {
    const toolCall = parseToolArgs("write", {
      path: "xd://browser",
      content: "",
    });
    const result = parseToolResult({
      details: {
        xdev: {
          tool: "browser",
          mode: "help",
          inner: "Browser help",
        },
      },
    });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "unknown",
      input: { path: "xd://browser", content: "" },
      output: result,
    });
    expect(resolveToolCallName(toolCall, result)).toBe("write");
  });

  test("does not treat malformed xdev metadata as an executed inner tool", () => {
    const toolCall = parseToolArgs("write", {
      path: "xd://browser",
      content: "{}",
    });
    const result = parseToolResult({
      details: {
        xdev: {
          tool: "",
          mode: "execute",
          args: { action: "open" },
          inner: { title: "must not surface" },
        },
      },
    });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "unknown",
      input: { path: "xd://browser", content: "{}" },
      output: result,
    });
    expect(resolveToolCallName(toolCall, result)).toBe("write");
  });

  test("preserves unknown tool input and parsed output", () => {
    const toolCall = parseToolArgs("custom_tool", { value: 42 });
    const result = parseToolResult({ text: "custom result" });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "unknown",
      input: { value: 42 },
      output: { text: "custom result" },
    });
  });

  test("maps task calls to sub-agent detail while running", () => {
    const toolCall = parseToolArgs("task", {
      agent: "explore",
      task: "Trace the Pi provider tool mapper",
    });

    expect(mapToolDetail(toolCall, null)).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Trace the Pi provider tool mapper",
      log: "",
    });
  });

  test("degrades retired subagent calls to unknown without throwing", () => {
    const toolCall = parseToolArgs("subagent", {
      agent: "reviewer",
      task: "Review the Pi mapper change",
    });
    const result = parseToolResult({
      content: [{ type: "text", text: "The mapper change preserves provider status." }],
    });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "unknown",
      input: { agent: "reviewer", task: "Review the Pi mapper change" },
      output: {
        content: [{ type: "text", text: "The mapper change preserves provider status." }],
      },
    });
  });

  test("normalizes Pi MCP proxy calls from requested tool args while running", () => {
    const toolCall = parseToolArgs("mcp", {
      tool: "paseo_list_models",
      args: '{"provider":"pi"}',
    });

    expect(resolveToolCallName(toolCall, null)).toBe("paseo.list_models");
  });

  test("normalizes Pi MCP proxy calls from result details when completed", () => {
    const toolCall = parseToolArgs("mcp", {
      tool: "paseo_list_models",
      args: '{"provider":"pi"}',
    });
    const result = parseToolResult({
      content: [{ type: "text", text: "(empty result)" }],
      details: {
        mode: "call",
        server: "paseo",
        tool: "list_models",
      },
    });

    expect(resolveToolCallName(toolCall, result)).toBe("paseo.list_models");
  });

  test("degrades malformed MCP ids safely without throwing", () => {
    const call = parseToolArgs("mcp", { server: 42, tool: null });
    expect(resolveToolCallName(call)).toBe("mcp");
    expect(mapToolDetail(call, parseToolResult({ text: "done" }))).toEqual({
      type: "unknown",
      input: { server: 42, tool: null },
      output: { text: "done" },
    });
  });

  test("maps ls calls to search detail", () => {
    const toolCall = parseToolArgs("ls", { path: "src" });
    expect(toolCall.kind).toBe("ls");
    expect(mapToolDetail(toolCall, parseToolResult("a.ts\nb.ts"))).toEqual({
      type: "search",
      query: "src",
      content: "a.ts\nb.ts",
    });
  });

  test("degrades invalid tool args to unknown without throwing", () => {
    const toolCall = parseToolArgs("bash", null);
    expect(toolCall.kind).toBe("unknown");
    expect(mapToolDetail(toolCall, parseToolResult(42))).toEqual({
      type: "unknown",
      input: null,
      output: null,
    });
  });

  test("degrades prototype-named tools to unknown without throwing", () => {
    for (const toolName of ["constructor", "toString", "valueOf", "__proto__"]) {
      const toolCall = parseToolArgs(toolName, { command: "echo hi" });
      expect(toolCall.kind).toBe("unknown");
      expect(toolCall.toolName).toBe(toolName);
    }
  });

  test("renders object-shaped find/grep/ls results as text", () => {
    const find = parseToolArgs("find", { pattern: "*.ts" });
    expect(mapToolDetail(find, parseToolResult({ output: "a.ts\nb.ts" }))).toMatchObject({
      type: "search",
      content: "a.ts\nb.ts",
    });
    const grep = parseToolArgs("grep", { pattern: "todo" });
    expect(
      mapToolDetail(grep, parseToolResult({ content: [{ type: "text", text: "hit" }] })),
    ).toMatchObject({ type: "search", content: "hit" });
    const ls = parseToolArgs("ls", { path: "src" });
    expect(mapToolDetail(ls, parseToolResult({ stdout: "a.ts" }))).toMatchObject({
      type: "search",
      content: "a.ts",
    });
  });

  test("preserves explicit empty output instead of falling through to content", () => {
    const toolCall = parseToolArgs("bash", { command: "true" });
    expect(mapToolDetail(toolCall, parseToolResult({ output: "" }))).toEqual({
      type: "shell",
      command: "true",
      output: "",
      exitCode: null,
    });
  });

  test("accepts empty legacy old_string for prepend-style edits", () => {
    expect(parseToolArgs("edit", { path: "new.txt", old_string: "", new_string: "hello" })).toEqual({
      kind: "edit",
      toolName: "edit",
      args: { path: "new.txt", edits: [{ oldText: "", newText: "hello" }] },
    });
  });

  // Plugin-only mapping (pi-microgpt apply_patch).
  test("maps pi-microgpt apply_patch calls as edits", () => {
    const patch = "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-old\n+new\n*** End Patch";
    expect(mapToolDetail(parseToolArgs("apply_patch", { patch }))).toEqual({
      type: "edit",
      filePath: "src/index.ts",
      newString: patch,
    });
  });

  test("degrades retired pi-microgpt agent calls to unknown without throwing", () => {
    for (const toolName of ["spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents", "interrupt_agent"]) {
      const call = parseToolArgs(toolName, { agent_type: "researcher", message: "Review the API" });
      expect(mapToolDetail(call, parseToolResult({ text: "ok" }))).toEqual({
        type: "unknown",
        input: { agent_type: "researcher", message: "Review the API" },
        output: { text: "ok" },
      });
    }
  });
});
