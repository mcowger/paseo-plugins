import { describe, expect, it, vi } from "vitest";

import type { ProviderEvent, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";

import type {
  PiAgentMessage,
  PiModel,
  PiPromptAck,
  PiRpcSlashCommand,
  PiRuntimeEvent,
  PiSessionState,
  PiSessionStats,
} from "../shared/rpc-types.js";
import type { PiRuntimeSession } from "./runtime.js";
import { PiProviderSession } from "./session.js";

class FakeRuntimeSession implements PiRuntimeSession {
  private listeners = new Set<(event: PiRuntimeEvent) => void>();
  sentFrames: Array<Record<string, unknown>> = [];
  prompts: Array<{ message: string }> = [];
  steers: string[] = [];
  state: PiSessionState = {
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    sessionId: "pi-session-1",
    sessionFile: "/tmp/session.jsonl",
    messageCount: 0,
    pendingMessageCount: 0,
    model: { provider: "anthropic", id: "claude", reasoning: true },
  };
  commands: PiRpcSlashCommand[] = [];
  messages: PiAgentMessage[] = [];
  models: PiModel[] = [{ provider: "anthropic", id: "claude", reasoning: true }];

  onEvent(callback: (event: PiRuntimeEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  emitEvent(event: PiRuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async prompt(message: string): Promise<PiPromptAck> {
    this.prompts.push({ message });
    return { requestId: "req_prompt", agentInvoked: true };
  }

  async steer(message: string): Promise<void> {
    this.steers.push(message);
  }

  async clearQueue(): Promise<void> {}
  async abort(): Promise<void> {}
  async getState(): Promise<PiSessionState> {
    return this.state;
  }
  async getMessages(): Promise<PiAgentMessage[]> {
    return this.messages;
  }
  async getEntries(): Promise<{ entries: unknown[]; leafId: string | null }> {
    return { entries: this.entries, leafId: null };
  }
  entries: unknown[] = [];
  async getAvailableModels(): Promise<PiModel[]> {
    return this.models;
  }
  async getAvailableThinkingLevels(): Promise<string[]> {
    return ["off", "medium", "high"];
  }
  async setModel(provider: string, modelId: string): Promise<PiModel> {
    this.setModelCalls.push({ provider, modelId });
    const model: PiModel = { provider, id: modelId, reasoning: true };
    this.state = { ...this.state, model };
    return model;
  }
  setModelCalls: Array<{ provider: string; modelId: string }> = [];
  thinkingLevels: string[] = [];
  async setThinkingLevel(level: string): Promise<void> {
    this.thinkingLevels.push(level);
    this.state = { ...this.state, thinkingLevel: level as PiSessionState["thinkingLevel"] };
  }
  async getSessionStats(): Promise<PiSessionStats> {
    return {};
  }
  async getCommands(): Promise<PiRpcSlashCommand[]> {
    return this.commands;
  }
  async request(): Promise<unknown> {
    return {};
  }
  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void {
    this.sentFrames.push({ type: "extension_ui_response", id, ...response });
  }
  async close(): Promise<void> {}
}

function createHarness(
  options: {
    commands?: PiRpcSlashCommand[];
    presets?: ConstructorParameters<typeof PiProviderSession>[0]["presets"];
  } = {},
) {
  const runtime = new FakeRuntimeSession();
  runtime.commands = options.commands ?? [];
  const events: ProviderEvent[] = [];
  const config: ProviderSessionConfig = {
    cwd: "/tmp/work",
    env: {},
    mcpServers: {},
    settings: {},
    persist: true,
  };
  const session = new PiProviderSession({
    sessionId: "s1",
    runtimeSession: runtime,
    config,
    initialState: runtime.state,
    piModels: runtime.models,
    ...(options.presets ? { presets: options.presets } : {}),
    emit: (event) => events.push(event),
    onRuntimeFailed: () => {},
  });
  return { runtime, session, events };
}

function messagePrompt(text: string, clientMessageId = "cm-1", delivery: "auto" | "steer" = "auto") {
  return {
    clientMessageId,
    delivery,
    input: { type: "message" as const, content: [{ type: "text" as const, text }] },
  };
}

describe("PiProviderSession turn flow", () => {
  it("emits prompt_result + turn lifecycle and streams assistant snapshots", async () => {
    const { runtime, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("hello"));

    expect(events[0]).toMatchObject({
      type: "session.prompt_result",
      clientMessageId: "cm-1",
      result: { type: "turn" },
    });
    expect(events[1]).toMatchObject({ type: "session.turn", state: "started" });
    const turnId = (events[0] as { result: { turnId: string } }).result.turnId;

    runtime.emitEvent({ type: "turn_start" });
    runtime.emitEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    runtime.emitEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: " world" },
    });
    runtime.emitEvent({ type: "agent_end", messages: [], willRetry: false });
    runtime.emitEvent({ type: "agent_settled" });

    const snapshots = events.filter(
      (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
        event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].item).toMatchObject({ text: "Hello" });
    expect(snapshots[1].item).toMatchObject({ text: "Hello world", id: snapshots[0].item.id });

    expect(events.at(-1)).toMatchObject({ type: "session.turn", turnId, state: "completed" });
  });

  it("emits reasoning snapshots with stable ids", async () => {
    const { runtime, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("think"));
    runtime.emitEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    });
    runtime.emitEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: " hmm" },
    });
    const reasoning = events.filter(
      (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
        event.type === "timeline.item" && event.item.type === "reasoning",
    );
    expect(reasoning).toHaveLength(2);
    expect(reasoning[1].item).toMatchObject({ text: "hmm hmm", id: reasoning[0].item.id });
  });

  it("fails the turn when pi reports an error", async () => {
    const { runtime, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("boom"));
    runtime.emitEvent({ type: "turn_start" });
    runtime.emitEvent({
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "assistant", content: [], errorMessage: "rate limited", stopReason: "error" },
      ],
    });
    runtime.emitEvent({ type: "agent_settled" });
    expect(events.at(-1)).toMatchObject({
      type: "session.turn",
      state: "failed",
      error: { message: expect.stringContaining("rate limited") },
    });
  });
});

describe("PiProviderSession commands", () => {
  it("forwards command prompts as slash commands", async () => {
    const { runtime, session } = createHarness();
    await session.handlePrompt({
      clientMessageId: "cm-cmd",
      delivery: "auto",
      input: { type: "command", name: "preset", arguments: "research" },
    });
    expect(runtime.prompts[0].message).toBe("/preset research");
  });

  it("filters internal paseo commands from the published command list", async () => {
    const { session } = createHarness({
      commands: [
        { name: "preset", description: "Switch preset", source: "extension" },
        { name: "paseo_tree", description: "internal", source: "extension" },
        { name: "paseo_capture_entries", description: "internal", source: "extension" },
        { name: "compact", description: "Compact", source: "prompt" },
      ],
    });
    const commands = await session.listCommands();
    expect(commands.map((command) => command.name)).toEqual(["preset", "compact"]);
  });
});

describe("PiProviderSession todos", () => {
  it("emits a native todo item when the todo tool completes", async () => {
    const { runtime, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("do tasks"));
    runtime.emitEvent({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "todo",
      args: { action: "set" },
    });
    runtime.emitEvent({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "todo",
      result: {
        content: [{ type: "text", text: "ok" }],
        details: { tasks: [{ id: 1, subject: "Plan", status: "in_progress" }] },
      },
    });
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
});

describe("PiProviderSession permissions", () => {
  it("routes extension UI select requests and responses", async () => {
    const { runtime, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("ask"));
    runtime.emitEvent({
      type: "extension_ui_request",
      id: "ui-1",
      method: "select",
      title: "Pick one",
      options: ["a", "b"],
    });
    const permission = events.find((event) => event.type === "session.permission");
    expect(permission).toMatchObject({
      request: { id: "ui-1", kind: "question", title: "Pick one" },
    });

    session.respondToPermission("ui-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "b" } },
    });
    expect(runtime.sentFrames).toContainEqual({
      type: "extension_ui_response",
      id: "ui-1",
      value: "b",
    });
    expect(events.at(-1)).toMatchObject({
      type: "session.permission_resolved",
      permissionId: "ui-1",
    });
  });
});

describe("PiProviderSession presets as modes", () => {
  it("exposes presets as modes in config state", () => {
    const withPresets = new PiProviderSession({
      sessionId: "s2",
      runtimeSession: new FakeRuntimeSession(),
      config: {
        cwd: "/tmp/work",
        env: {},
        mcpServers: {},
        settings: {},
        persist: true,
      },
      initialState: new FakeRuntimeSession().state,
      piModels: [],
      presets: { plan: { provider: "openai", model: "gpt-5.2", thinkingLevel: "high" } },
      initialMode: "plan",
      emit: () => {},
      onRuntimeFailed: () => {},
    });
    const config = withPresets.configState();
    expect(config.modes).toEqual([
      {
        id: "plan",
        label: "Plan",
        icon: "Bot",
        description: "openai/gpt-5.2 · thinking: high",
      },
    ]);
    expect(config.mode).toBe("plan");
  });

  it("applies a preset on configure(mode) and refreshes state", async () => {
    const { runtime, session } = createHarness({ presets: { plan: { model: "gpt-5.2" } } });
    await session.configure({ mode: "plan" });
    expect(runtime.prompts.at(-1)?.message).toBe("/preset plan");
  });

  it("propagates preset model + thinking into the emitted session.config", async () => {
    const { runtime, session, events } = createHarness({
      presets: {
        plan: { provider: "plexus", model: "gpt-5.6-sol", thinkingLevel: "high" },
      },
    });
    await session.configure({ mode: "plan" });

    expect(runtime.prompts[0].message).toBe("/preset plan");
    expect(runtime.setModelCalls).toEqual([{ provider: "plexus", modelId: "gpt-5.6-sol" }]);
    expect(runtime.thinkingLevels).toContain("high");

    const configEvent = events.findLast((event) => event.type === "session.config");
    expect(configEvent).toMatchObject({
      config: {
        model: "plexus/gpt-5.6-sol",
        mode: "plan",
        thinkingOption: "high",
      },
    });
  });

  it("rejects unknown presets", async () => {
    const { session } = createHarness();
    await expect(session.configure({ mode: "nope" })).rejects.toThrow(/Unknown pi preset/);
  });
});

describe("PiProviderSession shutdown", () => {
  it("does not report runtime failure when the process exit follows our own close", async () => {
    const runtime = new FakeRuntimeSession();
    const failures: unknown[] = [];
    const session = new PiProviderSession({
      sessionId: "s-close",
      runtimeSession: runtime,
      config: { cwd: "/tmp/work", env: {}, mcpServers: {}, settings: {}, persist: true },
      initialState: runtime.state,
      piModels: [],
      emit: () => {},
      onRuntimeFailed: (error) => failures.push(error),
    });
    await session.close();
    runtime.emitEvent({ type: "process_exit", error: "Pi RPC process exited with code 143" });
    expect(failures).toEqual([]);
  });

  it("reports runtime failure on unexpected process exit", () => {
    const runtime = new FakeRuntimeSession();
    const failures: unknown[] = [];
    new PiProviderSession({
      sessionId: "s-crash",
      runtimeSession: runtime,
      config: { cwd: "/tmp/work", env: {}, mcpServers: {}, settings: {}, persist: true },
      initialState: runtime.state,
      piModels: [],
      emit: () => {},
      onRuntimeFailed: (error) => failures.push(error),
    });
    runtime.emitEvent({ type: "process_exit", error: "segmentation fault" });
    expect(failures).toEqual([{ message: "segmentation fault" }]);
  });
});

describe("PiProviderSession steering", () => {
  it("steers an active turn", async () => {
    const { runtime, session, events } = createHarness();
    await session.handlePrompt(messagePrompt("start"));
    runtime.emitEvent({ type: "turn_start" });
    await session.handlePrompt(messagePrompt("more context", "cm-2", "steer"));
    expect(runtime.steers).toEqual(["more context"]);
    expect(events.at(-1)).toMatchObject({
      type: "session.prompt_result",
      clientMessageId: "cm-2",
      result: { type: "steer" },
    });
  });

  it("interrupts and restarts when steering a slash command", async () => {
    const { runtime, session } = createHarness();
    await session.handlePrompt(messagePrompt("start"));
    runtime.emitEvent({ type: "turn_start" });
    const abortSpy = vi.spyOn(runtime, "abort");
    await session.handlePrompt(messagePrompt("/compact", "cm-3", "steer"));
    expect(abortSpy).toHaveBeenCalled();
    expect(runtime.prompts.at(-1)?.message).toBe("/compact");
  });
});
