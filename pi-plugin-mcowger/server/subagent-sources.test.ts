import { expect, test } from "vitest";

import type { ProviderEvent, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

import { ProviderSubagentProjector } from "./subagent-projector.js";
import { PiSubagentSources, type SubagentSourceDefinition } from "./subagent-sources.js";

test("multiple source definitions route their own tools and messages independently", () => {
  const calls: string[] = [];
  const definitions: SubagentSourceDefinition[] = ["alpha", "beta"].map((id) => ({
    matches: (tools) => tools.has(`${id}_spawn`),
    create: () => ({
      handlesTool: (name) => name === `${id}_spawn`,
      toolDetail: (_name, _args, _result): ProviderToolCallDetail => ({
        type: "sub_agent", subAgentType: id, description: id, log: "",
      }),
      rootToolStart: () => { calls.push(`${id}:start`); },
      rootToolEnd: () => { calls.push(`${id}:end`); },
      handlesCustomMessage: (customType) => customType === `${id}-reply`,
      custom: () => { calls.push(`${id}:reply`); return true; },
      activityEntry: (entry) => { if (entry.customType === `${id}-activity`) calls.push(`${id}:activity`); },
      close: () => { calls.push(`${id}:close`); },
    }),
  }));
  const context = { sessionId: "parent", cwd: "/workspace", emit: (_event: ProviderEvent) => undefined };
  const sources = PiSubagentSources.fromProbe(
    ["alpha_spawn", { name: "beta_spawn", sourceInfo: { origin: "local" } }],
    context,
    definitions,
  );

  expect(sources).not.toBeNull();
  expect(sources?.toolDetail("beta_spawn", {}, null)).toMatchObject({ type: "sub_agent", subAgentType: "beta" });
  sources?.rootToolStart("call-1", "alpha_spawn", {});
  sources?.rootToolEnd("call-2", "beta_spawn", null);
  expect(sources?.handlesCustomMessage("beta-reply")).toBe(true);
  expect(sources?.custom("beta-reply", "text")).toBe(true);
  expect(sources?.custom("unrelated", "text")).toBe(false);
  sources?.activityEntry({ type: "custom", id: "entry", parentId: null, timestamp: "now", customType: "alpha-activity" });
  sources?.close();

  expect(calls).toEqual(["alpha:start", "beta:end", "beta:reply", "alpha:activity", "alpha:close", "beta:close"]);
  expect(PiSubagentSources.fromProbe(["alpha_spawn"], context, definitions)?.toolDetail("beta_spawn", {}, null)).toBeNull();
  expect(PiSubagentSources.fromProbe(["unrelated"], context, definitions)).toBeNull();
});

test("child projection keeps nesting and identities scoped to each source", () => {
  const events: ProviderEvent[] = [];
  const emit = (event: ProviderEvent) => events.push(event);
  const alpha = new ProviderSubagentProjector("alpha", "root", "/workspace", emit);
  const beta = new ProviderSubagentProjector("beta", "root", "/workspace", emit);

  alpha.describe("child", { title: "Explore", toolCallId: "call-1" });
  alpha.describe("nested", { parentId: "child", title: "Inspect", toolCallId: "call-2" });
  alpha.timeline("nested", { type: "assistant_message", id: "reply-1", text: "Done" });
  alpha.finish("nested");
  alpha.describe("self", { parentId: "self" });
  beta.describe("child", { title: "Other" });

  expect(events).toContainEqual(expect.objectContaining({
    type: "session.opened", sessionId: "alpha:nested", parentSessionId: "alpha:child", toolCallId: "call-2",
  }));
  expect(events).toContainEqual(expect.objectContaining({
    type: "session.opened", sessionId: "beta:child", parentSessionId: "root",
  }));
  expect(events).toContainEqual(expect.objectContaining({
    type: "session.opened", sessionId: "alpha:self", parentSessionId: "root",
  }));
  expect(events).toContainEqual(expect.objectContaining({
    type: "timeline.item", sessionId: "alpha:nested", item: { type: "assistant_message", id: "reply-1", text: "Done" },
  }));
  alpha.close();
  beta.close();
  expect(events.filter((event) => event.type === "session.closed").map((event) => event.sessionId))
    .toEqual(["alpha:child", "alpha:nested", "alpha:self", "beta:child"]);
});

test("detects wj and super-agents together and routes their calls to separate adapters", () => {
  const events: ProviderEvent[] = [];
  const sources = PiSubagentSources.fromProbe([
    "get_agent_templates", "spawn_agent", "send_message", "wait_agent",
    "interrupt_agent", "terminate_agent", "get_agent_status", "get_agent_tree",
    "agent", "agent_wait", "agent_stop", "agent_status",
  ], { sessionId: "root", cwd: "/workspace", emit: (event) => events.push(event) });
  expect(sources?.toolDetail("agent", { tasks: [{ agent: "scout", prompt: "Inspect" }] }, {
    details: { runs: [{ id: "a7k2m9qz", name: "scout", slug: "scout", status: "queued" }] },
  })).toMatchObject({ type: "sub_agent", childSessionId: "super-agents:a7k2m9qz" });
  expect(sources?.toolDetail("spawn_agent", { name: "Explore", template_id: "explore" }, {
    content: [{ type: "text", text: JSON.stringify({ ok: true, data: { agent_id: "3d1f726e-df7d-49f8-b2d5-792af4edc58c" } }) }],
  })).toMatchObject({ type: "sub_agent", childSessionId: "wj:3d1f726e-df7d-49f8-b2d5-792af4edc58c" });
  sources?.close();
});
