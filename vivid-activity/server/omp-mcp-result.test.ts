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

  it("ignores matching records without textual content or MCP tool metadata", async () => {
    const { context } = await setup([
      { type: "message", message: { role: "toolResult", toolCallId: "no-text", toolName: "write", details: { xdev: { tool: "mcp__x" } }, content: [{ type: "image" }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "not-mcp", toolName: "write", details: { xdev: { tool: "ordinary_tool" } }, content: [{ type: "text", text: "secret" }] } },
    ]);
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "no-text" }, context)).resolves.toEqual({ text: null });
    await expect(handleOmpMcpResult({ agentId: "agent-1", callId: "not-mcp" }, context)).resolves.toEqual({ text: null });
  });
});
