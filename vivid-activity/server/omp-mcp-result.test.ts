import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { handleOmpMcpResult } from "./omp-mcp-result.js";

const roots: string[] = [];
const original = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = original;
});

async function setup(records: unknown[]) {
  const base = await mkdtemp(join(tmpdir(), "omp-mcp-result-"));
  roots.push(base);
  process.env.PI_CODING_AGENT_DIR = base;
  const dir = join(base, "sessions", "encoded-cwd");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "20261110T120000_session-123.jsonl"), records.map((record) => JSON.stringify(record)).join("\n"));
  const agent = { provider: "omp", runtimeInfo: { sessionId: "session-123" } };
  const context = { paseo: { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: id === "agent-1" ? agent : { provider: "pi" } }) }) } } } as unknown as PluginHandlerContext;
  return { context, agent };
}

describe("handleOmpMcpResult", () => {
  it("returns text content from the matching OMP MCP tool result", async () => {
    const result = { type: "message", message: { role: "toolResult", toolCallId: "exact", toolName: "write", details: { xdev: { tool: "mcp__sigma_docs_describe" } }, content: [{ type: "text", text: "schema" }, { type: "image", data: "ignored" }, { type: "text", text: "columns" }] } };
    const { context } = await setup([result]);
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "exact" }, context)).resolves.toEqual({ text: "schema\ncolumns" });
  });

  it("does not return a result for a mismatched call id or non-OMP agent", async () => {
    const record = { type: "message", message: { role: "toolResult", toolCallId: "other", toolName: "write", details: { xdev: { tool: "mcp__sigma_docs_describe" } }, content: [{ type: "text", text: "secret" }] } };
    const { context } = await setup([record]);
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "exact" }, context)).resolves.toEqual({ text: null });
    await expect(handleOmpMcpResult({ agentId: "different-agent", callId: "other" }, context)).resolves.toEqual({ text: null });
    const nonOmp = { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: { provider: "pi", runtimeInfo: { sessionId: "session-123" } } }), provider: "pi", runtimeInfo: { sessionId: "session-123" } }) } } } as unknown as PluginHandlerContext;
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "other" }, nonOmp)).resolves.toEqual({ text: null });
  });


  it("returns text from matching grep and executed xdev device results", async () => {
    const grep = {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "grep-call",
        toolName: "grep",
        content: [{ type: "text", text: "src/file.ts:12: match" }],
        details: { duration: 4 },
      },
    };
    const slack = {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "slack-call",
        toolName: "write",
        details: { xdev: { tool: "slack_slack_read_thread", mode: "execute", tier: "read" } },
        content: [{ type: "text", text: "thread output" }],
      },
    };
    const lsp = {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "lsp-call",
        toolName: "write",
        details: { xdev: { tool: "lsp", mode: "execute", tier: "read" } },
        content: [{ type: "text", text: "definition output" }],
      },
    };
    const executedWrite = {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "write-tier-call",
        toolName: "write",
        details: { xdev: { tool: "slack_slack_send_message", mode: "execute", tier: "write" } },
        content: [{ type: "text", text: "recorded device output" }],
      },
    };
    const { context } = await setup([grep, slack, lsp, executedWrite]);
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "grep-call" }, context))
      .resolves.toEqual({ text: "src/file.ts:12: match" });
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "slack-call" }, context))
      .resolves.toEqual({ text: "thread output" });
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "lsp-call" }, context))
      .resolves.toEqual({ text: "definition output" });
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "write-tier-call" }, context))
      .resolves.toEqual({ text: "recorded device output" });
  });

  it("rejects nonmatching IDs, documentation reads, and ordinary writes", async () => {
    const { context } = await setup([
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "another-call",
          toolName: "grep",
          content: [{ type: "text", text: "not this call" }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "docs-call",
          toolName: "read",
          details: { xdev: { tool: "slack_slack_read_thread", mode: "execute", tier: "read" } },
          content: [{ type: "text", text: "documentation device" }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "write-call",
          toolName: "write",
          content: [{ type: "text", text: "ordinary write" }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "legacy-write-call",
          toolName: "write",
          details: { xdev: { tool: "lsp" } },
          content: [{ type: "text", text: "ordinary write without mode" }],
        },
      },
    ]);
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "missing-call" }, context))
      .resolves.toEqual({ text: null });
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "docs-call" }, context))
      .resolves.toEqual({ text: null });
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "write-call" }, context))
      .resolves.toEqual({ text: null });
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "legacy-write-call" }, context))
      .resolves.toEqual({ text: null });
  });
  it("ignores matching records without textual content or MCP tool metadata", async () => {
    const { context } = await setup([
      { type: "message", message: { role: "toolResult", toolCallId: "no-text", toolName: "write", details: { xdev: { tool: "mcp__x" } }, content: [{ type: "image" }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "not-mcp", toolName: "write", details: { xdev: { tool: "ordinary_tool" } }, content: [{ type: "text", text: "secret" }] } },
    ]);
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "no-text" }, context)).resolves.toEqual({ text: null });
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "not-mcp" }, context)).resolves.toEqual({ text: null });
  });
});
