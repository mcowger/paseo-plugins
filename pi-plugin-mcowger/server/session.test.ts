import { expect, test } from "vitest";

import type { ProviderEvent, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";

import type { PiRuntimeEvent, PiSessionState } from "./rpc-types.js";
import type { PiRuntimeSession } from "./runtime.js";
import { PiProviderSession } from "./session.js";

function createRuntime(options: { abortError?: Error } = {}) {
  const listeners = new Set<(event: PiRuntimeEvent) => void>();
  const runtime: PiRuntimeSession = {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt() { return {}; },
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
    async getCommands() { return []; },
    respondToExtensionUiRequest() {},
    async close() {},
  };
  return { runtime, emit(event: PiRuntimeEvent) { for (const listener of listeners) listener(event); } };
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

test("emits composer settings for auto-compaction and retry", async () => {
  const { runtime } = createRuntime();
  const events: ProviderEvent[] = [];
  const session = createSession(runtime, events);

  await session.initialize();

  expect(events.find((event) => event.type === "session.config")).toMatchObject({
    config: {
      settings: [
        {
          type: "select",
          id: "autoCompaction",
          label: "Compact",
          value: "off",
          options: [
            { label: "Compact: ✓", value: "on" },
            { label: "Compact: ×", value: "off" },
          ],
        },
        {
          type: "select",
          id: "autoRetry",
          label: "Retry",
          value: "off",
          options: [
            { label: "Retry: ✓", value: "on" },
            { label: "Retry: ×", value: "off" },
          ],
        },
      ],
    },
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
