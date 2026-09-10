import { describe, expect, it } from "vitest";

import type {
  AgentSession,
  AgentSessionEvent,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ProviderEvent, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";

import type { PiModel } from "../shared/rpc-types.js";
import { PiProviderSession, type SdkSessionBundle } from "./session.js";

const TEST_MODEL: PiModel = { provider: "anthropic", id: "claude", reasoning: true };

class FakeSdkSession {
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  prompts: Array<{ text: string }> = [];
  steers: string[] = [];
  setModelCalls: string[] = [];
  thinkingLevels: string[] = [];
  activeTools: string[][] = [];
  appendedEntries: Array<{ customType: string; data: unknown }> = [];
  compactCalls: Array<string | undefined> = [];
  navigations: string[] = [];
  navigateResult: unknown = {};
  leafId: string | null = null;
  aborts = 0;
  model: unknown = TEST_MODEL;
  thinkingLevel = "medium";
  autoCompactionEnabled = true;
  autoRetryEnabled = true;
  sessionFile = "/tmp/session.jsonl";
  messages: unknown[] = [];
  entries: unknown[] = [];
  branchEntries: unknown[] | null = null;
  modelRuntime = {
    getModel: (provider: string, id: string) => ({ provider, id, reasoning: true }),
  };
  agent = {
    state: { systemPrompt: "base system prompt" },
  };

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitEvent(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async bindExtensions(): Promise<void> {}
  async prompt(text: string): Promise<void> {
    this.prompts.push({ text });
    this.onPrompt?.();
  }
  onPrompt: (() => void) | null = null;
  async steer(text: string): Promise<void> {
    this.steers.push(text);
  }
  async abort(): Promise<void> {
    this.aborts += 1;
  }
  async compact(instructions?: string): Promise<unknown> {
    this.compactCalls.push(instructions);
    return {};
  }
  async setModel(model: { provider: string; id: string }): Promise<void> {
    this.setModelCalls.push(`${model.provider}/${model.id}`);
    this.model = model;
  }
  setThinkingLevel(level: string): void {
    this.thinkingLevels.push(level);
    this.thinkingLevel = level;
  }
  setAutoCompactionEnabled(enabled: boolean): void {
    this.autoCompactionEnabled = enabled;
  }
  setAutoRetryEnabled(enabled: boolean): void {
    this.autoRetryEnabled = enabled;
  }
  setActiveToolsByName(tools: string[]): void {
    this.activeTools.push(tools);
  }
  getAllTools(): Array<{ name: string }> {
    return [{ name: "read" }, { name: "grep" }, { name: "mcp_linear_search" }];
  }
  getActiveToolNames(): string[] {
    return this.activeTools.at(-1) ?? ["read", "bash", "edit", "write"];
  }
  async navigateTree(targetId: string): Promise<unknown> {
    this.navigations.push(targetId);
    this.leafId = targetId;
    return this.navigateResult;
  }
  getSessionStats() {
    return {
      tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, total: 15 },
      cost: 0.01,
    };
  }
  dispose(): void {}
}

function makeSessionManager(fake: FakeSdkSession): SessionManager {
  return {
    getEntries: () => fake.entries,
    getBranch: () => fake.branchEntries ?? fake.entries,
    getLeafId: () => fake.leafId,
    getEntry: (id: string) =>
      fake.entries.find((entry) => (entry as { id?: string }).id === id) ?? null,
    branch: (id: string) => {
      fake.leafId = id;
    },
    resetLeaf: () => {
      fake.leafId = null;
    },
    appendCustomEntry: (customType: string, data?: unknown) => {
      fake.appendedEntries.push({ customType, data });
      return `entry-${fake.appendedEntries.length}`;
    },
  } as unknown as SessionManager;
}

function createHarness(options: { presets?: Record<string, never> | Record<string, object> } = {}) {
  const fake = new FakeSdkSession();
  const events: ProviderEvent[] = [];
  const config: ProviderSessionConfig = {
    cwd: "/tmp/work",
    env: {},
    mcpServers: {},
    settings: {},
    persist: true,
  };
  const bundle: SdkSessionBundle = {
    session: fake as unknown as AgentSession,
    sessionManager: makeSessionManager(fake),
    mcp: null,
    presets: (options.presets ?? {}) as SdkSessionBundle["presets"],
    promptCommands: [
      { name: "compact", description: "Compact" },
      { name: "preset", description: "Preset" },
    ],
  };
  const session = new PiProviderSession({
    sessionId: "s1",
    bundle,
    config,
    models: [TEST_MODEL],
    emit: (event) => events.push(event),
  });
  return { fake, session, events };
}

function messagePrompt(text: string, clientMessageId = "cm-1", delivery: "auto" | "steer" = "auto") {
  return {
    clientMessageId,
    delivery,
    input: { type: "message" as const, content: [{ type: "text" as const, text }] },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("PiProviderSession turn flow", () => {
  it("emits prompt_result + turn lifecycle and streams assistant snapshots", async () => {
    const { fake, session, events } = createHarness();
    fake.onPrompt = () => {
      fake.emitEvent({ type: "turn_start" } as AgentSessionEvent);
      fake.emitEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello" },
      } as AgentSessionEvent);
      fake.emitEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: " world" },
      } as AgentSessionEvent);
      fake.emitEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      } as unknown as AgentSessionEvent);
    };
    await session.handlePrompt(messagePrompt("hello"));
    fake.onPrompt = null;

    expect(events[0]).toMatchObject({
      type: "session.prompt_result",
      clientMessageId: "cm-1",
      result: { type: "turn" },
    });
    const turnId = (events[0] as { result: { turnId: string } }).result.turnId;

    const snapshots = events.filter(
      (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
        event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1].item).toMatchObject({ text: "Hello world", id: snapshots[0].item.id });

    expect(events.find((event) => event.type === "session.turn" && event.state !== "started")).toMatchObject({
      type: "session.turn",
      turnId,
      state: "completed",
    });
    expect(events.some((event) => event.type === "session.usage")).toBe(true);
  });

  it("completes the turn from prompt() resolution when no agent events arrive", async () => {
    const { fake, session, events } = createHarness();
    // prompt resolves without any agent activity (extension command path)
    await session.handlePrompt(messagePrompt("/noop"));
    await flush();
    await flush();
    const terminal = events.find(
      (event) => event.type === "session.turn" && event.state !== "started",
    );
    expect(terminal).toBeDefined();
    expect(fake.prompts[0].text).toBe("/noop");
  });

  it("fails the turn when pi reports an error", async () => {
    const { fake, session, events } = createHarness();
    fake.onPrompt = () => {
      fake.emitEvent({ type: "turn_start" } as AgentSessionEvent);
      fake.emitEvent({
        type: "agent_end",
        willRetry: false,
        messages: [
          { role: "assistant", content: [], errorMessage: "rate limited", stopReason: "error" },
        ],
      } as unknown as AgentSessionEvent);
    };
    await session.handlePrompt(messagePrompt("boom"));
    fake.onPrompt = null;
    expect(events.find((event) => event.type === "session.turn" && event.state !== "started")).toMatchObject({
      type: "session.turn",
      state: "failed",
      error: { message: expect.stringContaining("rate limited") },
    });
  });
});

describe("PiProviderSession user identity", () => {
  it("emits the persisted Pi entry id for a submitted user message", async () => {
    const { fake, session, events } = createHarness();
    const userMessage = { role: "user", content: "hello" } as const;
    fake.onPrompt = () => {
      fake.emitEvent({ type: "turn_start" } as AgentSessionEvent);
      fake.entries.push({ type: "message", id: "entry-1", message: userMessage });
      fake.emitEvent({ type: "message_end", message: userMessage } as AgentSessionEvent);
      fake.onPrompt = null;
    };

    await session.handlePrompt(messagePrompt("hello"));
    await flush();

    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "s1",
      item: {
        type: "user_message",
        id: "entry-1",
        messageId: "entry-1",
        revertToken: "entry-1",
        text: "hello",
        clientMessageId: "cm-1",
      },
    });
  });
});

describe("PiProviderSession commands", () => {
  it("applies presets natively for the preset command", async () => {
    const { fake, session, events } = createHarness({
      presets: {
        plan: {
          id: "plan",
          name: "Plan",
          model: "plexus/gpt-5.6-sol",
          thinkingLevel: "high",
        },
      },
    });
    await session.handlePrompt({
      clientMessageId: "cm-p",
      delivery: "auto",
      input: { type: "command", name: "preset", arguments: "plan" },
    });
    expect(fake.setModelCalls).toEqual(["plexus/gpt-5.6-sol"]);
    expect(fake.thinkingLevels).toContain("high");
    expect(fake.appendedEntries).toEqual([
      {
        customType: "paseo-command-anchor",
        data: { text: "/preset plan" },
      },
      {
        customType: "paseo-command",
        data: { text: "/preset plan", anchorId: "entry-1" },
      },
      { customType: "preset-state", data: { name: "plan" } },
    ]);
    expect(events.some((e) => e.type === "session.prompt_result")).toBe(true);
  });

  it("applies runtime settings from configure", async () => {
    const { fake, session } = createHarness();
    await session.configure({ settings: { autoCompaction: false, autoRetry: false } });
    expect(fake.autoCompactionEnabled).toBe(false);
    expect(fake.autoRetryEnabled).toBe(false);
    expect(session.configState().settings).toEqual([]);
  });

  it("intercepts the compact command", async () => {
    const { fake, session } = createHarness();
    await session.handlePrompt({
      clientMessageId: "cm-c",
      delivery: "auto",
      input: { type: "command", name: "compact", arguments: "keep it short" },
    });
    expect(fake.compactCalls).toEqual(["keep it short"]);
    expect(fake.prompts).toHaveLength(0);
  });

  it("applies runtime settings from the composer command path", async () => {
    const { fake, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("/settings auto-retry off"));
    expect(fake.autoRetryEnabled).toBe(false);
    const configEvent = events.at(-1);
    expect(configEvent).toMatchObject({ type: "session.config" });
    expect((configEvent as Extract<ProviderEvent, { type: "session.config" }>).config.settings).toEqual([]);
  });

  it("normalizes the setting name in composer commands", async () => {
    const { fake, session } = createHarness();
    await session.handlePrompt(messagePrompt("/settings AUTO-COMPACTION off"));
    expect(fake.autoCompactionEnabled).toBe(false);
    expect(fake.autoRetryEnabled).toBe(true);
  });

  it("does not intercept settings commands in multimodal prompts", async () => {
    const { fake, session } = createHarness();
    await session.handlePrompt({
      ...messagePrompt("/settings auto-retry off"),
      input: {
        type: "message",
        content: [
          { type: "text", text: "/settings auto-retry off" },
          { type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
        ],
      },
    } as never);
    expect(fake.autoRetryEnabled).toBe(true);
    expect(fake.prompts[0]?.text).toContain("/settings auto-retry off");
  });
});

describe("PiProviderSession presets as modes", () => {
  it("exposes presets as modes with the active mode in config state", () => {
    const { session } = createHarness({
      presets: {
        plan: {
          id: "plan",
          name: "Plan",
          model: "openai/gpt-5.2",
          thinkingLevel: "high",
        },
      },
    });
    const config = session.configState();
    expect(config.modes).toEqual([
      { id: "plan", label: "Plan", icon: "Bot", description: "openai/gpt-5.2 · thinking: high" },
    ]);
  });

  it("applies a preset on configure(mode): model, thinking, tools, instructions", async () => {
    const { fake, session, events } = createHarness({
      presets: {
        plan: {
          id: "plan",
          name: "Plan",
          model: "plexus/gpt-5.6-sol",
          thinkingLevel: "high",
          tools: ["read", "mcp_*"],
          appendSystemPrompt: "Plan first.",
        },
      },
    });
    await session.configure({ mode: "plan" });
    expect(fake.setModelCalls).toEqual(["plexus/gpt-5.6-sol"]);
    expect(fake.thinkingLevels).toContain("high");
    expect(fake.activeTools).toEqual([["read", "mcp_linear_search"]]);
    expect(fake.agent.state.systemPrompt).toBe("base system prompt\n\nPlan first.");

    const configEvent = events.findLast((event) => event.type === "session.config");
    expect(configEvent).toMatchObject({
      config: { model: "plexus/gpt-5.6-sol", mode: "plan", thinkingOption: "high" },
    });
  });

  it("announces a live preset change and marks manual overrides as modified", async () => {
    const { fake, session } = createHarness({
      presets: {
        plan: {
          id: "plan",
          name: "Plan",
          model: "anthropic/claude",
          thinkingLevel: "high",
          appendSystemPrompt: "Follow the plan.",
        },
      },
    });

    await session.configure({ mode: "plan" });
    await session.configure({ thinkingOption: "low" });
    expect(session.configState().modes[0]?.label).toBe("Plan (modified)");

    await session.handlePrompt(messagePrompt("continue"));
    expect(fake.prompts[0]?.text).toBe(
      "NOTE: YOUR PRESET MODE HAS CHANGED TO Plan. FOLLOW ITS INSTRUCTIONS:\nFollow the plan.\n\ncontinue",
    );
  });

  it("clamps thinking when the composer changes to a narrower model", async () => {
    const { fake, session } = createHarness();
    fake.modelRuntime.getModel = (provider, id) => ({
      provider,
      id,
      reasoning: true,
      thinkingLevelMap: { medium: null, high: null },
    });
    fake.thinkingLevel = "medium";

    await session.configure({ model: "anthropic/narrow" });

    expect(fake.thinkingLevels.at(-1)).toBe("low");
    expect(session.configState().thinkingOption).toBe("low");
  });

  it("marks an edited active preset and reports when it is deleted", async () => {
    const { session, events } = createHarness({
      presets: {
        plan: {
          id: "plan",
          name: "Plan",
          model: "anthropic/claude",
          thinkingLevel: "medium",
          appendSystemPrompt: "Plan first.",
        },
      },
    });
    await session.configure({ mode: "plan" });
    session.updatePresets({
      plan: {
        id: "plan",
        name: "Plan",
        model: "anthropic/claude",
        thinkingLevel: "medium",
        appendSystemPrompt: "Plan differently.",
      },
    });
    await flush();
    expect(session.configState().modes[0]?.label).toBe("Plan (modified)");

    session.updatePresets({});
    await flush();
    expect(session.configState().mode).toBeUndefined();
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "notification" &&
          event.item.level === "warning",
      ),
    ).toBe(true);
  });

  it("rejects unknown presets", async () => {
    const { session } = createHarness();
    await expect(session.configure({ mode: "nope" })).rejects.toThrow(/Unknown pi preset/);
  });

  it("restores the active preset from preset-state entries on construction", () => {
    const fake = new FakeSdkSession();
    fake.entries.push({ type: "custom", customType: "preset-state", data: { name: "plan" } });
    const restored = new PiProviderSession({
      sessionId: "s2",
      bundle: {
        session: fake as unknown as AgentSession,
        sessionManager: makeSessionManager(fake),
        mcp: null,
        presets: {
          plan: {
            id: "plan",
            name: "Plan",
            model: "anthropic/m",
            thinkingLevel: "medium",
          },
        },
        promptCommands: [],
      },
      config: { cwd: "/tmp/work", env: {}, mcpServers: {}, settings: {}, persist: true },
      models: [TEST_MODEL],
      emit: () => {},
    });
    expect(restored.configState().mode).toBe("plan");
  });
});

describe("PiProviderSession todos", () => {
  it("emits a native todo item when the todo tool completes", async () => {
    const { fake, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("do tasks"));
    fake.emitEvent({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "todo",
      args: { action: "set" },
    } as unknown as AgentSessionEvent);
    fake.emitEvent({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "todo",
      result: {
        content: [{ type: "text", text: "ok" }],
        details: { tasks: [{ id: 1, subject: "Plan", status: "in_progress" }] },
      },
    } as unknown as AgentSessionEvent);
    const todo = events.find(
      (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
        event.type === "timeline.item" && event.item.type === "todo",
    );
    expect(todo).toMatchObject({
      item: {
        type: "todo",
        id: "pi-todos",
        items: [{ id: "1", text: "Plan", status: "in_progress", completed: false }],
      },
    });
  });

  it("emits an empty native todo item when all tasks are cleared", async () => {
    const { fake, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("clear tasks"));
    fake.emitEvent({
      type: "tool_execution_end",
      toolCallId: "tc-clear",
      toolName: "todo",
      result: {
        content: [{ type: "text", text: "Cleared all todos" }],
        details: { todos: [] },
      },
    } as unknown as AgentSessionEvent);

    const todo = events.findLast(
      (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
        event.type === "timeline.item" && event.item.type === "todo",
    );
    expect(todo).toEqual({
      type: "timeline.item",
      sessionId: "s1",
      item: { type: "todo", id: "pi-todos", items: [] },
    });
  });
});

describe("PiProviderSession permissions", () => {
  it("routes extension UI select requests and responses", async () => {
    const { fake, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("ask"));
    void fake;
    // dialog path is exercised through the uiContext bridge; simulate via
    // the internal requestDialog by triggering respondToPermission plumbing:
    const dialogPromise = (
      session as unknown as { requestDialog(d: unknown): Promise<unknown> }
    ).requestDialog({ method: "select", title: "Pick one", options: ["a", "b"] });
    const permission = events.find((event) => event.type === "session.permission");
    expect(permission).toBeDefined();
    const permissionId = (permission as { request: { id: string } }).request.id;
    session.respondToPermission(permissionId, {
      behavior: "allow",
      updatedInput: { answers: { Response: "b" } },
    });
    expect(events.at(-1)).toMatchObject({
      type: "session.permission_resolved",
      permissionId,
    });
    await expect(dialogPromise).resolves.toEqual({ kind: "value", value: "b" });
  });
});

describe("PiProviderSession steering", () => {
  it("steers an active turn", async () => {
    const { fake, session, events } = createHarness();
    fake.onPrompt = () => {
      fake.emitEvent({ type: "turn_start" } as AgentSessionEvent);
      fake.onPrompt = null;
    };
    await session.handlePrompt(messagePrompt("start"));
    await session.handlePrompt(messagePrompt("more context", "cm-2", "steer"));
    expect(fake.steers).toEqual(["more context"]);
    expect(events.at(-1)).toMatchObject({
      type: "session.prompt_result",
      clientMessageId: "cm-2",
      result: { type: "steer" },
    });
  });

  it("interrupts and restarts when steering a slash command", async () => {
    const { fake, session } = createHarness();
    fake.onPrompt = () => {
      fake.emitEvent({ type: "turn_start" } as AgentSessionEvent);
      fake.onPrompt = null;
    };
    await session.handlePrompt(messagePrompt("start"));
    await session.handlePrompt(messagePrompt("/preset plan", "cm-3", "steer"));
    expect(fake.aborts).toBe(1);
    expect(fake.prompts.at(-1)?.text).toBe("/preset plan");
  });
});

describe("PiProviderSession replay", () => {
  it("persists the active branch leaf for resume", () => {
    const { fake, session } = createHarness();
    fake.leafId = "entry-c";
    expect(session.persistence).toEqual({
      version: 2,
      data: {
        sessionFile: "/tmp/session.jsonl",
        leafId: "entry-c",
        cwd: "/tmp/work",
      },
    });
  });

  it("replays only the active Pi branch", async () => {
    const { fake, session, events } = createHarness();
    const first = { type: "message", id: "entry-a", message: { role: "user", content: "first" } };
    const abandoned = {
      type: "message",
      id: "entry-b",
      message: { role: "user", content: "abandoned" },
    };
    const replacement = {
      type: "message",
      id: "entry-c",
      message: { role: "user", content: "replacement" },
    };
    fake.entries.push(first, abandoned, replacement);
    fake.branchEntries = [first, replacement];
    fake.messages = [
      { role: "user", content: "first" },
      { role: "assistant", responseId: "answer-a", content: [{ type: "text", text: "one" }] },
      { role: "user", content: "replacement" },
      { role: "assistant", responseId: "answer-c", content: [{ type: "text", text: "two" }] },
    ];

    await session.replayHistory();

    const users = events
      .filter(
        (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
          event.type === "timeline.item" && event.item.type === "user_message",
      )
      .map((event) => event.item);
    expect(users).toEqual([
      { type: "user_message", id: "entry-a", text: "first", messageId: "entry-a", revertToken: "entry-a" },
      {
        type: "user_message",
        id: "entry-c",
        text: "replacement",
        messageId: "entry-c",
        revertToken: "entry-c",
      },
    ]);
  });

  it("replays command rows with their anchor token", async () => {
    const { fake, session, events } = createHarness();
    fake.branchEntries = [
      { type: "message", id: "entry-a", message: { role: "user", content: "first" } },
      {
        type: "custom",
        id: "command-1",
        customType: "paseo-command",
        data: { text: "/compact", anchorId: "anchor-1" },
      },
    ];
    fake.messages = [{ role: "user", content: "first" }];

    await session.replayHistory();

    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "s1",
      item: {
        type: "user_message",
        id: "command-1",
        messageId: "command-1",
        revertToken: "anchor-1",
        text: "/compact",
      },
    });
  });
});

describe("PiProviderSession rewind", () => {
  it("rewinds via navigateTree for known entries", async () => {
    const { fake, session } = createHarness();
    fake.entries.push({
      type: "message",
      id: "entry-1",
      message: { role: "user", content: "first prompt" },
    });
    await session.revertConversation("entry-1");
    expect(fake.navigations).toEqual(["entry-1"]);
  });

  it("rejects unknown rewind targets", async () => {
    const { session } = createHarness();
    await expect(session.revertConversation("missing")).rejects.toThrow(/not found/);
  });

  it("rejects non-user rewind targets", async () => {
    const { fake, session } = createHarness();
    fake.entries.push({ type: "message", id: "assistant-1", message: { role: "assistant" } });
    await expect(session.revertConversation("assistant-1")).rejects.toThrow(/not a user message/);
  });

  it("does not commit a canceled tree navigation", async () => {
    const { fake, session } = createHarness();
    fake.entries.push({
      type: "message",
      id: "entry-1",
      message: { role: "user", content: "first prompt" },
    });
    fake.navigateResult = { cancelled: true };
    await expect(session.revertConversation("entry-1")).rejects.toThrow(/not selected/);
  });

  it("forwards fork chat history before the new prompt", async () => {
    const { fake, session } = createHarness();
    await session.handlePrompt({
      clientMessageId: "fork-message",
      delivery: "auto",
      input: {
        type: "message",
        content: [
          {
            type: "text",
            mimeType: "text/plain",
            contextKind: "chat_history",
            title: "Chat history",
            text: "<chat-history-summary>\nPrevious work\n</chat-history-summary>",
          },
          { type: "text", text: "Continue from here" },
        ],
      },
    });
    expect(fake.prompts[0]?.text).toBe(
      "<chat-history-summary>\nPrevious work\n</chat-history-summary>\n\nContinue from here",
    );
  });
});
