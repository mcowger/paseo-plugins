import { expect, test, vi } from "vitest";

import type { PaseoApi } from "@getpaseo/client";
import type { PiSessionState } from "./rpc-types.js";
import { startPiSession, type PiRuntimeSession } from "./runtime.js";
import { createPiProvider, PI_PROVIDER_ID } from "./provider.js";

vi.mock("./runtime.js", () => ({
  startPiSession: vi.fn(),
}));

const state: PiSessionState = {
  sessionId: "pi-session",
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  messageCount: 0,
  pendingMessageCount: 0,
};

function createRuntime(): PiRuntimeSession {
  return {
    onEvent() { return () => undefined; },
    async prompt() { return {}; },
    async steer() {},
    async clearQueue() {},
    async compact() {},
    async setAutoCompaction() {},
    async setAutoRetry() {},
    async abort() {},
    async getState() { return { ...state }; },
    async getMessages() { return []; },
    async getAvailableModels() { return []; },
    async setModel() { throw new Error("unused"); },
    async setThinkingLevel() {},
    async getSessionStats() { return {}; },
    async getCommands() { return []; },
    respondToExtensionUiRequest() {},
    async close() {},
  };
}

test("contribution cleanup closes active provider connections", async () => {
  const provider = createPiProvider();
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message"],
  });

  await provider.close();

  await expect(connection.send({
    type: "sessions",
    requestId: "request-1",
  })).rejects.toThrow("Pi provider connection is closed");
});

test("resolves runtime settings from the agent's persisted bridge session", async () => {
  vi.mocked(startPiSession).mockResolvedValue(createRuntime());
  const provider = createPiProvider();
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence", "session.configure"],
  });
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "bridge-session",
    config: {
      cwd: "/workspace",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
    },
    history: "skip",
  });
  const paseo = {
    agents: {
      ref: () => ({
        refresh: async () => ({
          agent: {
            provider: PI_PROVIDER_ID,
            runtimeInfo: {
              sessionId: `plugin:${JSON.stringify({ version: 1, data: { bridgeSessionId: "bridge-session" } })}`,
            },
          },
        }),
      }),
    },
  } as unknown as PaseoApi;

  await expect(provider.getRuntimeSettings("agent-session", paseo)).resolves.toEqual([
    expect.objectContaining({ id: "autoCompaction", value: false }),
    expect.objectContaining({ id: "autoRetry", value: false }),
  ]);

  await provider.close();
});
