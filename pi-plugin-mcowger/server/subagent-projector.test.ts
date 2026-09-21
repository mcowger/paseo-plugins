import { describe, expect, test } from "vitest";

import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

import { NicoSubagentProjector } from "./subagent-projector.js";

function createProjector(enabled = true) {
  const events: ProviderEvent[] = [];
  const projector = new NicoSubagentProjector({
    rootSessionId: "root",
    cwd: "/workspace",
    enabled,
    emit: (event) => events.push(event),
  });
  projector.markRootReady();
  return { projector, events };
}

function update(index = 0, status = "running") {
  return {
    content: [{ type: "text", text: "Reading package.json" }],
    details: {
      runId: "run-1",
      progress: [{
        index,
        agent: "scout",
        sessionName: "Scout session",
        status,
        model: "openai/gpt:low",
        thinking: "low",
        inputTokens: 10,
        outputTokens: 5,
        currentTool: "read",
        currentToolArgs: "package.json",
        currentPath: "/workspace/package.json",
        recentTools: [],
        recentOutput: [],
      }],
    },
  };
}

describe("NicoSubagentProjector", () => {
  test("requires the delegation fingerprint and opens a child once", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent", "subagent", { agent: "scout", task: "Inspect package.json" });
    projector.observeUpdate("parent", { details: {} });
    expect(events).toHaveLength(0);

    projector.observeUpdate("parent", update());
    projector.observeUpdate("parent", update());

    expect(events.filter((event) => event.type === "session.opened")).toHaveLength(1);
    expect(events.filter((event) => event.type === "session.ready")).toHaveLength(1);
    expect(events.filter((event) => event.type === "session.turn" && event.state === "started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "timeline.item" && event.item.type === "assistant_message")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "timeline.item",
      item: expect.objectContaining({ type: "user_message", text: "Inspect package.json" }),
    }));
  });

  test("keeps child identity independent of the parent tool and supports multiple indices", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent", "subagent", {});
    projector.observeUpdate("parent", update(0));
    projector.observeUpdate("parent", update(1));

    const opened = events.filter((event): event is Extract<ProviderEvent, { type: "session.opened" }> => event.type === "session.opened");
    expect(new Set(opened.map((event) => event.sessionId)).size).toBe(2);
    expect(opened.every((event) => event.parentSessionId === "root")).toBe(true);
  });

  test("uses workflow keys when workflow child results reuse index zero", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent", "subagent", {});
    projector.observeEnd("parent", {
      content: [{ type: "text", text: "Run fan-out: 3/64 used, 61 remaining\nWorkflow completed." }],
      details: {
        mode: "workflow",
        runId: "workflow-run",
        results: [
          { index: 0, workflowKey: "num-agent-1", agent: "delegate", exitCode: 0, finalOutput: "My number: 51" },
          { index: 0, workflowKey: "num-agent-2", agent: "delegate", exitCode: 0, finalOutput: "My number: 42" },
          { index: 0, workflowKey: "num-agent-3", agent: "delegate", exitCode: 0, finalOutput: "My number: 65" },
        ],
        workflowChildren: {
          children: [
            { childId: "num-agent-1", state: "completed", agent: "delegate" },
            { childId: "num-agent-2", state: "completed", agent: "delegate" },
            { childId: "num-agent-3", state: "completed", agent: "delegate" },
          ],
        },
      },
    }, false);

    const children = events.filter((event): event is Extract<ProviderEvent, { type: "session.opened" }> => event.type === "session.opened");
    expect(children).toHaveLength(3);
    expect(new Set(children.map((event) => event.sessionId)).size).toBe(3);
    const previews = events.filter((event): event is Extract<ProviderEvent, { type: "timeline.item" }> => event.type === "timeline.item")
      .map((event) => event.item)
      .filter((item): item is Extract<typeof item, { type: "assistant_message" }> => item.type === "assistant_message")
      .map((item) => item.text);
    expect(previews).toEqual(expect.arrayContaining(["My number: 51", "My number: 42", "My number: 65"]));
    expect(previews).not.toContain("Run fan-out: 3/64 used, 61 remaining\nWorkflow completed.");
    expect(events.filter((event) => event.type === "session.turn" && event.state === "completed")).toHaveLength(3);
  });

  test("projects workflowChildren when terminal result records are compacted away", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent", "subagent", {});
    projector.observeEnd("parent", {
      details: {
        mode: "workflow",
        runId: "workflow-children-only",
        results: [],
        workflowChildren: {
          children: [
            { childId: "alpha", state: "completed", agent: "scout", sessionName: "Scout alpha", model: "openai/gpt", thinking: "high" },
            { childId: "beta", state: "failed", agent: "reviewer", sessionName: "Review beta", model: "openai/gpt", thinking: "low" },
          ],
        },
      },
    }, false);

    const opened = events.filter((event): event is Extract<ProviderEvent, { type: "session.opened" }> => event.type === "session.opened");
    expect(opened).toHaveLength(2);
    expect(opened).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "scout", description: "Scout alpha" }),
      expect.objectContaining({ title: "reviewer", description: "Review beta" }),
    ]));
    expect(events).toContainEqual(expect.objectContaining({ type: "session.turn", state: "completed" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "session.turn", state: "failed" }));
  });

  test("maps terminal failure and emits it after the active tool closes", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent", "subagent", {});
    projector.observeUpdate("parent", update());
    projector.observeEnd("parent", update(0, "running"), true);

    const childEvents = events.filter((event) => event.type !== "session.opened" && event.type !== "session.ready");
    const terminalTurn = childEvents.findIndex((event) => event.type === "session.turn" && event.state === "failed");
    const toolCompletion = childEvents.findIndex((event) => event.type === "timeline.item" && event.item.type === "tool_call" && event.item.status === "failed");
    expect(toolCompletion).toBeGreaterThanOrEqual(0);
    expect(terminalTurn).toBeGreaterThan(toolCompletion);
  });

  test("fails the recorded active tool when the parent tool ends in error", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent", "subagent", {});
    projector.observeEnd("parent", {
      details: {
        runId: "run-parent-error",
        results: [{
          index: 0,
          agent: "scout",
          toolCalls: [{ expandedText: "$ pwd" }],
          progress: { index: 0, agent: "scout", status: "running", currentTool: "bash", currentToolArgs: "pwd" },
        }],
      },
    }, true);

    const tools = events.filter((event): event is Extract<ProviderEvent, { type: "timeline.item" }> => event.type === "timeline.item")
      .map((event) => event.item)
      .filter((item) => item.type === "tool_call");
    expect(tools.at(-1)).toMatchObject({ name: "bash", status: "failed" });
  });

  test("keeps the recorded tool detail when a root lifecycle failure closes it", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent", "subagent", {});
    projector.observeUpdate("parent", {
      details: {
        runId: "run-root-error",
        results: [{
          index: 0,
          agent: "scout",
          toolCalls: [{ expandedText: 'read {"path":"package.json"}' }],
          progress: { index: 0, agent: "scout", status: "running", currentTool: "read", currentToolArgs: "package.json" },
        }],
      },
    });
    projector.finishActive("failed");

    const tools = events.filter((event): event is Extract<ProviderEvent, { type: "timeline.item" }> => event.type === "timeline.item")
      .map((event) => event.item)
      .filter((item) => item.type === "tool_call");
    expect(tools.at(-1)).toMatchObject({
      name: "read",
      detail: { type: "read", filePath: "package.json" },
      status: "failed",
      error: "Subagent failed",
    });
  });

  test("projects summary tools with their native Paseo detail shapes", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent", "subagent", { task: "List files" });
    projector.observeUpdate("parent", {
      details: {
        runId: "run-1",
        progress: [{
          index: 0,
          agent: "scout",
          status: "running",
          currentTool: "bash",
          currentToolArgs: "pwd && printf '\\nTop-level entries:\\n'",
          currentPath: "/workspace",
          recentTools: [],
          recentOutput: ["README.md", "src/"],
        }],
      },
    });

    const tools = events.filter((event): event is Extract<ProviderEvent, { type: "timeline.item" }> => event.type === "timeline.item")
      .map((event) => event.item)
      .filter((item) => item.type === "tool_call");
    expect(tools[0]).toMatchObject({
      name: "bash",
      detail: { type: "shell", command: "pwd && printf '\\nTop-level entries:\\n'" },
    });
    expect(events.filter((event) => event.type === "timeline.item" && event.item.type === "assistant_message")).toHaveLength(0);
  });

  test("uses child-scoped terminal output and tool records instead of the aggregate parent report", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent", "subagent", { task: "Inspect package.json" });
    projector.observeEnd("parent", {
      content: [{ type: "text", text: "Run fan-out: 1/64 used" }],
      details: {
        runId: "run-terminal",
        results: [{
          index: 0,
          agent: "scout",
          task: "[prompt redacted]",
          finalOutput: "The package name is pi-plugin-mcowger.",
          toolCalls: [{ text: "$ cat package.json", expandedText: "$ cat package.json" }],
          usage: { input: 2, output: 8, cacheRead: 4, cost: 0.01, turns: 1 },
        }],
      },
    }, false);

    const items = events.filter((event): event is Extract<ProviderEvent, { type: "timeline.item" }> => event.type === "timeline.item").map((event) => event.item);
    expect(items).toContainEqual(expect.objectContaining({ type: "user_message", text: "Inspect package.json" }));
    expect(items).toContainEqual(expect.objectContaining({ type: "assistant_message", text: "The package name is pi-plugin-mcowger." }));
    expect(items).not.toContainEqual(expect.objectContaining({ type: "assistant_message", text: "Run fan-out: 1/64 used" }));
    expect(items).toContainEqual(expect.objectContaining({ type: "tool_call", name: "bash", detail: { type: "shell", command: "cat package.json" } }));
  });

  test("uses the live child tool snapshot and reconciles it with current and recent tools", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent", "subagent", { task: "List files" });
    projector.observeUpdate("parent", {
      content: [{ type: "text", text: "Working directory and top-level listing — pulling that now." }],
      details: {
        runId: "run-live-tools",
        results: [{
          index: 0,
          agent: "delegate",
          task: "[prompt redacted]",
          toolCalls: [
            { expandedText: "$ pwd" },
            { expandedText: 'ls {"path":"/workspace"}' },
          ],
          progress: {
            index: 0,
            agent: "delegate",
            status: "running",
            currentTool: "ls",
            currentToolArgs: "/workspace",
            recentTools: [{ tool: "bash", args: "pwd", endMs: 1 }],
            recentOutput: ["Working directory and top-level listing — pulling that now."],
          },
        }],
      },
    });

    const tools = events.filter((event): event is Extract<ProviderEvent, { type: "timeline.item" }> => event.type === "timeline.item")
      .map((event) => event.item)
      .filter((item) => item.type === "tool_call");
    expect(tools).toEqual([
      expect.objectContaining({ name: "bash", detail: { type: "shell", command: "pwd" }, status: "completed" }),
      expect.objectContaining({ name: "ls", detail: { type: "plain_text", label: "ls", text: "/workspace", icon: "wrench" }, status: "running" }),
    ]);
    expect(tools.filter((tool) => tool.name === "bash")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "timeline.item",
      item: expect.objectContaining({ type: "assistant_message", text: "Working directory and top-level listing — pulling that now." }),
    }));
  });

  test("uses child-scoped tool IDs and treats shell summaries as bash", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent-a", "subagent", {});
    projector.observeStart("parent-b", "subagent", {});
    const details = {
      details: {
        runId: "run-shared-tools",
        results: [{
          index: 0,
          agent: "scout",
          toolCalls: [{ expandedText: '$ printf "ok"' }],
          progress: {
            index: 0,
            agent: "scout",
            status: "running",
            currentTool: "shell",
            currentToolArgs: 'printf "ok"',
          },
        }],
      },
    };
    projector.observeUpdate("parent-a", details);
    projector.observeUpdate("parent-b", {
      details: {
        ...details.details,
        runId: "run-second-child",
      },
    });

    const tools = events.filter((event): event is Extract<ProviderEvent, { type: "timeline.item" }> => event.type === "timeline.item")
      .flatMap((event) => event.item.type === "tool_call" ? [event.item] : []);
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((tool) => tool.id)).size).toBe(2);
    expect(tools.every((tool) => tool.name === "bash" && tool.status === "running")).toBe(true);
  });

  test("keeps a recorded tool active when its display argument is compacted", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent", "subagent", {});
    projector.observeUpdate("parent", {
      details: {
        runId: "run-compacted-argument",
        results: [{
          index: 0,
          agent: "scout",
          toolCalls: [{ expandedText: 'grep {"pattern":"very long pattern that the live display compacted"}' }],
          progress: {
            index: 0,
            agent: "scout",
            status: "running",
            currentTool: "grep",
            currentToolArgs: "very long pattern...",
          },
        }],
      },
    });

    const tools = events.filter((event): event is Extract<ProviderEvent, { type: "timeline.item" }> => event.type === "timeline.item")
      .flatMap((event) => event.item.type === "tool_call" ? [event.item] : []);
    expect(tools).toEqual([
      expect.objectContaining({ name: "grep", status: "running" }),
    ]);
  });

  test("preserves live progress usage when result usage is also present", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent", "subagent", {});
    projector.observeUpdate("parent", {
      details: {
        runId: "run-usage",
        results: [{
          index: 0,
          agent: "scout",
          usage: { input: 10, output: 5, cacheRead: 4, cacheWrite: 2, cost: 0.1, turns: 3 },
          progress: {
            index: 0,
            agent: "scout",
            status: "running",
            inputTokens: 11,
            outputTokens: 6,
            tokens: 17,
            window: 15,
            windowPeak: 16,
            turnCount: 4,
            toolCount: 2,
            durationMs: 100,
            lastActivityAt: 50,
          },
        }],
      },
    });

    const usage = events.find((event): event is Extract<ProviderEvent, { type: "session.usage" }> => event.type === "session.usage");
    expect(usage?.usage).toEqual({
      inputTokens: 11,
      outputTokens: 6,
      cachedInputTokens: 4,
      totalCostUsd: 0.1,
      contextWindowUsedTokens: 15,
    });
  });

  test("uses terminal progress summaries without treating aggregate output as child text", () => {
    const { projector, events } = createProjector();
    projector.observeStart("parent", "subagent", {});
    projector.observeEnd("parent", {
      content: [{ type: "text", text: "Run fan-out: 1/64 used" }],
      details: {
        runId: "run-progress-summary",
        results: [{
          index: 0,
          agent: "scout",
          progressSummary: { toolCount: 2, tokens: 23, durationMs: 123 },
          usage: { input: 20, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 },
        }],
      },
    }, false);

    const assistantItems = events.filter((event): event is Extract<ProviderEvent, { type: "timeline.item" }> => event.type === "timeline.item")
      .map((event) => event.item)
      .filter((item) => item.type === "assistant_message");
    expect(assistantItems).toEqual([]);
    expect(events.some((event) => event.type === "session.turn" && event.state === "completed")).toBe(true);
  });

  test("cancels active children and does not publish when capability is absent", () => {
    const disabled = createProjector(false);
    disabled.projector.observeStart("parent", "subagent", {});
    disabled.projector.observeUpdate("parent", update());
    expect(disabled.events).toHaveLength(0);

    const active = createProjector();
    active.projector.observeStart("parent", "subagent", {});
    active.projector.observeUpdate("parent", update());
    active.projector.cancelActive();
    expect(active.events.filter((event) => event.type === "session.turn" && event.state === "canceled")).toHaveLength(1);
  });
});

test("retires stale delegations at turn end", () => {
  const { projector } = createProjector();
  // A `subagent` tool call that never produces an end event (interrupt,
  // process exit, dropped envelope) must not suppress legacy terminal
  // detection on every later turn.
  projector.observeStart("parent", "subagent", { task: "stale" });
  expect(projector.hasActiveWork()).toBe(true);

  projector.finishActive("completed");
  expect(projector.hasActiveWork()).toBe(false);
});
