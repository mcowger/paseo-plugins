import { homedir } from "node:os";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "./pi-sdk.js";
import {
  negotiateProviderCapabilities,
  type ProviderCommand,
  type ProviderConnection,
  type ProviderError,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

import { createMcpBridge } from "./mcp-bridge.js";
import type { PiModelRuntimeLike } from "../shared/pi-sdk-types.js";
import { buildCatalog, createModelRuntime, listScopedModels } from "./pi-host.js";
import { loadPiPresets, presetsToModes } from "./presets.js";
import { PiProviderSession } from "./session.js";
import { normalizePiThinkingLevel, parsePiModelReference } from "./thinking.js";

export const PI_PROVIDER_ID = "pi-plugin-mcowger";
export const PI_PROVIDER_LABEL = "Pi (mcowger)";

const SUPPORTED_CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.persistence",
  "session.configure",
  "session.revert.conversation",
  "permission",
] as const;

interface ProviderState {
  sessions: Map<string, PiProviderSession>;
  emit(event: ProviderEvent): void;
  capabilities: readonly string[];
  modelRuntimePromise: Promise<PiModelRuntimeLike> | null;
}

export function createPiProvider(): ProviderRegistration {
  return {
    id: PI_PROVIDER_ID,
    label: PI_PROVIDER_LABEL,
    description:
      "Pi coding agent via its in-process SDK, with per-model thinking levels, presets, native todos, and subagent rendering",
    icon: "icon.svg",
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new Error("Provider protocol version 1 is required");
      }
      return createConnection(
        negotiateProviderCapabilities(request.capabilities, SUPPORTED_CAPABILITIES),
      );
    },
  };
}

function createConnection(capabilities: readonly string[]): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const state: ProviderState = {
    sessions: new Map(),
    capabilities,
    modelRuntimePromise: null,
    emit(event) {
      if (closed) return;
      for (const listener of listeners) listener(event);
    },
  };
  let closed = false;

  const modelRuntime = () => {
    state.modelRuntimePromise ??= createModelRuntime();
    return state.modelRuntimePromise;
  };

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      try {
        await dispatch(input, state, modelRuntime);
      } catch (error) {
        const providerError = toProviderError(error);
        if ("requestId" in input && input.requestId) {
          state.emit({ type: "request.failed", requestId: input.requestId, error: providerError });
          return;
        }
        if (input.type === "session.prompt") {
          state.emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "failed", error: providerError },
          });
          return;
        }
        throw error;
      }
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      const sessions = [...state.sessions.values()];
      state.sessions.clear();
      await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
      listeners.clear();
    },
  };
}

function toProviderError(error: unknown): ProviderError {
  return { message: error instanceof Error ? error.message : String(error) };
}

async function dispatch(
  input: ProviderInput,
  state: ProviderState,
  getModelRuntime: () => Promise<PiModelRuntimeLike>,
): Promise<void> {
  switch (input.type) {
    case "catalog":
      await handleCatalog(input, state, getModelRuntime);
      return;
    case "sessions":
      state.emit({ type: "sessions", requestId: input.requestId, sessions: [] });
      return;
    case "session.open":
      await handleSessionOpen(input, state, getModelRuntime);
      return;
    case "session.prompt":
      await requireSession(state, input.sessionId).handlePrompt(input.prompt);
      return;
    case "session.interrupt":
      await requireSession(state, input.sessionId).interrupt();
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.permission":
      requireSession(state, input.sessionId).respondToPermission(
        input.permissionId,
        input.response,
      );
      return;
    case "session.configure":
      await requireSession(state, input.sessionId).configure(input.changes);
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.revert": {
      if (input.scope !== "conversation") {
        throw new Error(`Pi does not support ${input.scope} rewind`);
      }
      await requireSession(state, input.sessionId).revertConversation(input.token);
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.archive":
    case "session.unarchive":
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.close": {
      const session = state.sessions.get(input.sessionId);
      state.sessions.delete(input.sessionId);
      await session?.close();
      state.emit({ type: "session.closed", sessionId: input.sessionId });
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
  }
}

function requireSession(state: ProviderState, sessionId: string): PiProviderSession {
  const session = state.sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

async function handleCatalog(
  input: Extract<ProviderInput, { type: "catalog" }>,
  state: ProviderState,
  getModelRuntime: () => Promise<PiModelRuntimeLike>,
): Promise<void> {
  try {
    const runtime = await getModelRuntime();
    const baseCatalog = await buildCatalog(runtime, input.cwd ?? homedir());
    const presets = loadPiPresets(input.cwd ?? homedir());
    state.emit({
      type: "catalog",
      requestId: input.requestId,
      catalog: {
        ...baseCatalog,
        modes: presetsToModes(presets),
      },
    });
  } catch (error) {
    state.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: toProviderError(error),
    });
  }
}

async function handleSessionOpen(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: ProviderState,
  getModelRuntime: () => Promise<PiModelRuntimeLike>,
): Promise<void> {
  if (state.sessions.has(input.sessionId)) {
    throw new Error(`Session already exists: ${input.sessionId}`);
  }
  const config = input.config;
  const persistenceData = input.persistence?.data;
  const persistedSessionFile =
    persistenceData &&
    typeof persistenceData === "object" &&
    !Array.isArray(persistenceData) &&
    typeof (persistenceData as Record<string, unknown>).sessionFile === "string"
      ? ((persistenceData as Record<string, unknown>).sessionFile as string)
      : null;
  const persistedLeafId =
    persistenceData &&
    typeof persistenceData === "object" &&
    !Array.isArray(persistenceData) &&
    ((persistenceData as Record<string, unknown>).leafId === null ||
      typeof (persistenceData as Record<string, unknown>).leafId === "string")
      ? ((persistenceData as Record<string, unknown>).leafId as string | null)
      : undefined;

  const runtime = await getModelRuntime();

  // Bridge Paseo-injected MCP servers to pi custom tools; failures degrade
  // per-server and never block the session.
  let mcp = null;
  const mcpServers = config.mcpServers ?? {};
  if (Object.keys(mcpServers).length > 0) {
    mcp = await createMcpBridge(mcpServers, (message) =>
      console.log(`[pi-plugin-mcowger] ${message}`),
    );
  }

  const systemPrompt = config.systemPrompt;
  const loader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: systemPrompt
      ? (base: string[]) => [...base, systemPrompt]
      : undefined,
  });
  await loader.reload();

  const sessionManager = persistedSessionFile
    ? SessionManager.open(persistedSessionFile)
    : config.persist === false
      ? SessionManager.inMemory(config.cwd)
      : SessionManager.create(config.cwd);

  let created;
  try {
    if (persistedLeafId !== undefined) {
      if (persistedLeafId === null) {
        sessionManager.resetLeaf();
      } else if (!sessionManager.getEntry(persistedLeafId)) {
        throw new Error(`Pi persisted leaf ${persistedLeafId} was not found in the session tree`);
      } else {
        sessionManager.branch(persistedLeafId);
      }
    }
    created = await createAgentSession({
      cwd: config.cwd,
      modelRuntime: runtime,
      sessionManager,
      resourceLoader: loader,
      ...(mcp && mcp.tools.length > 0 ? { customTools: mcp.tools } : {}),
    });
  } catch (error) {
    await mcp?.close().catch(() => undefined);
    throw error;
  }
  const { session, modelFallbackMessage } = created;

  // Apply the requested model/thinking after creation (fast, direct).
  if (config.model) {
    const reference = parsePiModelReference(config.model);
    if (reference?.provider) {
      const model = runtime.getModel(reference.provider, reference.id);
      if (model) {
        await session.setModel(model);
      }
    }
  }
  const thinkingLevel = normalizePiThinkingLevel(config.thinkingOption);
  if (thinkingLevel) {
    session.setThinkingLevel(thinkingLevel);
  }
  if (modelFallbackMessage) {
    state.emit({
      type: "timeline.item",
      sessionId: input.sessionId,
      item: {
        type: "notification",
        id: `fallback:${input.sessionId}`,
        level: "warning",
        message: modelFallbackMessage,
      },
    });
  }

  const presets = loadPiPresets(config.cwd, config.env as Record<string, string>);
  const promptCommands: ProviderCommand[] = [
    {
      name: "compact",
      description: "Manually compact the session context",
      argumentHint: "[instructions]",
    },
    {
      name: "preset",
      description: "Activate a pi preset",
      argumentHint: "<name>",
    },
    ...loader
      .getPrompts()
      .prompts.map((template) => ({
        name: template.name,
        description: template.description ?? "Prompt template",
      })),
  ];

  const providerSession = new PiProviderSession({
    sessionId: input.sessionId,
    bundle: {
      session,
      sessionManager,
      mcp,
      presets,
      promptCommands,
    },
    config,
    models: await listScopedModels(runtime, config.cwd),
    emit: state.emit,
  });
  state.sessions.set(input.sessionId, providerSession);

  state.emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: state.capabilities,
    restoration: "core",
    persistence: providerSession.persistence,
    ...(config.title ? { title: config.title } : {}),
    cwd: config.cwd,
  });
  providerSession.emitConfigState();

  const commands = providerSession.listCommands();
  if (commands.length > 0) {
    state.emit({ type: "session.commands", sessionId: input.sessionId, commands });
  }

  if (input.history === "replay" && persistedSessionFile) {
    await providerSession.replayHistory();
  }

  state.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });

  // Apply a requested preset on fresh sessions. On resume the saved mode is
  // read back from preset-state entries by the session constructor.
  if (!persistedSessionFile && config.mode && presets[config.mode]) {
    try {
      await providerSession.applyPreset(config.mode);
      providerSession.emitConfigState();
    } catch (error) {
      console.warn(
        `[pi-plugin-mcowger] Failed to apply preset "${config.mode}": ${toProviderError(error).message}`,
      );
    }
  }
}
