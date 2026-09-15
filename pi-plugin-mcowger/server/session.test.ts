import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "vitest";

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

test("persists the current Paseo bridge session ID", async () => {
  const { runtime } = createRuntime();
  const session = createSession(runtime, []);

  expect(session.persistence).toEqual({
    version: 1,
    data: {
      bridgeSessionId: "paseo-session",
      sessionFile: null,
      cwd: "/workspace",
    },
  });

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

test("keeps composer settings empty while exposing runtime settings for the Pi pill", async () => {
  const { runtime } = createRuntime();
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.initialize();

  expect(events.find((event) => event.type === "session.config")).toMatchObject({
    config: {
      modes: [{ id: "build", label: "Build" }],
      settings: [],
    },
  });
  expect(session.getRuntimeSettings()).toEqual([
    {
      id: "autoCompaction",
      label: "Compact",
      description: "Compact long conversations automatically.",
      value: false,
    },
    {
      id: "autoRetry",
      label: "Retry",
      description: "Retry transient provider errors automatically.",
      value: false,
    },
  ]);
  await session.updateRuntimeSetting("autoCompaction", true);
  expect(session.getRuntimeSettings()[0]).toMatchObject({
    id: "autoCompaction",
    value: true,
  });
  expect(events.find((event) => event.type === "session.config")).not.toHaveProperty("config.mode");
  await session.close();
});

const microGptPackageDirectory = mkdtempSync(join(tmpdir(), "paseo-pi-microgpt-"));
writeFileSync(join(microGptPackageDirectory, "package.json"), JSON.stringify({ name: "@mcowger/pi-microgpt" }));
afterAll(() => rmSync(microGptPackageDirectory, { recursive: true, force: true }));

const microGptCommands: PiRpcSlashCommand[] = [
  "fast",
  "fast-status",
  "long-context",
  "long-context-status",
].map((name) => ({
  name,
  source: "extension",
  sourceInfo: {
    source: "local-package-source",
    baseDir: microGptPackageDirectory,
    origin: "package",
  },
}));

function microGptStatus(command: "fast" | "long-context", requestId: string, supported: boolean) {
  return {
    type: "pi-microgpt.response",
    command,
    success: true,
    requestId,
    enabled: false,
    supported,
    provider: "openai-codex",
    model: supported ? "gpt-5.6" : "claude-opus-4-8",
    ...(command === "long-context" ? { contextWindow: supported ? 1_050_000 : 200_000 } : {}),
  };
}

test("probes pi-microgpt and exposes its supported controls", async () => {
  const requests: string[] = [];
  const { runtime } = createRuntime({
    commands: microGptCommands,
    prompt(message, emit) {
      requests.push(message);
      if (message.startsWith("/fast-status ")) {
        emit({
          type: "extension_ui_request",
          id: "fast-status",
          method: "notify",
          message: JSON.stringify(microGptStatus("fast", message.slice("/fast-status ".length), true)),
        });
      }
      if (message.startsWith("/long-context-status ")) {
        emit({
          type: "extension_ui_request",
          id: "long-context-status",
          method: "notify",
          message: JSON.stringify(microGptStatus("long-context", message.slice("/long-context-status ".length), true)),
        });
      }
    },
  });
  const session = createSession(runtime, []);

  await session.initialize();

  expect(session.getRuntimeSettings()).toMatchObject([
    { id: "autoCompaction" },
    { id: "autoRetry" },
    { id: "fastMode", value: false },
    { id: "longContext", value: false },
  ]);

  await session.updateRuntimeSetting("fastMode", true);
  await session.updateRuntimeSetting("longContext", true);
  expect(requests).toEqual([
    expect.stringMatching(/^\/fast-status /),
    expect.stringMatching(/^\/long-context-status /),
    "/fast on",
    expect.stringMatching(/^\/fast-status /),
    "/long-context on",
    expect.stringMatching(/^\/long-context-status /),
  ]);
  await session.close();
});

test("does not probe similarly named commands from another extension", async () => {
  const requests: string[] = [];
  const { runtime } = createRuntime({
    commands: microGptCommands.map((command) => ({
      ...command,
      sourceInfo: { source: "npm:unrelated-extension", origin: "package" },
    })),
    prompt(message) { requests.push(message); },
  });
  const session = createSession(runtime, []);

  await session.initialize();

  expect(requests).toEqual([]);
  expect(session.getRuntimeSettings()).toHaveLength(2);
  await session.close();
});

test("does not probe an incomplete pi-microgpt installation", async () => {
  const requests: string[] = [];
  const { runtime } = createRuntime({
    commands: microGptCommands.slice(0, 3),
    prompt(message) { requests.push(message); },
  });
  const session = createSession(runtime, []);

  await session.initialize();

  expect(requests).toEqual([]);
  expect(session.getRuntimeSettings()).toHaveLength(2);
  await session.close();
});

test("hides pi-microgpt controls for unsupported models", async () => {
  const { runtime } = createRuntime({
    commands: microGptCommands,
    prompt(message, emit) {
      if (message.startsWith("/fast-status ")) {
        emit({
          type: "extension_ui_request",
          id: "fast-status",
          method: "notify",
          message: JSON.stringify(microGptStatus("fast", message.slice("/fast-status ".length), false)),
        });
      }
      if (message.startsWith("/long-context-status ")) {
        emit({
          type: "extension_ui_request",
          id: "long-context-status",
          method: "notify",
          message: JSON.stringify(microGptStatus("long-context", message.slice("/long-context-status ".length), false)),
        });
      }
    },
  });
  const session = createSession(runtime, []);

  await session.initialize();

  expect(session.getRuntimeSettings()).toHaveLength(2);
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
