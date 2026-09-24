import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import type { PaseoApi } from "@getpaseo/client";
import { negotiateProviderCapabilities, type ProviderConnection, type ProviderEvent, type ProviderInput, type ProviderRegistration } from "@getpaseo/plugin/server/provider";

import {
  assertBoundedJson,
  assertBoundedProviderInput,
  assertPiIdentifier,
  assertPiPath,
  MAX_PI_NESTED_VALUE_BYTES,
  PiPublicError,
  toPublicPromptMessage,
  toPublicRequestMessage,
} from "./bounds.js";
import { createPiMcpConfig } from "./mcp-config.js";
import { startPiSession } from "./runtime.js";
import { createPaseoExtension, PiProviderSession } from "./session.js";
import type { PiRuntimeSetting, PiRuntimeSettingId } from "../shared/runtime-settings.js";
import { mapPiCatalogModel } from "./thinking.js";

export const PI_PROVIDER_ID = "pi-plugin-mcowger";
const CAPABILITIES = ["prompt.message", "prompt.command", "prompt.image", "prompt.steer", "session.persistence", "session.configure", "session.revert.conversation", "session.subsession", "permission"] as const;
const PLUGIN_PERSISTENCE_PREFIX = "plugin:";
const MAX_PROVIDER_SESSION_ID_LENGTH = 160;

export interface ManagedPiProvider extends ProviderRegistration {
  getRuntimeSettings(agentId: string, paseo: PaseoApi): Promise<PiRuntimeSetting[]>;
  updateRuntimeSetting(agentId: string, id: PiRuntimeSettingId, value: boolean, paseo: PaseoApi): Promise<PiRuntimeSetting[]>;
  close(): Promise<void>;
}

export function createPiProvider(): ManagedPiProvider {
  const connections = new Set<ProviderConnection>();
  const sessions = new Map<string, PiProviderSession>();
  return {
    id: PI_PROVIDER_ID,
    label: "Pi (JSON-RPC)",
    description: "Pi coding agent over an isolated JSON-RPC subprocess per Paseo session.",
    icon: "icon.svg",
    async connect(request) {
      if (!request.versions.includes(1)) throw new PiPublicError("Provider protocol version 1 is required");
      const connection = createConnection(
        negotiateProviderCapabilities(request.capabilities, CAPABILITIES),
        () => connections.delete(connection),
        sessions,
      );
      connections.add(connection);
      return connection;
    },
    async close() {
      await Promise.all([...connections].map((connection) => connection.close()));
      connections.clear();
    },
    async getRuntimeSettings(agentId, paseo) {
      return (await requireSessionForAgent(sessions, agentId, paseo)).getRuntimeSettings();
    },
    async updateRuntimeSetting(agentId, id, value, paseo) {
      return await (await requireSessionForAgent(sessions, agentId, paseo)).updateRuntimeSetting(id, value);
    },
  };
}

function createConnection(
  capabilities: readonly string[],
  onClose: () => void,
  allSessions: Map<string, PiProviderSession>,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, PiProviderSession>();
  let closed = false;
  const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new PiPublicError("Pi provider connection is closed");
      try {
        // NG item 10 ingress envelope: reject over-budget/non-JSON/cyclic
        // inputs before dispatch, without serializing them.
        assertBoundedProviderInput(input, "Provider request");
        await dispatch(input, sessions, allSessions, emit, capabilities);
      }
      catch (error) {
        if ("requestId" in input) { emit({ type: "request.failed", requestId: input.requestId, error: { message: toPublicRequestMessage(error) } }); return; }
        if (input.type === "session.prompt") { emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "failed", error: { message: toPublicPromptMessage(error) } } }); return; }
        throw error;
      }
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...sessions.values()].map((session) => session.close().catch(() => undefined)));
      for (const sessionId of sessions.keys()) allSessions.delete(sessionId);
      sessions.clear();
      listeners.clear();
      onClose();
    },
  };
}

async function dispatch(input: ProviderInput, sessions: Map<string, PiProviderSession>, allSessions: Map<string, PiProviderSession>, emit: (event: ProviderEvent) => void, capabilities: readonly string[]): Promise<void> {
  switch (input.type) {
    case "catalog": {
      const runtime = await startPiSession({ cwd: input.cwd ?? homedir(), env: {}, persist: false });
      try {
        const models = await runtime.getAvailableModels();
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: {
            models: models.map((model) => mapPiCatalogModel(model)),
            modes: [],
          },
        });
      } finally { await runtime.close(); }
      return;
    }
    case "sessions": emit({ type: "sessions", requestId: input.requestId, sessions: [] }); return;
    case "session.open": {
      assertPiIdentifier(input.sessionId, "session id");
      assertPiPath(input.config.cwd, "cwd");
      if (input.persistence?.data !== undefined) assertBoundedJson(input.persistence.data, MAX_PI_NESTED_VALUE_BYTES, "Session persistence input");
      assertBoundedJson(input.config.env, MAX_PI_NESTED_VALUE_BYTES, "Session environment");
      assertBoundedJson(input.config.settings, MAX_PI_NESTED_VALUE_BYTES, "Session settings");
      assertBoundedJson(input.config.mcpServers, MAX_PI_NESTED_VALUE_BYTES, "Session MCP servers");
      if (sessions.has(input.sessionId)) throw new PiPublicError(`Session already exists: ${input.sessionId}`);
      const persisted = sessionFile(input.persistence?.data);
      if (persisted !== undefined) assertPiPath(persisted, "Session persistence file");
      // Per-session extension nonce: baked into the bridge extension
      // source and validated on every marker (see `isLiveExtensionMarker`).
      const extensionNonce = randomUUID();
      const extension = createPaseoExtension(input.config.systemPrompt, { nonce: extensionNonce });
      const mcpConfig = createPiMcpConfig(input.config.mcpServers, input.config.env);
      let runtime: Awaited<ReturnType<typeof startPiSession>> | undefined;
      let session: PiProviderSession | undefined;
      try {
        runtime = await startPiSession({ cwd: input.config.cwd, env: { ...input.config.env }, model: input.config.model, thinkingOption: input.config.thinkingOption, sessionFile: persisted, persist: input.config.persist, mcpConfigPath: mcpConfig?.path, extensionPath: extension.path });
        const [state, models] = await Promise.all([runtime.getState(), runtime.getAvailableModels()]);
        session = new PiProviderSession({
          sessionId: input.sessionId,
          config: input.config,
          runtime,
          state,
          models,
          extensionNonce,
          subsessionsEnabled: capabilities.includes("session.subsession"),
          emit,
          cleanup: () => { mcpConfig?.cleanup(); extension.cleanup(); },
        });
        sessions.set(input.sessionId, session);
        allSessions.set(input.sessionId, session);
        emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities, restoration: "core", persistence: session.persistence, ...(input.config.title ? { title: input.config.title } : {}), cwd: input.config.cwd });
        await session.initialize();
        if (input.history === "replay" && persisted) await session.replayHistory();
        emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
      } catch (error) {
        sessions.delete(input.sessionId);
        allSessions.delete(input.sessionId);
        if (session) await session.close().catch(() => undefined);
        else {
          await runtime?.close().catch(() => undefined);
          mcpConfig?.cleanup();
          extension.cleanup();
        }
        throw error;
      }
      return;
    }
    case "session.prompt": assertPiIdentifier(input.sessionId, "session id"); await requireSession(sessions, input.sessionId).prompt(input.prompt); return;
    case "session.interrupt": assertPiIdentifier(input.sessionId, "session id"); await requireSession(sessions, input.sessionId).interrupt(); emit({ type: "request.completed", requestId: input.requestId }); return;
    case "session.permission": assertPiIdentifier(input.sessionId, "session id"); assertPiIdentifier(input.permissionId, "permission id"); assertBoundedJson(input.response, MAX_PI_NESTED_VALUE_BYTES, "Permission response"); requireSession(sessions, input.sessionId).respondToPermission(input.permissionId, input.response); return;
    case "session.configure": assertPiIdentifier(input.sessionId, "session id"); assertBoundedJson(input.changes, MAX_PI_NESTED_VALUE_BYTES, "Session configure changes"); await requireSession(sessions, input.sessionId).configure(input.changes); emit({ type: "request.completed", requestId: input.requestId }); return;
    case "session.revert": assertPiIdentifier(input.sessionId, "session id"); if (input.scope !== "conversation") throw new PiPublicError(`Pi does not support ${input.scope} rewind`); await requireSession(sessions, input.sessionId).revert(input.token); emit({ type: "request.completed", requestId: input.requestId }); return;
    case "session.archive": case "session.unarchive": emit({ type: "request.completed", requestId: input.requestId }); return;
    case "session.close": { assertPiIdentifier(input.sessionId, "session id"); const session = sessions.get(input.sessionId); sessions.delete(input.sessionId); allSessions.delete(input.sessionId); await session?.close(); emit({ type: "session.closed", sessionId: input.sessionId }); emit({ type: "request.completed", requestId: input.requestId }); return; }
  }
}

function requireSession(sessions: Map<string, PiProviderSession>, id: string): PiProviderSession { const session = sessions.get(id); if (!session) throw new PiPublicError(`Unknown session: ${id}`); return session; }
function sessionFile(data: unknown): string | undefined { return data && typeof data === "object" && !Array.isArray(data) && typeof (data as Record<string, unknown>).sessionFile === "string" ? (data as Record<string, string>).sessionFile : undefined; }

async function requireSessionForAgent(
  sessions: Map<string, PiProviderSession>,
  agentId: string,
  paseo: PaseoApi,
): Promise<PiProviderSession> {
  const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
  if (agent?.provider !== PI_PROVIDER_ID) throw new PiPublicError("Pi settings are only available for Pi sessions");
  for (const runtimeSessionId of [agent.runtimeInfo?.sessionId, agent.persistence?.sessionId]) {
    const bridgeSessionId = bridgeSessionIdFromRuntimeSessionId(runtimeSessionId);
    if (bridgeSessionId) {
      const session = sessions.get(bridgeSessionId);
      if (session) return session;
    }
  }
  throw new PiPublicError("Pi session is not active");
}

function bridgeSessionIdFromRuntimeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(PLUGIN_PERSISTENCE_PREFIX)) return undefined;
  try {
    const persistence = JSON.parse(value.slice(PLUGIN_PERSISTENCE_PREFIX.length)) as { data?: unknown };
    const data = persistence.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const bridgeSessionId = (data as { bridgeSessionId?: unknown }).bridgeSessionId;
    return typeof bridgeSessionId === "string" && bridgeSessionId.length > 0 && bridgeSessionId.length <= MAX_PROVIDER_SESSION_ID_LENGTH
      ? bridgeSessionId
      : undefined;
  } catch {
    return undefined;
  }
}
