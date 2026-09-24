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
  expect(events.filter((event) => event.type === "timeline.item")
    .map((event) => event.item)
    .filter((item) => item.type === "tool_call")
    .map((item) => item.status)).toEqual(["running", "completed"]);
  expect(events).toContainEqual({ type: "session.turn", sessionId: `super-agents:${CHILD}`, turnId: CHILD, state: "completed" });
  adapter.close();
  expect(events.at(-1)).toMatchObject({ type: "session.closed", sessionId: `super-agents:${CHILD}` });
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

test("marks truncated activity once even when the first truncated event arrives later", () => {
  const events: ProviderEvent[] = [];
  const adapter = new SuperAgentSubagents("root", "/workspace", (event) => events.push(event));
  adapter.activityEntry(activity(CHILD, 0, "lifecycle", { phase: "queued" }));
  adapter.activityEntry(activity(CHILD, 1, "session", {
    truncated: true, event: { type: "turn_start" },
  }));
  adapter.activityEntry(activity(CHILD, 2, "session", {
    truncated: true, event: { type: "turn_end" },
  }));
  expect(events.filter((event) => event.type === "timeline.item" && event.item.type === "notification"))
    .toHaveLength(1);
});
