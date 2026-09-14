import { homedir } from "node:os";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "./pi-sdk.js";
import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderError,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

import { createMcpBridge } from "./mcp-bridge.js";
import { buildPiPromptCommands } from "./commands.js";
import {
  formatPiToolPolicyDiagnostic,
  piToolPolicyRequiresKnownBaseline,
  policyChanged,
  resolveConfiguredToolPolicy,
  resolvePiToolPolicy,
  resolveStrictActiveToolNames,
} from "./tool-policy.js";
import type { PiModelRuntimeLike } from "../shared/pi-sdk-types.js";
import { PI_TOOL_POLICY_PROFILE_ID_SETTING } from "../shared/tool-policy.js";
import { buildCatalog, createModelRuntime, listScopedModels } from "./pi-host.js";
import { createPiToolPolicyStore, type PiToolPolicyStore } from "./tool-policy.js";
import { PiProviderSession } from "./session.js";
import { normalizePiThinkingLevel, parsePiModelReference } from "./thinking.js";
import {
  createPiTodoTool,
  hasPiTodoExtensionTool,
  PI_TODO_TOOL_NAME,
} from "./pi-todo-tool.js";

export const PI_PROVIDER_ID = "pi-plugin-mcowger";
export const PI_PROVIDER_LABEL = "Pi (mcowger)";

export function stripPiToolPolicyProfileMarker(settings: Readonly<Record<string, unknown>>): {
  marker: unknown;
  settings: Record<string, unknown>;
} {
  const next = { ...settings };
  const marker = next[PI_TOOL_POLICY_PROFILE_ID_SETTING];
  delete next[PI_TOOL_POLICY_PROFILE_ID_SETTING];
  return { marker, settings: next };
}

export async function setActiveToolsOrCleanup(
  session: { setActiveToolsByName(toolNames: string[]): void },
  toolNames: string[],
  cleanupFailedOpen: () => Promise<void>,
): Promise<void> {
  try {
    session.setActiveToolsByName(toolNames);
  } catch (error) {
    await cleanupFailedOpen();
    throw error;
  }
}

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
  toolPolicyStore: PiToolPolicyStore;
  emit(event: ProviderEvent): void;
  capabilities: readonly string[];
  modelRuntimePromise: Promise<PiModelRuntimeLike> | null;
}

export function createPiProvider(toolPolicyStore = createPiToolPolicyStore()): ProviderRegistration {
  return {
    id: PI_PROVIDER_ID,
    label: PI_PROVIDER_LABEL,
    description:
      "Pi coding agent via its in-process SDK, with per-model thinking levels, host tool policy, native todos, and subagent rendering",
    icon: "icon.svg",
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new Error("Provider protocol version 1 is required");
      }
      return createConnection(
        negotiateProviderCapabilities(request.capabilities, SUPPORTED_CAPABILITIES),
        toolPolicyStore,
      );
    },
  };
}

function createConnection(
  capabilities: readonly string[],
  toolPolicyStore: PiToolPolicyStore,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const state: ProviderState = {
    sessions: new Map(),
    toolPolicyStore,
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
    state.emit({
      type: "catalog",
      requestId: input.requestId,
      catalog: {
        ...baseCatalog,
        modes: [],
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
  const startupDiagnostics: string[] = [];
  if (Object.keys(config.env).length > 0) {
    startupDiagnostics.push(
      "Pi ignored session env overrides: the embedded SDK has no safe per-session environment injection.",
    );
  }
  if (Object.keys(config.providerOptions ?? {}).length > 0) {
    startupDiagnostics.push(
      "Pi ignored providerOptions: the embedded SDK does not expose a per-session provider-options API.",
    );
  }
  if (config.toolPolicy) {
    throw new Error(
      "Pi cannot open a session with toolPolicy because the embedded SDK does not enforce MCP approvals.",
    );
  }
  const policySnapshot = state.toolPolicyStore.snapshot();
  const { marker, settings: sessionSettings } = stripPiToolPolicyProfileMarker(config.settings);
  const resolvedPolicy = resolveConfiguredToolPolicy(
    marker,
    policySnapshot.settings.piTools,
    policySnapshot.settings.profilePolicies,
    {
      model: config.model,
      mode: config.mode,
      thinkingOption: config.thinkingOption,
    },
  );
  if (marker === undefined && resolvedPolicy.source === "profile") {
    startupDiagnostics.push(
      "Pi tool policy: the profile marker was unavailable; matched one saved launch configuration.",
    );
  }
  if (marker !== undefined && resolvedPolicy.source === "fallback") {
    startupDiagnostics.push(
      "Pi tool policy: profile marker did not match a configured policy; using the fallback policy.",
    );
  }
  const settingsManager = SettingsManager.inMemory({
    ...(typeof sessionSettings.autoCompaction === "boolean"
      ? { compaction: { enabled: sessionSettings.autoCompaction } }
      : {}),
    ...(typeof sessionSettings.autoRetry === "boolean"
      ? { retry: { enabled: sessionSettings.autoRetry } }
      : {}),
  });
  const unsupportedSettings = Object.keys(sessionSettings).filter(
    (id) => id !== "autoCompaction" && id !== "autoRetry",
  );
  if (unsupportedSettings.length > 0) {
    startupDiagnostics.push(
      `Pi ignored unsupported settings: ${unsupportedSettings.join(", ")}.`,
    );
  }

  // Bridge Paseo-injected MCP servers to pi custom tools; failures degrade
  // per-server and never block the session.
  let mcp = null;
  const mcpServers = config.mcpServers ?? {};
  if (Object.keys(mcpServers).length > 0) {
    mcp = await createMcpBridge(
      mcpServers,
      resolvedPolicy.source === "profile"
        ? { enabled: true, disabledTools: [] }
        : policySnapshot.settings.paseoTools,
      (message: string) => startupDiagnostics.push(message),
      resolvedPolicy.source === "profile"
        ? resolvedPolicy.policy.allowedPaseoToolNames
        : undefined,
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
  try {
    await loader.reload();
  } catch (error) {
    await mcp?.close().catch(() => undefined);
    throw error;
  }
  for (const diagnostic of loader.getExtensions().errors) {
    startupDiagnostics.push(
      `Pi extension failed to load${diagnostic.path ? ` (${diagnostic.path})` : ""}: ${String(diagnostic.error)}`,
    );
  }
  for (const [kind, result] of [
    ["skill", loader.getSkills()],
    ["prompt", loader.getPrompts()],
    ["theme", loader.getThemes()],
  ] as const) {
    for (const diagnostic of result.diagnostics) {
      startupDiagnostics.push(
        `Pi ${kind} resource failed to load${diagnostic.path ? ` (${diagnostic.path})` : ""}: ${diagnostic.message}`,
      );
    }
  }

  let sessionManager;
  try {
    sessionManager = persistedSessionFile
      ? SessionManager.open(persistedSessionFile)
      : config.persist === false
        ? SessionManager.inMemory(config.cwd)
        : SessionManager.create(config.cwd);
  } catch (error) {
    await mcp?.close().catch(() => undefined);
    throw error;
  }
  const extensions = loader.getExtensions();

  const customTools = mcp?.tools ? [...mcp.tools] : [];
  const hasExtensionTodoTool = hasPiTodoExtensionTool(extensions);
  const shouldAddFallbackTodo = resolvedPolicy.source === "fallback" ||
    resolvedPolicy.policy.allowedPiToolNames.includes(PI_TODO_TOOL_NAME);
  const hasCustomTodoTool = customTools.some((tool) => tool.name === PI_TODO_TOOL_NAME);
  if (shouldAddFallbackTodo && !hasExtensionTodoTool && !hasCustomTodoTool) {
    customTools.push(createPiTodoTool(sessionManager));
  }

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
      settingsManager,
      ...(customTools.length > 0 ? { customTools } : {}),
    });
  } catch (error) {
    await mcp?.close().catch(() => undefined);
    throw error;
  }
  const { session, modelFallbackMessage } = created;
  const cleanupFailedOpen = async (): Promise<void> => {
    await mcp?.close().catch(() => undefined);
    session.dispose();
  };
  let baselineToolNames;
  try {
    baselineToolNames = session.getActiveToolNames?.();
  } catch (error) {
    await cleanupFailedOpen();
    throw error;
  }
  let knownToolNames;
  try {
    knownToolNames = session.getAllTools?.().map((tool) => tool.name);
  } catch (error) {
    await cleanupFailedOpen();
    throw error;
  }
  const bridgeTools = mcp ? [...mcp.toolMetadata.values()].map((metadata) => ({
    piName: metadata.piToolName,
    canonicalName: metadata.mcpToolName,
    isPaseoTool: metadata.source === "paseo",
  })) : [];
  const finalToolNames = resolvedPolicy.source === "profile"
    ? resolveStrictActiveToolNames(
        baselineToolNames,
        knownToolNames,
        resolvedPolicy.policy,
        bridgeTools,
      )
    : resolvePiToolPolicy(baselineToolNames, knownToolNames, resolvedPolicy.policy);
  const paseoToolCount = mcp?.paseoToolCount ?? 0;
  const visiblePaseoToolCount = mcp?.visiblePaseoToolCount ?? 0;
  if (baselineToolNames === undefined || finalToolNames === undefined) {
    if (
      resolvedPolicy.source === "profile" ||
      piToolPolicyRequiresKnownBaseline(resolvedPolicy.policy)
    ) {
      await setActiveToolsOrCleanup(session, [], cleanupFailedOpen);
      startupDiagnostics.push(
        "Pi tool policy: Pi did not expose its active tool list; disabled tool calls because a restrictive policy could not be resolved safely.",
      );
    } else {
      startupDiagnostics.push(
        "Pi tool policy: Pi did not expose its active tool list; preserved the SDK's current tool selection.",
      );
    }
  } else {
    await setActiveToolsOrCleanup(session, finalToolNames, cleanupFailedOpen);
    if (
      policyChanged(
        baselineToolNames,
        finalToolNames,
        paseoToolCount,
        visiblePaseoToolCount,
        resolvedPolicy.source === "profile"
          ? true
          : policySnapshot.settings.paseoTools.enabled,
      )
    ) {
      startupDiagnostics.push(
        formatPiToolPolicyDiagnostic(
          baselineToolNames,
          finalToolNames,
          mcp?.paseoToolNames ?? [],
          mcp?.visiblePaseoToolNames ?? [],
        ),
      );
    }
  }

  // Apply the requested model/thinking after creation (fast, direct).
  if (config.model) {
    const reference = parsePiModelReference(config.model);
    if (!reference?.provider) {
      startupDiagnostics.push(`Pi requested model is invalid or unavailable: ${config.model}`);
    } else {
      const model = runtime.getModel(reference.provider, reference.id);
      if (model) {
        try {
          await session.setModel(model);
        } catch (error) {
          await cleanupFailedOpen();
          throw error;
        }
      } else {
        startupDiagnostics.push(`Pi requested model is unavailable: ${config.model}`);
      }
    }
  }
  const thinkingLevel = normalizePiThinkingLevel(config.thinkingOption);
  if (thinkingLevel) {
    session.setThinkingLevel(thinkingLevel);
  }
  if (modelFallbackMessage) {
    startupDiagnostics.push(`Pi model fallback: ${modelFallbackMessage}`);
  }
  if (!session.model) {
    startupDiagnostics.push("Pi has no available model. Select an available model before prompting.");
  }
  let promptCommands;
  try {
    promptCommands = buildPiPromptCommands(
      extensions.extensions,
      loader.getPrompts().prompts,
      loader.getSkills().skills,
    );
  } catch (error) {
    await cleanupFailedOpen();
    throw error;
  }

  let models;
  try {
    models = await listScopedModels(runtime, config.cwd);
  } catch (error) {
    await cleanupFailedOpen();
    throw error;
  }
  let providerSession;
  try {
    providerSession = new PiProviderSession({
    sessionId: input.sessionId,
    bundle: {
      session,
      sessionManager,
      mcp,
      promptCommands,
    },
    config,
    models,
    reloadCommands: () =>
      buildPiPromptCommands(
        loader.getExtensions().extensions,
        loader.getPrompts().prompts,
        loader.getSkills().skills,
      ),
    emit: state.emit,
    });
  } catch (error) {
    await cleanupFailedOpen();
    throw error;
  }
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
  for (const [index, message] of startupDiagnostics.entries()) {
    state.emit({
      type: "timeline.item",
      sessionId: input.sessionId,
      item: {
        type: "notification",
        id: `startup-diagnostic:${input.sessionId}:${index}`,
        level: message.includes("failed") || message.includes("no available") ? "error" : "warning",
        message,
      },
    });
  }
  providerSession.emitConfigState();

  const commands = providerSession.listCommands();
  if (commands.length > 0) {
    state.emit({ type: "session.commands", sessionId: input.sessionId, commands });
  }

  if (input.history === "replay" && persistedSessionFile) {
    await providerSession.replayHistory();
  }

  state.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });

}
