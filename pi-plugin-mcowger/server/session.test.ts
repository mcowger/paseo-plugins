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

function createSession(runtime: PiRuntimeSession, events: ProviderEvent[]) {
  return new PiProviderSession({
    sessionId: "paseo-session",
    config: { ...config },
    runtime,
    state: { ...state },
    models: [],
    emit: (event) => events.push(event),
    cleanup() {},
  });
}

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
