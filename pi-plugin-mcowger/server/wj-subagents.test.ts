import { expect, test } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

import { WjSubagents } from "./wj-subagents.js";

const CHILD = "3d1f726e-df7d-49f8-b2d5-792af4edc58c";
const GRANDCHILD = "aa9e3a02-5712-4703-a19c-45342e73c67d";
const WJ_TOOLS = [
  "get_agent_templates", "spawn_agent", "send_message", "wait_agent",
  "interrupt_agent", "terminate_agent", "get_agent_status", "get_agent_tree",
];

function activity(agent_id: string, revision: number, body: Record<string, unknown>) {
  return {
    type: "custom", customType: "wj-pi-subagents-activity",
    id: `activity-${revision}`, parentId: null, timestamp: "2026-09-24T00:00:00Z",
    data: {
      schema: "wj-pi-subagents.activity/1", version: 1, kind: "activity",
      agent_id, revision, olderActivityOmitted: false,
      entry: { entry_id: `entry-${revision}`, body },
    },
  };
}

function response(agent_id: string) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: { agent_id } }) }] };
}

test("does not consider incomplete tool catalogs a wj installation", () => {
  expect(WjSubagents.isAvailable(WJ_TOOLS.slice(0, 2))).toBe(false);
  expect(WjSubagents.isAvailable(WJ_TOOLS)).toBe(true);
  expect(WjSubagents.isAvailable(WJ_TOOLS.map((name) => ({ name })))).toBe(true);
  expect(WjSubagents.isAvailable(WJ_TOOLS.map((name) => ({
    name, sourceInfo: { source: "local", origin: "top-level", path: "/custom/extensions/agents.ts" },
  })))).toBe(true);
  expect(WjSubagents.isAvailable(WJ_TOOLS.filter((name) => name !== "terminate_agent"))).toBe(false);
});

test("links a spawned child and routes activity, final report and lifecycle to its own session", () => {
  const events: ProviderEvent[] = [];
  const bridge = new WjSubagents("root", "/workspace", (event) => events.push(event));
  bridge.rootToolStart("call-1", "spawn_agent", { name: "Research", template_id: "explore" });
  bridge.rootToolEnd("call-1", "spawn_agent", response(CHILD));
  bridge.activityEntry(activity(CHILD, 1, {
    type: "message", content: [{ type: "text", text: "Searching source" }],
  }));
  bridge.activityEntry(activity(CHILD, 1, {
    type: "message", content: [{ type: "text", text: "Duplicate must be discarded" }],
  }));
  bridge.custom("wj-pi-subagents-final-report", JSON.stringify({
    schema: "wj-pi-subagents/conversation", version: 1, kind: "final_report", agent_id: CHILD, text: "Done",
  }));

  expect(events[0]).toMatchObject({
    type: "session.opened", sessionId: `wj:${CHILD}`, parentSessionId: "root",
    toolCallId: "call-1", title: "Research",
  });
  expect(events.filter((event) => event.type === "timeline.item")).toEqual([
    expect.objectContaining({ sessionId: `wj:${CHILD}`, item: expect.objectContaining({ text: "Searching source" }) }),
    expect.objectContaining({ sessionId: `wj:${CHILD}`, item: expect.objectContaining({ text: "Done" }) }),
  ]);
  expect(events).toContainEqual({
    type: "session.turn", sessionId: `wj:${CHILD}`, turnId: CHILD, state: "completed",
  });
  bridge.close();
  expect(events.at(-1)).toMatchObject({ type: "session.closed", sessionId: `wj:${CHILD}` });
});

test("preserves nesting when a child's activity records a spawn result", () => {
  const events: ProviderEvent[] = [];
  const bridge = new WjSubagents("root", "/workspace", (event) => events.push(event));
  bridge.activityEntry(activity(CHILD, 1, {
    type: "tool_execution_start", toolCallId: "nested-call", toolName: "spawn_agent",
    summary: { name: "Nested" },
  }));
  bridge.activityEntry(activity(CHILD, 2, {
    type: "tool_execution_end", toolCallId: "nested-call", toolName: "spawn_agent",
    summary: { agent_id: GRANDCHILD },
  }));
  expect(events).toContainEqual(expect.objectContaining({
    type: "session.opened", sessionId: `wj:${GRANDCHILD}`,
    parentSessionId: `wj:${CHILD}`, toolCallId: "nested-call",
  }));
});

test("malformed and unrelated custom messages cannot create child sessions", () => {
  const events: ProviderEvent[] = [];
  const bridge = new WjSubagents("root", "/workspace", (event) => events.push(event));
  expect(bridge.custom("unrelated", "{}")).toBe(false);
  expect(bridge.custom("wj-pi-subagents-activity", "{}")).toBe(false);
  bridge.activityEntry(activity("../bad", 1, { type: "message", content: [{ type: "text", text: "ignored" }] }));
  bridge.activityEntry({ ...activity(CHILD, 1, { type: "message", content: [{ type: "text", text: "ignored" }] }), type: "message" });
  expect(events).toEqual([]);
});

test("terminated child emits canceled rather than completed", () => {
  const events: ProviderEvent[] = [];
  const bridge = new WjSubagents("root", "/workspace", (event) => events.push(event));
  bridge.custom("wj-pi-subagents-terminal", JSON.stringify({
    schema: "wj-pi-subagents/terminal", version: 1, kind: "terminal",
    agent_id: CHILD, state: "terminated",
  }));
  expect(events).toContainEqual({
    type: "session.turn", sessionId: `wj:${CHILD}`, turnId: CHILD, state: "canceled",
  });
});

test("subagent detail links only child-specific calls with a known child id", () => {
  const bridge = new WjSubagents("root", "/workspace", () => undefined);
  expect(bridge.toolDetail("get_agent_tree", {}, null)).toBeNull();
  expect(bridge.toolDetail("spawn_agent", { name: "Research", template_id: "explore" }, response(CHILD))).toMatchObject({
    type: "sub_agent", childSessionId: `wj:${CHILD}`, subAgentType: "explore",
  });
  bridge.close();
});
