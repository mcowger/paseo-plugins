import { expect, test, vi } from "vitest";

import type { PaseoApi } from "@getpaseo/client";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
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
    async getEntries() { return { entries: [], leafId: null }; },
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

test("rejects malformed revert tokens without touching Pi", async () => {
  const prompted: string[] = [];
  const runtime = createRuntime();
  runtime.prompt = async (message) => {
    prompted.push(message);
    return {};
  };
  vi.mocked(startPiSession).mockResolvedValue(runtime);
  const provider = createPiProvider();
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "bridge-revert",
    config: {
      cwd: "/workspace",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
    },
    history: "skip",
  });
  events.length = 0;

  await connection.send({
    type: "session.revert",
    requestId: "revert-1",
    sessionId: "bridge-revert",
    scope: "conversation",
    token: "entry-1",
  });

  expect(events).toContainEqual({
    type: "request.failed",
    requestId: "revert-1",
    error: { message: expect.stringContaining("malformed") },
  });
  expect(prompted).toEqual([]);

  await provider.close();
});

test("rejects oversized provider inputs without dispatching", async () => {
  vi.mocked(startPiSession).mockClear();
  vi.mocked(startPiSession).mockResolvedValue(createRuntime());
  const provider = createPiProvider();
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  await connection.send({
    type: "session.open",
    requestId: "open-big",
    sessionId: "bridge-big",
    config: {
      cwd: "/workspace",
      env: { BLOB: "x".repeat(300 * 1024) },
      mcpServers: {},
      settings: {},
      persist: true,
    },
    history: "skip",
  });

  expect(events).toContainEqual({
    type: "request.failed",
    requestId: "open-big",
    error: { message: "Session environment is too large or not serializable" },
  });
  expect(vi.mocked(startPiSession)).not.toHaveBeenCalled();

  await provider.close();
});

test("maps internal launch failures to a fixed public message", async () => {
  vi.mocked(startPiSession).mockRejectedValue(new Error("spawn pi ENOENT /secret/pi-key"));
  const provider = createPiProvider();
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  await connection.send({
    type: "session.open",
    requestId: "open-leak",
    sessionId: "bridge-leak",
    config: {
      cwd: "/workspace",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
    },
    history: "skip",
  });

  expect(events).toContainEqual({
    type: "request.failed",
    requestId: "open-leak",
    error: { message: "Pi provider request failed" },
  });

  await provider.close();
});

test("rejects NUL cwd and unknown permission ids as public errors", async () => {
  vi.mocked(startPiSession).mockResolvedValue(createRuntime());
  const provider = createPiProvider();
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence", "permission"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  await connection.send({
    type: "session.open",
    requestId: "open-nul",
    sessionId: "bridge-nul",
    config: {
      cwd: "/work\u0000space",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
    },
    history: "skip",
  });
  expect(events).toContainEqual({
    type: "request.failed",
    requestId: "open-nul",
    error: { message: "cwd is malformed" },
  });

  await connection.send({
    type: "session.open",
    requestId: "open-ok",
    sessionId: "bridge-perm",
    config: {
      cwd: "/workspace",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
    },
    history: "skip",
  });
  events.length = 0;

  await expect(connection.send({
    type: "session.permission",
    sessionId: "bridge-perm",
    permissionId: "no-such-permission",
    response: { behavior: "deny" },
  })).rejects.toThrowError("No pending permission request");

  await provider.close();
});

test("rejects persistence session files that fail path checks", async () => {
  vi.mocked(startPiSession).mockClear();
  vi.mocked(startPiSession).mockResolvedValue(createRuntime());
  const provider = createPiProvider();
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  await connection.send({
    type: "session.open",
    requestId: "open-bad-file",
    sessionId: "bridge-bad-file",
    config: {
      cwd: "/workspace",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
    },
    persistence: { version: 1, data: { sessionFile: "nul\u0000here" } },
    history: "skip",
  });

  expect(events).toContainEqual({
    type: "request.failed",
    requestId: "open-bad-file",
    error: { message: "Session persistence file is malformed" },
  });
  expect(vi.mocked(startPiSession)).not.toHaveBeenCalled();

  await provider.close();
});

test("bounds session configure changes like other nested inputs", async () => {
  vi.mocked(startPiSession).mockResolvedValue(createRuntime());
  const provider = createPiProvider();
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({
    type: "session.open",
    requestId: "open-config-bound",
    sessionId: "bridge-config-bound",
    config: {
      cwd: "/workspace",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
    },
    history: "skip",
  });
  events.length = 0;

  await connection.send({
    type: "session.configure",
    requestId: "configure-big",
    sessionId: "bridge-config-bound",
    changes: { settings: { blob: "x".repeat(300 * 1024) } },
  });

  expect(events).toContainEqual({
    type: "request.failed",
    requestId: "configure-big",
    error: { message: "Session configure changes is too large or not serializable" },
  });

  await provider.close();
});

test("validates the session id on close like other session inputs", async () => {
  const provider = createPiProvider();
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  await connection.send({
    type: "session.close",
    requestId: "close-bad",
    sessionId: "!!!",
  });

  expect(events).toContainEqual({
    type: "request.failed",
    requestId: "close-bad",
    error: { message: "session id is malformed" },
  });

  await provider.close();
});

test("keeps actionable settings errors readable", async () => {
  const provider = createPiProvider();
  const paseo = {
    agents: {
      ref: () => ({
        refresh: async () => ({
          agent: { provider: "someone-else" },
        }),
      }),
    },
  } as unknown as PaseoApi;

  await expect(provider.getRuntimeSettings("agent-session", paseo)).rejects.toThrowError(
    expect.objectContaining({
      name: "PiPublicError",
      message: "Pi settings are only available for Pi sessions",
    }),
  );

  await provider.close();
});
