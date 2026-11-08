// Host-typed coverage: every item below was produced by Paseo 0.11.1 itself — Claude Code frames normalised by the
// real Claude provider (a custom provider extending claude, driven by a scripted stream-json CLI), the fakeacp ACP agent,
// and Codex fileChange/command/MCP thread items run through the installed Codex mapper. Provider ids and the demo
// project path were renamed to the built-in `claude` and /home/user/demo-app afterwards. Agent and message ids are
// synthetic (a0000000-…, b0000000-…) and the timestamps start at 2026-01-01T09:00:00Z with their original gaps; the
// items are otherwise unchanged.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentTimelineItem, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import { transformToolCall } from "./transform";
import { takeoverParts } from "./takeover";
import { lookFor, mcpParts, pendingCallIds, zh } from "../shared/vivid-model";
import { normalizeToolCallDetail, paseoToolResult, unwrapProviderOutput } from "../shared/presentation";
import { wireRowFromEntry } from "../shared/fold-index";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(path.join(here, "../test-fixtures/host-items-0.11.1.json"), "utf8")) as {
  agents: Record<string, { entries: { item: AgentTimelineItem }[] }>;
  codex: ToolCallTimelineItem[];
};
const toolCalls = (agent: string) =>
  fixtures.agents[agent]!.entries.map((entry) => entry.item).filter((item): item is ToolCallTimelineItem => item.type === "tool_call");
const byName = (agent: string, name: string, status?: string) =>
  toolCalls(agent).find((item) => item.name === name && (!status || item.status === status))!;
type Data = { callId?: string; name: string; status: string; presentation: { label: string; category: string; diffStats?: { additions: number; deletions: number } } };
const transform = (item: ToolCallTimelineItem) => transformToolCall({ item, phase: "complete" } as never);
const data = (item: ToolCallTimelineItem, index = 0) => transform(item)!.items[index]!.data as unknown as Data;

describe("Claude Code rows from the 0.11.1 Claude provider", () => {
  it("Edit gets +N/−M from oldString/newString", () => {
    const row = data(byName("claude-all", "Edit"));
    expect(row.presentation).toMatchObject({ label: "Edit", category: "file", diffStats: { additions: 3, deletions: 2 } });
    expect(zh(row.presentation.label)).toBe("编辑");
  });
  it("Bash, failed Bash, Read, Grep, Task, Write, WebFetch keep their detail types", () => {
    expect(data(byName("claude-all", "Bash", "completed")).presentation.label).toBe("Shell");
    const failed = data(byName("claude-all", "Bash", "failed")) as Data & { errorText?: string };
    expect(failed.status).toBe("failed");
    // Local patch: the error text, not the raw tool_result envelope.
    expect(failed.errorText).toMatch(/^Exit code 1/);
    expect(data(byName("claude-all", "Read")).presentation.label).toBe("Read");
    expect(data(byName("claude-all", "Grep")).presentation.category).toBe("search");
    expect(data(byName("claude-all", "Task")).presentation.label).toBe("Agent Task");
    expect(data(byName("claude-all", "Write")).presentation.label).toBe("Write");
    expect(data(byName("claude-all", "WebFetch")).presentation.label).toBe("Fetch URL");
  });
  it("MCP calls get a dedicated GitHub view or an MCP look; Bots keeps its proposal cards (0.5.0)", () => {
    const github = byName("claude-all", "mcp__github__search_code");
    expect(data(github).presentation.label).toBe("GitHub Code Search");
    expect(mcpParts("mcp__bots__propose_skill")).toEqual({ server: "bots", tool: "propose_skill" });
    const bots = byName("claude-bots", "mcp__bots__propose_skill");
    // Finished with a proposal id, the call is Bots' card: left alone here, a segment boundary in the fold index.
    expect(transform(bots)).toBeUndefined();
    expect(wireRowFromEntry({ seqStart: 7, timestamp: "2026-01-01T00:00:00.000Z", provider: "claude", item: bots })).toMatchObject({ k: "b", w: "bots-proposal" });
    // While it runs it is an ordinary MCP row.
    const running = { ...bots, status: "running" } as ToolCallTimelineItem;
    expect(lookFor(running.name, running.detail, data(running).presentation as never)).toBe("mcp");
  });
  it("hands ExitPlanMode / plan_approval back to Paseo's plan card", () => {
    expect(transform(byName("claude-all", "plan_approval"))).toBeUndefined();
    expect(transform({ type: "tool_call", callId: "x", name: "ExitPlanMode", status: "running", error: null, detail: { type: "plan", text: "## 计划" } } as never)).toBeUndefined();
  });
  it("hands todo lists back to Paseo's native task rows: no scope registers a todo transformer", () => {
    const todo = fixtures.agents["claude-all"]!.entries.map((entry) => entry.item).find((item) => item.type === "todo");
    expect(todo?.type).toBe("todo");
    for (const scope of ["all", "reasoning", "off"] as const) expect(takeoverParts(scope)).not.toContain("todos");
  });
  it("unwraps the Claude provider's { output } wrapper so the GitHub and Paseo views see the real result (local patch)", () => {
    const github = data(byName("claude-all", "mcp__github__search_code")) as Data & { detail: { output: { total_count?: number } } };
    expect(github.detail.output.total_count).toBe(2);
    const paseo = normalizeToolCallDetail(
      { type: "unknown", input: {}, output: { output: { agents: [{ id: "a1", status: "idle" }, { id: "a2", status: "running" }] } } },
      "mcp__paseo__list_agents",
    ) as { output: unknown };
    expect((paseoToolResult(paseo.output) as { agents: unknown[] }).agents).toHaveLength(2);
    // Only the exact single-key wrapper is removed; real results that merely contain an output field stay intact.
    const both = { output: "x", exitCode: 0 };
    expect(unwrapProviderOutput(both)).toBe(both);
    expect(unwrapProviderOutput({ output: "text" })).toBe("text");
    expect(unwrapProviderOutput("plain")).toBe("plain");
  });
  it("carries callId so a row can match its pending permission", () => {
    const edit = byName("claude-all", "Edit");
    expect(data(edit).callId).toBe(edit.callId);
  });
});

describe("Codex rows from the 0.11.1 Codex mapper", () => {
  it("apply_patch renders one Edit row with +N/−M", () => {
    const rows = transform(fixtures.codex[0]!)!.items;
    expect(rows).toHaveLength(1);
    expect((rows[0]!.data as unknown as Data).presentation).toMatchObject({ label: "Edit", diffStats: { additions: 2, deletions: 1 } });
  });
  it("multi-file fileChange: 0.11.1 normalises only the first file into the detail, so only that file shows", () => {
    const rows = transform(fixtures.codex[1]!)!.items;
    expect(rows.map((row) => (row.data as unknown as { detail: { filePath: string } }).detail.filePath)).toEqual(["src/app.ts"]);
  });
  it("Codex-named MCP tools (server.tool) get the MCP look", () => {
    const mcp = fixtures.codex[3]!;
    expect(mcp.name).toBe("github.search_code");
    expect(lookFor(mcp.name, mcp.detail, data(mcp).presentation as never)).toMatch(/mcp|search/);
  });
});

describe("ACP (fakeacp) rows", () => {
  it("read and edit keep their detail types", () => {
    expect(data(byName("fakeacp", "read")).presentation.label).toBe("Read");
    expect(data(byName("fakeacp", "edit")).presentation.label).toBe("Edit");
  });
});

describe("pending permission matching", () => {
  it("reads Claude toolUseId and ACP toolCallId", () => {
    expect([...pendingCallIds([{ metadata: { toolUseId: "toolu_1" } }, { metadata: { toolCallId: "call_2" } }, { metadata: {} }])]).toEqual(["toolu_1", "call_2"]);
  });
});
