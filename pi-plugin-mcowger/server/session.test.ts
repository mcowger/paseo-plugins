import { expect, test } from "vitest";

import type { ProviderEvent, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";

import type { PiRpcSlashCommand, PiRuntimeEvent, PiSessionState } from "./rpc-types.js";
import type { PiRuntimeSession } from "./runtime.js";
import { PiProviderSession } from "./session.js";

function createRuntime(options: {
  abortError?: Error;
  commands?: PiRpcSlashCommand[];
  prompt?: (message: string, emit: (event: PiRuntimeEvent) => void) => void;
} = {}) {
  const listeners = new Set<(event: PiRuntimeEvent) => void>();
  const emit = (event: PiRuntimeEvent) => { for (const listener of listeners) listener(event); };
  const runtime: PiRuntimeSession = {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt(message) { options.prompt?.(message, emit); return {}; },
    async steer() {},
    async clearQueue() {},
    async compact() {},
    async setAutoCompaction() {},
    async setAutoRetry() {},
    async abort() { if (options.abortError) throw options.abortError; },
    async getState() { return state; },
    async getMessages() { return []; },
    async getAvailableModels() { return []; },
    async setModel() { throw new Error("unused"); },
    async setThinkingLevel() {},
    async getSessionStats() { return {}; },
    async getCommands() { return options.commands ?? []; },
    respondToExtensionUiRequest() {},
    async close() {},
  };
  return { runtime, emit };
}

const state: PiSessionState = {
  sessionId: "pi-session",
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  messageCount: 0,
  pendingMessageCount: 0,
};

const config: ProviderSessionConfig = {
  cwd: "/workspace",
  env: {},
  mcpServers: {},
  settings: {},
  persist: true,
};

function createSession(
  runtime: PiRuntimeSession,
  events: ProviderEvent[],
  settings: ProviderSessionConfig["settings"] = {},
) {
  return new PiProviderSession({
    sessionId: "paseo-session",
    config: { ...config, settings },
    runtime,
    state: { ...state },
    models: [],
    emit: (event) => events.push(event),
    cleanup() {},
  });
}

test("applies initial composer settings to Pi", async () => {
  const calls: string[] = [];
  const { runtime } = createRuntime();
  runtime.setAutoCompaction = async (enabled) => { calls.push(`compact:${enabled}`); };
  runtime.setAutoRetry = async (enabled) => { calls.push(`retry:${enabled}`); };
  const session = createSession(runtime, [], { autoCompaction: "on", autoRetry: "on" });

  await session.initialize();

  expect(calls).toEqual(["compact:true", "retry:true"]);
  await session.close();
});

test("publishes the built-in compact command", async () => {
  const { runtime } = createRuntime();
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.initialize();

  expect(events.find((event) => event.type === "session.commands")).toMatchObject({
    commands: [
      {
        name: "compact",
        description: "Manually compact the session context",
        argumentHint: "[instructions]",
      },
    ],
  });
  await session.close();
});

test("executes compact through Pi RPC and forwards compaction lifecycle events", async () => {
  const { runtime, emit } = createRuntime();
  let instructions: string | undefined;
  runtime.compact = async (customInstructions) => {
    instructions = customInstructions;
    emit({ type: "compaction_start", reason: "manual" });
    emit({ type: "compaction_end", reason: "manual" });
  };
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.prompt({
    clientMessageId: "compact-1",
    delivery: "auto",
    input: { type: "command", name: "compact", arguments: "focus on tests" },
  });

  expect(instructions).toBe("focus on tests");
  expect(events.filter((event) => event.type === "timeline.item").map((event) => event.item)).toEqual([
    { type: "compaction", id: expect.any(String), status: "loading", trigger: "manual" },
    { type: "compaction", id: expect.any(String), status: "completed", trigger: "manual" },
  ]);
  const compactionItems = events
    .filter((event): event is Extract<ProviderEvent, { type: "timeline.item" }> => event.type === "timeline.item")
    .map((event) => event.item)
    .filter((item) => item.type === "compaction");
  expect(compactionItems[0]?.id).toBe(compactionItems[1]?.id);
  expect(events).toContainEqual({
    type: "session.prompt_result",
    sessionId: "paseo-session",
    clientMessageId: "compact-1",
    result: { type: "completed" },
  });
  expect(events.some((event) => event.type === "session.turn")).toBe(false);
  await session.close();
});

test("closes a compact loading item when Pi compact fails after starting", async () => {
  const { runtime, emit } = createRuntime();
  runtime.compact = async () => {
    emit({ type: "compaction_start", reason: "manual" });
    throw new Error("summarizer failed");
  };
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.prompt({
    clientMessageId: "compact-2",
    delivery: "auto",
    input: { type: "command", name: "compact", arguments: "" },
  });

  expect(events.filter((event) => event.type === "timeline.item").map((event) => event.item)).toEqual([
    { type: "compaction", id: expect.any(String), status: "loading", trigger: "manual" },
    { type: "compaction", id: expect.any(String), status: "completed", trigger: "manual" },
  ]);
  expect(events).toContainEqual({
    type: "session.prompt_result",
    sessionId: "paseo-session",
    clientMessageId: "compact-2",
    result: { type: "failed", error: { message: "Failed to compact context: summarizer failed" } },
  });
  await session.close();
});

test("emits composer settings for auto-compaction and retry", async () => {
  const { runtime } = createRuntime();
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.initialize();

  expect(events.find((event) => event.type === "session.config")).toMatchObject({
    config: {
      modes: [{ id: "build", label: "Build" }],
      settings: [
        {
          type: "toggle",
          id: "autoCompaction",
          label: "Compact",
          value: false,
        },
        {
          type: "toggle",
          id: "autoRetry",
          label: "Retry",
          value: false,
        },
      ],
    },
  });
  expect(events.find((event) => event.type === "session.config")).not.toHaveProperty("config.mode");
  await session.close();
});

test("probes and exposes fast mode only for a supported model", async () => {
  const commands: PiRpcSlashCommand[] = [
    { name: "fast", source: "extension" },
    { name: "fast-status", source: "extension" },
  ];
  const requests: string[] = [];
  const { runtime } = createRuntime({
    commands,
    prompt(message, emit) {
      requests.push(message);
      if (message.startsWith("/fast-status ")) {
        emit({
          type: "extension_ui_request",
          id: "status",
          method: "notify",
          message: JSON.stringify({
            type: "pi-gpt-fast-mode.status",
            requestId: message.slice("/fast-status ".length),
            enabled: false,
            model: "openai-codex/gpt-5.6",
            supported: true,
          }),
        });
      }
    },
  });
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.initialize();

  expect(requests).toHaveLength(1);
  expect(events.find((event) => event.type === "session.config")).toMatchObject({
    config: { settings: [{ id: "autoCompaction" }, { id: "autoRetry" }, { id: "fastMode", value: false }] },
  });

  await session.configure({ settings: { fastMode: "on" } });
  expect(requests).toHaveLength(3);
  expect(requests[1]).toBe("/fast on");
  expect(requests[2]).toMatch(/^\/fast-status /);
  await session.close();
});

test("does not expose fast mode when its commands are absent", async () => {
  const { runtime } = createRuntime({ commands: [{ name: "fast", source: "extension" }] });
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.initialize();

  expect(events.find((event) => event.type === "session.config")).not.toMatchObject({
    config: { settings: expect.arrayContaining([{ id: "fastMode" }]) },
  });
  await session.close();
});

test("does not expose fast mode when the installed extension reports an unsupported model", async () => {
  const { runtime } = createRuntime({
    commands: [
      { name: "fast", source: "extension" },
      { name: "fast-status", source: "extension" },
    ],
    prompt(message, emit) {
      if (!message.startsWith("/fast-status ")) return;
      emit({
        type: "extension_ui_request",
        id: "status",
        method: "notify",
        message: JSON.stringify({
          type: "pi-gpt-fast-mode.status",
          requestId: message.slice("/fast-status ".length),
          enabled: false,
          model: "anthropic/claude-opus-4-8",
          supported: false,
        }),
      });
    },
  });
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.initialize();

  expect(events.find((event) => event.type === "session.config")).not.toMatchObject({
    config: { settings: expect.arrayContaining([{ id: "fastMode" }]) },
  });
  await session.close();
});

test("probes and exposes long context, then refreshes effective Pi state after toggling", async () => {
  const commands: PiRpcSlashCommand[] = [
    { name: "long-context", source: "extension" },
    { name: "long-context-status", source: "extension" },
  ];
  const requests: string[] = [];
  let enabled = false;
  const model = { provider: "openai", id: "gpt-5.6-sol", contextWindow: 272_000 };
  const { runtime } = createRuntime({
    commands,
    prompt(message, emit) {
      requests.push(message);
      if (message.startsWith("/long-context-status ")) {
        enabled = enabled || requests.includes("/long-context");
        emit({
          type: "extension_ui_request",
          id: "status",
          method: "notify",
          message: JSON.stringify({
            type: "pi-openai-long-context.status",
            requestId: message.slice("/long-context-status ".length),
            enabled,
            supported: true,
            provider: model.provider,
            model: model.id,
            contextWindow: enabled ? 1_050_000 : model.contextWindow,
          }),
        });
      }
    },
  });
  runtime.getState = async () => ({ ...state, model: { ...model, contextWindow: enabled ? 1_050_000 : model.contextWindow } });
  runtime.getAvailableModels = async () => [{ ...model }];
  runtime.getSessionStats = async () => ({ contextUsage: { contextWindow: enabled ? 1_050_000 : model.contextWindow } });
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.initialize();

  expect(events.find((event) => event.type === "session.config")).toMatchObject({
    config: {
      models: [{ id: "openai/gpt-5.6-sol", contextWindowMaxTokens: 272_000 }],
      settings: expect.arrayContaining([expect.objectContaining({ id: "longContext", value: false })]),
    },
  });

  await session.configure({ settings: { longContext: "on" } });

  expect(requests).toHaveLength(3);
  expect(requests[1]).toBe("/long-context");
  expect(requests[2]).toMatch(/^\/long-context-status /);
  expect(events.at(-1)).toMatchObject({
    type: "session.config",
    config: {
      models: [{ id: "openai/gpt-5.6-sol", contextWindowMaxTokens: 1_050_000 }],
      settings: expect.arrayContaining([expect.objectContaining({ id: "longContext", value: true })]),
    },
  });
  expect(events.some((event) => event.type === "session.usage" && event.usage.contextWindowMaxTokens === 1_050_000)).toBe(true);
  await session.close();
});

test("does not expose long context when its commands are absent", async () => {
  const { runtime } = createRuntime({ commands: [{ name: "long-context", source: "extension" }] });
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.initialize();

  expect(events.find((event) => event.type === "session.config")).not.toMatchObject({
    config: { settings: expect.arrayContaining([{ id: "longContext" }]) },
  });
  await session.close();
});

test("does not expose long context when the installed extension reports an unsupported model", async () => {
  const { runtime } = createRuntime({
    commands: [
      { name: "long-context", source: "extension" },
      { name: "long-context-status", source: "extension" },
    ],
    prompt(message, emit) {
      if (!message.startsWith("/long-context-status ")) return;
      emit({
        type: "extension_ui_request",
        id: "status",
        method: "notify",
        message: JSON.stringify({
          type: "pi-openai-long-context.status",
          requestId: message.slice("/long-context-status ".length),
          enabled: false,
          supported: false,
          provider: "anthropic",
          model: "claude-opus-4-8",
          contextWindow: 200_000,
        }),
      });
    },
  });
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.initialize();

  expect(events.find((event) => event.type === "session.config")).not.toMatchObject({
    config: { settings: expect.arrayContaining([{ id: "longContext" }]) },
  });
  await session.close();
});

test("configures Pi auto-compaction and retry from composer settings", async () => {
  const calls: string[] = [];
  const { runtime } = createRuntime();
  runtime.setAutoCompaction = async (enabled) => { calls.push(`compact:${enabled}`); };
  runtime.setAutoRetry = async (enabled) => { calls.push(`retry:${enabled}`); };
  const session = createSession(runtime, []);

  await session.configure({ settings: { autoCompaction: "on", autoRetry: "on" } });

  expect(calls).toEqual(["compact:true", "retry:true"]);
  await session.close();
});

test("does not cancel a turn when Pi rejects abort", async () => {
  const { runtime } = createRuntime({ abortError: new Error("Pi disconnected") });
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.prompt({ clientMessageId: "message-1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "work" }] } });
  await expect(session.interrupt()).rejects.toThrow("Pi disconnected");

  expect(events.some((event) => event.type === "session.turn" && event.state === "canceled")).toBe(false);
  await session.close();
});

test("waits for agent_settled after a retriable agent_end", async () => {
  const { runtime, emit } = createRuntime();
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.prompt({ clientMessageId: "message-1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "work" }] } });
  emit({ type: "turn_start" });
  emit({ type: "agent_end", willRetry: false, messages: [] });

  expect(events.filter((event) => event.type === "session.turn" && event.state === "completed")).toHaveLength(0);
  emit({ type: "agent_settled" });
  expect(events.filter((event) => event.type === "session.turn" && event.state === "completed")).toHaveLength(1);
  await session.close();
});
