import { describe, expect, it } from "vitest";
import { parsePiSubagentCall, piSubagentOperation } from "./pi-subagents";
import { expansionTargetForToolCall, resolveSubAgentActionPresentation, resolveToolCallPresentation } from "./presentation";

const result = "Agent: 44066ba2c296\nType: explore | Status: completed | Tool uses: 2 | 14 token\nDescription: inspect payloads\n\npong";
const waitProgress = "Agent: f4815d0d77b2\nOperation: wait\nType: reviewer | Status: running\nDescription: Review subagent display changes";
const waitResult = waitProgress.replace("running", "completed")
  + "\nTool uses: 41 | 72.6k token | Context: 6% | Duration: 206.5s\n\n**Reviewed**\n- Found an issue";

describe("pi-subagents operations", () => {
  it("identifies blocking waits from translated live progress before completion", () => {
    expect(parsePiSubagentCall(undefined, waitProgress)).toMatchObject({
      operation: "wait", wait: true, agentId: "f4815d0d77b2", agentType: "reviewer",
      description: "Review subagent display changes", status: "running", body: "",
    });
    expect(resolveToolCallPresentation({ name: "get_subagent_result", detail: { type: "sub_agent", log: waitProgress } }))
      .toMatchObject({ label: "Wait for Agent", summary: "reviewer · Review subagent display changes · running" });
  });

  it("preserves wait identity and parses the new completion stats line", () => {
    expect(parsePiSubagentCall(undefined, waitResult)).toMatchObject({
      wait: true, toolUses: 41, tokens: "72.6k", context: "6%", duration: "206.5s",
      body: "**Reviewed**\n- Found an issue",
    });
    expect(resolveToolCallPresentation({ name: "get_subagent_result", detail: { type: "sub_agent", log: waitResult } }))
      .toMatchObject({ label: "Wait for Agent", summary: "reviewer · Review subagent display changes · completed" });
  });

  it("distinguishes non-blocking result checks and falls back to the target ID", () => {
    const progress = waitProgress.replace("Operation: wait", "Operation: result").replace("Description: Review subagent display changes", "Description: ");
    expect(parsePiSubagentCall(undefined, progress)).toMatchObject({ operation: "result", wait: false });
    expect(resolveToolCallPresentation({ name: "get_subagent_result", detail: { type: "sub_agent", log: progress } }))
      .toMatchObject({ label: "Check Agent Result", summary: "reviewer · f4815d0d77b2 · running" });
    expect(resolveToolCallPresentation({ name: "get_subagent_result", detail: { type: "unknown", input: {}, output: {
      content: [{ type: "text", text: progress }], details: { description: "" },
    } } })).toMatchObject({ summary: "reviewer · f4815d0d77b2 · running" });
  });

  it("parses million-token completion metrics", () => {
    expect(parsePiSubagentCall(undefined, waitResult.replace("72.6k", "1.2M")).tokens).toBe("1.2M");
  });

  it("uses structured operation details when no text header is available", () => {
    expect(parsePiSubagentCall(undefined, { details: {
      agentId: "target-id", operation: "wait", subagentType: "worker", description: "Implement changes", status: "running",
    } })).toMatchObject({ operation: "wait", wait: true, lifecycle: true, agentId: "target-id" });
  });

  it("structures new steering progress, confirmation, and rejection bodies", () => {
    const header = waitProgress.replace("Operation: wait", "Operation: steer");
    expect(parsePiSubagentCall(undefined, header)).toMatchObject({ operation: "steer", body: "", notice: undefined });
    expect(parsePiSubagentCall(undefined, header + "\n\nSteering message sent to agent f4815d0d77b2. The agent will process it after its current tool execution.\nCurrent state: 14 token · 2 tool uses · context 1% full"))
      .toMatchObject({ body: "", notice: "Steering message sent. It will be processed after the current tool execution." });
    expect(parsePiSubagentCall(undefined, header.replace("running", "completed") + '\n\nAgent "f4815d0d77b2" is not running (status: completed). Cannot steer a non-running agent.'))
      .toMatchObject({ body: "", error: "Cannot steer a non-running agent.", status: "completed" });
  });

  it("does not infer wait mode from result body text or unknown operation values", () => {
    expect(parsePiSubagentCall(undefined, result + "\nOperation: wait").wait).toBeUndefined();
    expect(parsePiSubagentCall(undefined, waitProgress.replace("Operation: wait", "Operation: unexpected")).operation).toBeUndefined();
  });

  it("structures dispatch without showing coordination boilerplate as a result", () => {
    expect(parsePiSubagentCall({}, "Agent started in background.\nAgent ID: f4815d0d77b2\nType: reviewer\nDescription: Review changes\nOutput file: /tmp/run.jsonl\n\nPaseo gets a completion notification when this agent finishes, but it won't wake you:\nYou MUST call get_subagent_result with wait: true for this agent before finishing.\nDo not duplicate this agent's work."))
      .toMatchObject({ status: "background", outputFile: "/tmp/run.jsonl", body: "", lifecycle: true });
  });

  it("handles queued dispatch and deprecated background notes", () => {
    const text = "Note: run_in_background is deprecated and ignored; every child runs in the background so its transcript can stream. Use get_subagent_result with wait: true to block for the result.\n\nAgent queued in background.\nAgent ID: abc123\nType: worker\nDescription: Work\nOutput file: /tmp/run.jsonl\nPosition: queued (max 2 concurrent)\n\nDo not duplicate this agent's work.";
    expect(parsePiSubagentCall({}, text)).toMatchObject({ agentId: "abc123", status: "queued", lifecycle: true, body: "" });
  });

  it("preserves real child reasoning and action logs", () => {
    for (const text of ["Investigating the implementation", "[Read] a.ts\n[Edit] b.ts"]) {
      expect(parsePiSubagentCall({}, text)).toMatchObject({ lifecycle: false, body: text });
    }
    expect(parsePiSubagentCall({}, "Description: a thought\nType: an idea\n\nError: mentioned in reasoning"))
      .toMatchObject({ description: undefined, agentType: undefined, error: undefined });
    expect(parsePiSubagentCall({}, result.replace("pong", "Error: discussed in answer")))
      .toMatchObject({ error: undefined, body: "Error: discussed in answer" });
  });

  it("structures completion metrics separately from markdown results", () => {
    expect(parsePiSubagentCall({}, "Agent: c1060d595b3f\nType: worker | Status: completed | Tool uses: 135 | 169.4k token | Context: 16% | Duration: 453.8s\nDescription: Implement backend\n\n**Implemented**\n- Change one"))
      .toMatchObject({ toolUses: 135, tokens: "169.4k", context: "16%", duration: "453.8s", body: "**Implemented**\n- Change one", lifecycle: true });
  });

  it("structures steering rejection and execution errors", () => {
    expect(parsePiSubagentCall({}, 'Agent "c1060d595b3f" is not running (status: completed). Cannot steer a non-running agent.'))
      .toMatchObject({ status: "completed", error: "Cannot steer a non-running agent.", body: "", lifecycle: true });
    expect(parsePiSubagentCall({}, result.replace("completed", "error").replace("pong", "Error: provider unavailable")))
      .toMatchObject({ error: "provider unavailable", body: "" });
  });

  it("parses real result text, envelopes, and JSON input", () => {
    expect(parsePiSubagentCall('{"agent_id":"44066ba2c296","wait":true}', {
      content: [{ type: "text", text: result }], details: null,
    })).toMatchObject({ agentId: "44066ba2c296", agentType: "explore", status: "completed", description: "inspect payloads", wait: true });
    expect(parsePiSubagentCall("invalid json", null).agentId).toBeUndefined();
  });

  it.each([
    ["Agent", { description: "inspect payloads" }, "Dispatch Agent", "Bot"],
    ["get_subagent_result", { wait: true }, "Wait for Agent", "Hourglass"],
    ["get_subagent_result", { wait: false }, "Check Agent Result", "Hourglass"],
    ["get_subagent_result", {}, "Agent Result", "Hourglass"],
    ["steer_subagent", {}, "Steer Agent", "MessageCircle"],
  ])("labels unknown %s calls", (name, input, label, icon) => {
    expect(resolveToolCallPresentation({ name, detail: { type: "unknown", input, output: result } }))
      .toMatchObject({ category: "agent", label, icon, summary: "inspect payloads · completed" });
  });

  it.each(["Agent", "get_subagent_result", "steer_subagent"])("labels translated and nested %s calls", (name) => {
    const label = name === "Agent" ? "Dispatch Agent" : name === "steer_subagent" ? "Steer Agent" : "Agent Result";
    expect(resolveToolCallPresentation({ name, detail: { type: "sub_agent", log: result } }))
      .toMatchObject({ label, summary: "inspect payloads · completed" });
    expect(resolveSubAgentActionPresentation(`functions.${name}`)).toMatchObject({ label });
    expect(expansionTargetForToolCall(`mcp__plugin__${name}`, "unknown")).toBe("sub_agent");
  });

  it("keeps OpenCode and supervisor calls separate", () => {
    expect(piSubagentOperation("subagent")).toBeUndefined();
    expect(piSubagentOperation("subagent_supervisor")).toBeUndefined();
  });

  it("does not mistake answer content for header metadata", () => {
    const parsed = parsePiSubagentCall({}, `${result}\nDescription: wrong\nStatus: wrong`);
    expect(parsed.description).toBe("inspect payloads");
    expect(parsed.status).toBe("completed");
    expect(parsed.body).toBe("pong\nDescription: wrong\nStatus: wrong");
    expect(parsePiSubagentCall({}, "ordinary answer\n\nDescription: wrong").description).toBeUndefined();
    expect(parsePiSubagentCall({}, result.replace("completed", "stopped (output is partial)")).status).toBe("stopped");
  });

  it("parses steering and missing-agent targets", () => {
    for (const text of [
      'Steering message sent to agent 44066ba2c296. The agent will process it after its current tool execution.',
      'Agent not found: "44066ba2c296". It may have been cleaned up.',
      'Agent "44066ba2c296" is not running (status: completed). Cannot steer a non-running agent.',
    ]) expect(parsePiSubagentCall({}, text).agentId).toBe("44066ba2c296");
  });

  it("retains the translated dispatch type fallback", () => {
    expect(resolveToolCallPresentation({ name: "Agent", detail: { type: "sub_agent", subAgentType: "explore", log: "" } }))
      .toMatchObject({ label: "Dispatch Agent", summary: "explore" });
    expect(parsePiSubagentCall({}, { content: [{ type: "text", text: "Agent started in background.\nType: Agent" }],
      details: { subagentType: "explore" } }).agentType).toBe("explore");
  });
});
