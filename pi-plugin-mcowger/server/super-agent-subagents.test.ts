import { expect, test } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

import { SuperAgentSubagents } from "./super-agent-subagents.js";

const CHILD = "a7k2m9qz";
const OTHER = "b8q3n1xy";
const TOOLS = ["agent", "agent_wait", "agent_stop", "agent_status"];

function activity(id: string, seq: number, kind: "lifecycle" | "session", extra: Record<string, unknown> = {}) {
  return {
    type: "custom", customType: "super-agents-event",
    id: `entry-${id}-${seq}`, parentId: null, timestamp: "2026-09-24T00:00:00Z",
    data: {
      v: 1, seq, ts: 1758700000123, agentId: id, name: "Research", slug: "scout",
      parentToolCallId: "call-1", background: false, kind, truncated: false, ...extra,
    },
  };
}

function result(id: string, state: string, body: string) {
  return {
    content: [{ type: "text", text: `### Research (scout) — ${state} [id: ${id}]\n${body}` }],
    details: { runs: [{ id, name: "Research", slug: "scout", status: state }] },
  };
}

test("detects the four super-agents tools without interfering with other catalogs", () => {
  expect(SuperAgentSubagents.isAvailable(new Set(TOOLS))).toBe(true);
  expect(SuperAgentSubagents.isAvailable(new Set(TOOLS.slice(0, 3)))).toBe(false);
  expect(SuperAgentSubagents.isAvailable(new Set(["spawn_agent", ...TOOLS]))).toBe(true);
});

test("projects queued child, session messages and tools, and finished status in sequence", () => {
  const events: ProviderEvent[] = [];
  const adapter = new SuperAgentSubagents("root", "/workspace", (event) => events.push(event));
  adapter.activityEntry(activity(CHILD, 0, "lifecycle", { phase: "queued" }));
  adapter.activityEntry(activity(CHILD, 1, "lifecycle", { phase: "started", data: { model: "anthropic/model" } }));
  adapter.activityEntry(activity(CHILD, 2, "session", {
    event: { type: "tool_execution_start", toolCallId: "child-call", toolName: "grep", args: { pattern: "x" } },
  }));
  adapter.activityEntry(activity(CHILD, 3, "session", {
    event: { type: "tool_execution_end", toolCallId: "child-call", toolName: "grep", result: { content: [{ type: "text", text: "found" }] } },
  }));
  adapter.activityEntry(activity(CHILD, 4, "session", {
    event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Found it" }] } },
  }));
  adapter.activityEntry(activity(CHILD, 4, "session", {
    event: { type: "message_end", message: { role: "assistant", content: "duplicate" } },
  }));
  adapter.activityEntry(activity(CHILD, 5, "lifecycle", { phase: "finished", data: { status: "completed" } }));

  expect(events).toContainEqual(expect.objectContaining({
    type: "session.opened", sessionId: `super-agents:${CHILD}`, parentSessionId: "root",
    toolCallId: "call-1", title: "Research",
  }));
  expect(events).toContainEqual(expect.objectContaining({
    type: "timeline.item", sessionId: `super-agents:${CHILD}`,
    item: expect.objectContaining({ type: "assistant_message", text: "Found it" }),
  }));
  const toolCalls = events.filter((event) => event.type === "timeline.item")
    .map((event) => event.item)
    .filter((item) => item.type === "tool_call")
  expect(toolCalls.map((item) => item.status)).toEqual(["running", "completed"]);
  expect(toolCalls[0]).toMatchObject({
    name: "grep", status: "running",
    detail: { type: "search", query: "x", toolName: "grep" },
  });
  expect(toolCalls[1]).toMatchObject({
    name: "grep", status: "completed",
    detail: { type: "search", query: "x", toolName: "grep", content: "found" },
  });
  expect(events).toContainEqual({ type: "session.turn", sessionId: `super-agents:${CHILD}`, turnId: CHILD, state: "completed" });
  adapter.close();
  expect(events.at(-1)).toMatchObject({ type: "session.closed", sessionId: `super-agents:${CHILD}` });
});

test("projects child tool results and errors with their start arguments", () => {
  const events: ProviderEvent[] = [];
  const adapter = new SuperAgentSubagents("root", "/workspace", (event) => events.push(event));
  adapter.activityEntry(activity(CHILD, 0, "session", {
    event: { type: "tool_execution_start", toolCallId: "child-read", toolName: "read", args: { path: "src/file.ts" } },
  }));
  adapter.activityEntry(activity(CHILD, 1, "session", {
    event: {
      type: "tool_execution_end", toolCallId: "child-read", toolName: "read",
      result: { content: [{ type: "text", text: "File not found" }] }, isError: true,
    },
  }));

  const toolCalls = events.filter((event) => event.type === "timeline.item")
    .map((event) => event.item)
    .filter((item) => item.type === "tool_call");
  expect(toolCalls[0]).toMatchObject({
    status: "running", detail: { type: "read", filePath: "src/file.ts" },
  });
  expect(toolCalls[1]).toMatchObject({
    status: "failed", error: "File not found",
    detail: { type: "read", filePath: "src/file.ts", content: "File not found" },
  });
  adapter.close();
});

test("uses result details without events, links single run and keeps late reports on the finished turn", () => {
  const events: ProviderEvent[] = [];
  const adapter = new SuperAgentSubagents("root", "/workspace", (event) => events.push(event));
  const completed = result(CHILD, "completed", "Useful result");
  expect(adapter.toolDetail("agent", { tasks: [{ agent: "scout", name: "Research" }] }, completed))
    .toMatchObject({ type: "sub_agent", childSessionId: `super-agents:${CHILD}`, subAgentType: "scout" });
  adapter.rootToolEnd("call-1", "agent", completed);
  adapter.custom("super-agents-result", `Background sub-agent results:\n\n### Research (scout) — completed [id: ${CHILD}]\nUseful result`);
  expect(events.filter((event) => event.type === "timeline.item")).toHaveLength(1);
  expect(events.filter((event) => event.type === "session.turn" && event.state === "started")).toHaveLength(1);
  expect(events).toContainEqual(expect.objectContaining({
    type: "session.opened", toolCallId: "call-1", sessionId: `super-agents:${CHILD}`,
  }));
  adapter.close();
});

test("background batches and turn limits project separate children with terminal states", () => {
  const events: ProviderEvent[] = [];
  const adapter = new SuperAgentSubagents("root", "/workspace", (event) => events.push(event));
  adapter.rootToolEnd("call-1", "agent", {
    content: [{ type: "text", text: "Started in background" }],
    details: { runs: [
      { id: CHILD, name: "Research", slug: "scout", status: "queued" },
      { id: OTHER, name: "Review", slug: "reviewer", status: "running" },
    ] },
  });
  adapter.activityEntry(activity(CHILD, 0, "lifecycle", { phase: "finished", data: { status: "turn_limited" } }));
  adapter.custom("super-agents-result", `Background sub-agent results:\n\n### Research (scout) — turn_limited [id: ${CHILD}]\nPartial result\n\n### Review (reviewer) — aborted [id: ${OTHER}]\nStopped`);
  expect(events).toContainEqual({
    type: "session.turn", sessionId: `super-agents:${CHILD}`, turnId: CHILD, state: "failed",
    error: { message: "Subagent turn limit reached" },
  });
  expect(events).toContainEqual({
    type: "session.turn", sessionId: `super-agents:${OTHER}`, turnId: OTHER, state: "canceled",
  });
  expect(events.filter((event) => event.type === "session.turn" && event.state === "started")).toHaveLength(2);
  expect(events.filter((event) => event.type === "timeline.item")).toHaveLength(2);
});

test("reports per-child usage and error detail from a failed result", () => {
  const events: ProviderEvent[] = [];
  const adapter = new SuperAgentSubagents("root", "/workspace", (event) => events.push(event));
  adapter.rootToolEnd("call-1", "agent", {
    ...result(CHILD, "failed", "Partial output"),
    details: { runs: [{
      id: CHILD, name: "Research", slug: "scout", status: "failed", error: "Model unavailable",
      usage: { tokens: { input: 100, output: 20, cacheRead: 40 }, cost: 0.03 },
    }] },
  });
  expect(events).toContainEqual({
    type: "session.usage", sessionId: `super-agents:${CHILD}`, turnId: CHILD,
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, totalCostUsd: 0.03 },
  });
  expect(events).toContainEqual({
    type: "session.turn", sessionId: `super-agents:${CHILD}`, turnId: CHILD,
    state: "failed", error: { message: "Model unavailable" },
  });
});

test("rejects malformed and unrelated persisted entries", () => {
  const events: ProviderEvent[] = [];
  const adapter = new SuperAgentSubagents("root", "/workspace", (event) => events.push(event));
  adapter.activityEntry(activity("../bad", 0, "lifecycle", { phase: "queued" }));
  adapter.activityEntry(activity(CHILD, -1, "lifecycle", { phase: "queued" }));
  adapter.activityEntry({ ...activity(CHILD, 0, "lifecycle"), customType: "unrelated" });
  adapter.activityEntry(activity(CHILD, 0, "lifecycle", { v: 2, phase: "queued" }));
  expect(adapter.custom("unrelated", "{}")).toBe(false);
  expect(events).toEqual([]);
});

test("only message prose raises the truncation notice, once per child", () => {
  const events: ProviderEvent[] = [];
  const adapter = new SuperAgentSubagents("root", "/workspace", (event) => events.push(event));
  const notifications = () => events.filter((event) => event.type === "timeline.item" && event.item.type === "notification");
  adapter.activityEntry(activity(CHILD, 0, "lifecycle", { phase: "queued", truncated: true }));
  adapter.activityEntry(activity(CHILD, 1, "session", {
    truncated: true, event: { type: "turn_start" },
  }));
  adapter.activityEntry(activity(CHILD, 2, "session", {
    truncated: true,
    event: { type: "tool_execution_end", toolCallId: "child-call", toolName: "fetch", result: { content: "x".repeat(70000) } },
  }));
  // Tool I/O, lifecycle, and progress shrinkage stays silent: the full
  // content recovers via later events and the terminal report.
  expect(notifications()).toHaveLength(0);
  adapter.activityEntry(activity(CHILD, 3, "session", {
    truncated: true,
    event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] } },
  }));
  adapter.activityEntry(activity(CHILD, 4, "session", {
    truncated: true,
    event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Follow-up" }] } },
  }));
  expect(notifications()).toHaveLength(1);
  expect(notifications()[0]).toMatchObject({
    type: "timeline.item",
    item: { type: "notification", level: "info", message: "Some subagent activity was truncated" },
  });
});

test("flags message prose dropped entirely for size", () => {
  const events: ProviderEvent[] = [];
  const adapter = new SuperAgentSubagents("root", "/workspace", (event) => events.push(event));
  adapter.activityEntry(activity(CHILD, 0, "lifecycle", { phase: "queued" }));
  adapter.activityEntry(activity(CHILD, 1, "session", {
    event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(40000) }] } },
  }));
  const items = events.filter((event) => event.type === "timeline.item").map((event) => event.item);
  expect(items.filter((item) => item.type === "assistant_message")).toHaveLength(0);
  expect(items.filter((item) => item.type === "notification"))
    .toEqual([expect.objectContaining({ message: "Some subagent activity was truncated" })]);
});

test("shows the final response once when live prose matches the terminal report", () => {
  const events: ProviderEvent[] = [];
  const adapter = new SuperAgentSubagents("root", "/workspace", (event) => events.push(event));
  const body = "Answer: do not add / backfill account.issuer.";
  adapter.activityEntry(activity(CHILD, 0, "lifecycle", { phase: "queued" }));
  adapter.activityEntry(activity(CHILD, 1, "lifecycle", { phase: "started" }));
  adapter.activityEntry(activity(CHILD, 2, "session", {
    event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: body }] } },
  }));
  adapter.activityEntry(activity(CHILD, 3, "lifecycle", { phase: "finished", data: { status: "completed" } }));
  adapter.rootToolEnd("call-1", "agent", result(CHILD, "completed", body));
  const assistants = events.filter((event) => event.type === "timeline.item")
    .map((event) => event.item)
    .filter((item) => item.type === "assistant_message");
  expect(assistants).toHaveLength(1);
  expect(assistants[0]).toMatchObject({ id: `${CHILD}:event:2`, text: body });
  expect(events).toContainEqual({ type: "session.turn", sessionId: `super-agents:${CHILD}`, turnId: CHILD, state: "completed" });
  adapter.close();
});

test("keeps a differing terminal report alongside live progress", () => {
  const events: ProviderEvent[] = [];
  const adapter = new SuperAgentSubagents("root", "/workspace", (event) => events.push(event));
  adapter.activityEntry(activity(CHILD, 0, "session", {
    event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Working" }] } },
  }));
  adapter.rootToolEnd("call-1", "agent", result(CHILD, "completed", "Done"));
  const texts = events.filter((event) => event.type === "timeline.item")
    .map((event) => event.item)
    .filter((item) => item.type === "assistant_message")
    .map((item) => item.text);
  expect(texts).toEqual(["Working", "Done"]);
  adapter.close();
});
