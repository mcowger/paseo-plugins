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
  appendedEntries: Array<{ customType: string; data: unknown }> = [];
  compactCalls: Array<string | undefined> = [];
  navigations: string[] = [];
  navigateResult: unknown = {};
  reloads = 0;
  leafId: string | null = null;
  aborts = 0;
  model: unknown = TEST_MODEL;
  thinkingLevel = "medium";
  autoCompactionEnabled = true;
  autoRetryEnabled = true;
  sessionFile = "/tmp/session.jsonl";
  sessionName: string | undefined;
  messages: unknown[] = [];
  entries: unknown[] = [];
  branchEntries: unknown[] | null = null;
  sessionManager = {
    appendSessionInfo: (name: string) => {
      this.sessionName = name;
      return `session-info-${name}`;
    },
    getSessionName: () => this.sessionName,
  };
  modelRuntime = {
    getModel: (provider: string, id: string) => ({ provider, id, reasoning: true }),
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
  async reload(): Promise<void> {
    this.reloads += 1;
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
  async navigateTree(targetId: string): Promise<unknown> {
    this.navigations.push(targetId);
    this.leafId = targetId;
    return this.navigateResult;
  }
  getSessionStats() {
    return {
      sessionId: "session-1",
      userMessages: 2,
      assistantMessages: 3,
      toolCalls: 4,
      toolResults: 4,
      totalMessages: 5,
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
    appendSessionInfo: (name: string) => {
      fake.sessionName = name;
      return `session-info-${name}`;
    },
    getSessionName: () => fake.sessionName,
  } as unknown as SessionManager;
}

function createHarness() {
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
    promptCommands: [
      { name: "compact", description: "Compact" },
      { name: "settings", description: "Settings" },
      { name: "reload", description: "Reload" },
      { name: "session", description: "Session" },
      { name: "name", description: "Name" },
    ],
  };
  const session = new PiProviderSession({
    sessionId: "s1",
    bundle,
    config,
    models: [TEST_MODEL],
    reloadCommands: () => [{ name: "reload", description: "Reloaded" }],
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
  it("executes typed compact slash commands without starting a turn", async () => {
    const { fake, session, events } = createHarness();
    await session.handlePrompt(messagePrompt(" /compact  keep it short "));

    expect(fake.compactCalls).toEqual(["keep it short"]);
    expect(fake.prompts).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "session.prompt_result",
      clientMessageId: "cm-1",
      result: { type: "completed" },
    }));
  });

  it("executes typed settings slash commands", async () => {
    const { fake, session } = createHarness();
    await session.handlePrompt(messagePrompt("/settings auto-retry off"));

    expect(fake.autoRetryEnabled).toBe(false);
    expect(fake.prompts).toHaveLength(0);
  });

  it("rejects malformed settings slash commands", async () => {
    const { fake, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("/settings"));

    expect(fake.prompts).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "session.prompt_result",
      result: { type: "failed", error: { message: expect.stringContaining("Usage:") } },
    }));
  });

  it("reloads Pi resources and republishes slash commands", async () => {
    const { fake, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("/reload"));

    expect(fake.reloads).toBe(1);
    expect(events).toContainEqual({
      type: "session.commands",
      sessionId: "s1",
      commands: [{ name: "reload", description: "Reloaded" }],
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "session.prompt_result",
      result: { type: "completed" },
    }));
  });

  it("reports Pi session stats", async () => {
    const { session, events } = createHarness();
    await session.handlePrompt(messagePrompt("/session"));

    expect(events).toContainEqual(expect.objectContaining({
      type: "timeline.item",
      item: expect.objectContaining({
        type: "assistant_message",
        text: expect.stringContaining("Messages: 5 (2 user, 3 assistant)"),
      }),
    }));
  });

  it("sets the Pi session display name", async () => {
    const { fake, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("/name  release prep  "));

    expect(fake.sessionName).toBe("release prep");
    expect(events).toContainEqual(expect.objectContaining({
      type: "session.prompt_result",
      result: { type: "completed" },
    }));
  });

  it("rejects an empty session name", async () => {
    const { fake, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("/name"));

    expect(fake.sessionName).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({
      type: "session.prompt_result",
      result: { type: "failed", error: { message: "Usage: /name <name>" } },
    }));
  });

  it("applies runtime settings from configure", async () => {
    const { fake, session } = createHarness();
    await session.configure({ settings: { autoCompaction: "off", autoRetry: "off" } });
    expect(fake.autoCompactionEnabled).toBe(false);
    expect(fake.autoRetryEnabled).toBe(false);
    expect(session.configState().settings).toEqual([
      expect.objectContaining({
        id: "autoCompaction",
        label: "Compact",
        value: "off",
        options: [
          { label: "Compact ✓", value: "on" },
          { label: "Compact ×", value: "off" },
        ],
      }),
      expect.objectContaining({
        id: "autoRetry",
        label: "Retry",
        value: "off",
        options: [
          { label: "Retry ✓", value: "on" },
          { label: "Retry ×", value: "off" },
        ],
      }),
    ]);
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
    expect(
      (configEvent as Extract<ProviderEvent, { type: "session.config" }>).config.settings,
    ).toContainEqual(expect.objectContaining({ id: "autoRetry", value: "off" }));
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
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]?.text).toContain("/settings auto-retry off");
  });
});

describe("PiProviderSession model configuration", () => {
  it("does not expose named modes", () => {
    const { session } = createHarness();
    expect(session.configState().modes).toEqual([]);
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

  it("interrupts and executes a native slash command while steering", async () => {
    const { fake, session, events } = createHarness();
    fake.onPrompt = () => {
      fake.emitEvent({ type: "turn_start" } as AgentSessionEvent);
      fake.onPrompt = null;
    };
    await session.handlePrompt(messagePrompt("start"));
    await session.handlePrompt(messagePrompt("/settings auto-retry off", "cm-3", "steer"));
    expect(fake.aborts).toBe(1);
    expect(fake.prompts).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "session.prompt_result",
      clientMessageId: "cm-3",
      result: { type: "completed" },
    }));
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
    const { fake, session, events } = createHarness();
    fake.entries.push({
      type: "message",
      id: "entry-1",
      message: { role: "user", content: "first prompt" },
    });
    await session.revertConversation("entry-1");
    expect(fake.navigations).toEqual(["entry-1"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.persistence",
        persistence: expect.objectContaining({
          data: expect.objectContaining({ leafId: "entry-1" }),
        }),
      }),
    );
  });

  it("rejects rewind targets from an abandoned branch", async () => {
    const { fake, session } = createHarness();
    const abandoned = {
      type: "message",
      id: "abandoned-entry",
      message: { role: "user", content: "abandoned" },
    };
    fake.entries.push(abandoned);
    fake.branchEntries = [];

    await expect(session.revertConversation("abandoned-entry")).rejects.toThrow(
      /not on the active branch/,
    );
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
