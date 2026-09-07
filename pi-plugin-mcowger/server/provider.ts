import { homedir } from "node:os";

import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderError,
  type ProviderEvent,
  type ProviderInput,
  type ProviderModel,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

import type { PiModel } from "../shared/rpc-types.js";
import { createPiPaseoExtensionFile } from "./extension.js";
import { createPiMcpConfigFile, type PiTempFile } from "./mcp-config.js";
import { loadPiPresets, presetsToModes } from "./presets.js";
import {
  compareVersions,
  MIN_PI_VERSION,
  PiCliRuntime,
  type PiRuntimeSession,
} from "./runtime.js";
import { PiProviderSession } from "./session.js";
import { mapPiModel, normalizePiThinkingLevel } from "./thinking.js";

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
  runtime: PiCliRuntime;
  versionError: Error | null;
  mcpAdapterSupported: boolean | null;
}

export function createPiProvider(): ProviderRegistration {
  return {
    id: PI_PROVIDER_ID,
    label: PI_PROVIDER_LABEL,
    description:
      "Pi coding agent via its RPC mode, with per-model thinking levels, presets, native todos, and subagent rendering",
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
    runtime: new PiCliRuntime(),
    versionError: null,
    mcpAdapterSupported: null,
    emit(event) {
      if (closed) return;
      for (const listener of listeners) listener(event);
    },
  };
  let closed = false;

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      try {
        await dispatch(input, state);
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

async function dispatch(input: ProviderInput, state: ProviderState): Promise<void> {
  switch (input.type) {
    case "catalog":
      await handleCatalog(input, state);
      return;
    case "sessions":
      state.emit({ type: "sessions", requestId: input.requestId, sessions: [] });
      return;
    case "session.open":
      await handleSessionOpen(input, state);
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

async function ensurePiVersion(state: ProviderState): Promise<void> {
  if (state.versionError) {
    throw state.versionError;
  }
  try {
    const version = await state.runtime.probeVersion();
    if (compareVersions(version, MIN_PI_VERSION) < 0) {
      state.versionError = new Error(
        `pi-plugin-mcowger requires pi >= ${MIN_PI_VERSION} (found ${version}). ` +
          `Upgrade pi and reload the plugin.`,
      );
      throw state.versionError;
    }
  } catch (error) {
    if (state.versionError) {
      throw state.versionError;
    }
    state.versionError = new Error(
      `pi-plugin-mcowger could not run \`pi --version\`: ${
        error instanceof Error ? error.message : String(error)
      }. Install pi >= ${MIN_PI_VERSION} or set PI_COMMAND.`,
    );
    throw state.versionError;
  }
}

async function handleCatalog(
  input: Extract<ProviderInput, { type: "catalog" }>,
  state: ProviderState,
): Promise<void> {
  try {
    await ensurePiVersion(state);
    const probe = await state.runtime.startSession({
      cwd: input.cwd ?? homedir(),
      noSession: true,
    });
    let models: PiModel[];
    let hasPresetCommand = false;
    try {
      models = await probe.getAvailableModels(null);
      const commands = await probe.getCommands().catch(() => []);
      hasPresetCommand = commands.some((command) => command.name === "preset");
    } finally {
      await probe.close().catch(() => undefined);
    }
    const presets = hasPresetCommand ? loadPiPresets(input.cwd ?? homedir()) : {};
    state.emit({
      type: "catalog",
      requestId: input.requestId,
      catalog: {
        models: models.map((model): ProviderModel => mapPiModel(model)),
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

async function detectMcpAdapter(state: ProviderState, cwd: string): Promise<boolean> {
  if (state.mcpAdapterSupported !== null) {
    return state.mcpAdapterSupported;
  }
  let probe: PiRuntimeSession | null = null;
  try {
    probe = await state.runtime.startSession({ cwd, noSession: true });
    const commands = await probe.getCommands();
    state.mcpAdapterSupported = commands.some(
      (command) =>
        command.source === "extension" &&
        /^mcp(?::\d+)?$/.test(command.name) &&
        (!command.sourceInfo || JSON.stringify(command.sourceInfo).includes("pi-mcp-adapter")),
    );
  } catch {
    state.mcpAdapterSupported = false;
  } finally {
    await probe?.close().catch(() => undefined);
  }
  return state.mcpAdapterSupported;
}

async function handleSessionOpen(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: ProviderState,
): Promise<void> {
  if (state.sessions.has(input.sessionId)) {
    throw new Error(`Session already exists: ${input.sessionId}`);
  }
  await ensurePiVersion(state);

  const config = input.config;
  const persistenceData = input.persistence?.data;
  const persistedSessionFile =
    persistenceData &&
    typeof persistenceData === "object" &&
    !Array.isArray(persistenceData) &&
    typeof (persistenceData as Record<string, unknown>).sessionFile === "string"
      ? ((persistenceData as Record<string, unknown>).sessionFile as string)
      : null;

  let mcpConfig: PiTempFile | null = null;
  let extension: PiTempFile | null = null;
  const cleanup = () => {
    mcpConfig?.cleanup();
    extension?.cleanup();
  };

  try {
    const mcpServers = config.mcpServers ?? {};
    if (
      Object.keys(mcpServers).length > 0 &&
      (await detectMcpAdapter(state, config.cwd))
    ) {
      mcpConfig = createPiMcpConfigFile(mcpServers, {
        piGlobalConfigEnv: config.env as Record<string, string>,
      });
    }
    extension = createPiPaseoExtensionFile(config.systemPrompt);

    const thinkingLevel = normalizePiThinkingLevel(config.thinkingOption);
    const runtimeSession = await state.runtime.startSession({
      cwd: config.cwd,
      env: config.env as Record<string, string>,
      ...(config.model ? { model: config.model } : {}),
      // Omit --thinking unless the user explicitly selected a level; pi then
      // picks its own model-specific default.
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(config.persist === false
        ? { noSession: true }
        : persistedSessionFile
          ? { session: persistedSessionFile }
          : {}),
      ...(mcpConfig ? { mcpConfigPath: mcpConfig.path } : {}),
      extensionPaths: [extension.path],
    });

    const initialState = await runtimeSession.getState();
    const piModels = await runtimeSession.getAvailableModels().catch(() => [] as PiModel[]);
    const rawCommands = await runtimeSession.getCommands().catch(() => []);
    const presets = rawCommands.some((command) => command.name === "preset")
      ? loadPiPresets(config.cwd, config.env as Record<string, string>)
      : {};

    const session = new PiProviderSession({
      sessionId: input.sessionId,
      runtimeSession,
      config,
      initialState,
      piModels,
      presets,
      initialMode: config.mode ?? null,
      emit: state.emit,
      onRuntimeFailed: (error) => {
        state.sessions.delete(input.sessionId);
        state.emit({ type: "session.runtime_failed", sessionId: input.sessionId, error });
      },
      cleanup,
    });
    state.sessions.set(input.sessionId, session);

    state.emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId: input.sessionId,
      capabilities: state.capabilities,
      restoration: "core",
      persistence: session.persistence,
      ...(config.title ? { title: config.title } : {}),
      cwd: config.cwd,
    });
    session.emitConfigState();

    const commands = await session.listCommands().catch(() => []);
    if (commands.length > 0) {
      state.emit({ type: "session.commands", sessionId: input.sessionId, commands });
    }

    if (input.history === "replay" && persistedSessionFile) {
      await session.replayHistory();
    }

    state.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });

    // On fresh sessions, apply the requested preset. On resume the preset
    // extension restores instructions itself from preset-state entries, so
    // only re-sync the displayed mode. Failures leave the session usable.
    if (Object.keys(presets).length > 0) {
      try {
        if (!persistedSessionFile && config.mode) {
          await session.applyPreset(config.mode);
          session.emitConfigState();
        } else {
          await session.syncPresetFromEntries();
        }
      } catch (error) {
        console.warn(
          `[pi-plugin-mcowger] Failed to apply preset "${config.mode}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } catch (error) {
    cleanup();
    throw error;
  }
}
