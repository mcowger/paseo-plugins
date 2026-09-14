import { homedir } from "node:os";

import { negotiateProviderCapabilities, type ProviderConnection, type ProviderEvent, type ProviderInput, type ProviderRegistration } from "@getpaseo/plugin/server/provider";

import { createPiMcpConfig } from "./mcp-config.js";
import { startPiSession } from "./runtime.js";
import { createPaseoExtension, PiProviderSession } from "./session.js";

export const PI_PROVIDER_ID = "pi-plugin-mcowger";
const CAPABILITIES = ["prompt.message", "prompt.command", "prompt.image", "prompt.steer", "session.persistence", "session.configure", "session.revert.conversation", "permission"] as const;

export interface ManagedPiProvider extends ProviderRegistration {
  close(): Promise<void>;
}

export function createPiProvider(): ManagedPiProvider {
  const connections = new Set<ProviderConnection>();
  return {
    id: PI_PROVIDER_ID,
    label: "Pi (JSON-RPC)",
    description: "Pi coding agent over an isolated JSON-RPC subprocess per Paseo session.",
    icon: "icon.svg",
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      const connection = createConnection(
        negotiateProviderCapabilities(request.capabilities, CAPABILITIES),
        () => connections.delete(connection),
      );
      connections.add(connection);
      return connection;
    },
    async close() {
      await Promise.all([...connections].map((connection) => connection.close()));
      connections.clear();
    },
  };
}

function createConnection(
  capabilities: readonly string[],
  onClose: () => void,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, PiProviderSession>();
  let closed = false;
  const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Pi provider connection is closed");
      try { await dispatch(input, sessions, emit, capabilities); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if ("requestId" in input) { emit({ type: "request.failed", requestId: input.requestId, error: { message } }); return; }
        if (input.type === "session.prompt") { emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "failed", error: { message } } }); return; }
        throw error;
      }
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...sessions.values()].map((session) => session.close().catch(() => undefined)));
      sessions.clear();
      listeners.clear();
      onClose();
    },
  };
}

async function dispatch(input: ProviderInput, sessions: Map<string, PiProviderSession>, emit: (event: ProviderEvent) => void, capabilities: readonly string[]): Promise<void> {
  switch (input.type) {
    case "catalog": {
      const runtime = await startPiSession({ cwd: input.cwd ?? homedir(), env: {}, persist: false });
      try {
        const models = await runtime.getAvailableModels();
        emit({ type: "catalog", requestId: input.requestId, catalog: { models: models.map((model) => ({ id: `${model.provider}/${model.id}`, label: model.name ?? `${model.provider}/${model.id}`, ...(model.contextWindow ? { contextWindowMaxTokens: model.contextWindow } : {}), ...(model.reasoning ? { thinkingOptions: thinkingOptions(), defaultThinkingOptionId: "medium" } : {}) })), modes: [], thinkingOptions: thinkingOptions() } });
      } finally { await runtime.close(); }
      return;
    }
    case "sessions": emit({ type: "sessions", requestId: input.requestId, sessions: [] }); return;
    case "session.open": {
      if (sessions.has(input.sessionId)) throw new Error(`Session already exists: ${input.sessionId}`);
      const persisted = sessionFile(input.persistence?.data);
      const extension = createPaseoExtension(input.config.systemPrompt);
      const mcpConfig = await prepareMcpConfig(input.config.cwd, input.config.mcpServers, input.config.env);
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
          emit,
          cleanup: () => { mcpConfig?.cleanup(); extension.cleanup(); },
        });
        sessions.set(input.sessionId, session);
        emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities, restoration: "core", persistence: session.persistence, ...(input.config.title ? { title: input.config.title } : {}), cwd: input.config.cwd });
        await session.initialize();
        if (input.history === "replay" && persisted) await session.replayHistory();
        emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
      } catch (error) {
        sessions.delete(input.sessionId);
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
    case "session.prompt": await requireSession(sessions, input.sessionId).prompt(input.prompt); return;
    case "session.interrupt": await requireSession(sessions, input.sessionId).interrupt(); emit({ type: "request.completed", requestId: input.requestId }); return;
    case "session.permission": requireSession(sessions, input.sessionId).respondToPermission(input.permissionId, input.response); return;
    case "session.configure": await requireSession(sessions, input.sessionId).configure(input.changes); emit({ type: "request.completed", requestId: input.requestId }); return;
    case "session.revert": if (input.scope !== "conversation") throw new Error(`Pi does not support ${input.scope} rewind`); await requireSession(sessions, input.sessionId).revert(input.token); emit({ type: "request.completed", requestId: input.requestId }); return;
    case "session.archive": case "session.unarchive": emit({ type: "request.completed", requestId: input.requestId }); return;
    case "session.close": { const session = sessions.get(input.sessionId); sessions.delete(input.sessionId); await session?.close(); emit({ type: "session.closed", sessionId: input.sessionId }); emit({ type: "request.completed", requestId: input.requestId }); return; }
  }
}

async function prepareMcpConfig(
  cwd: string,
  servers: Readonly<Record<string, import("@getpaseo/plugin/server/provider").ProviderMcpServerConfig>>,
  env: Readonly<Record<string, string>>,
) {
  if (Object.keys(servers).length === 0 || !(await supportsPiMcpAdapter(cwd, env))) return null;
  return createPiMcpConfig(servers, env);
}

async function supportsPiMcpAdapter(cwd: string, env: Readonly<Record<string, string>>): Promise<boolean> {
  let runtime: Awaited<ReturnType<typeof startPiSession>> | undefined;
  try {
    runtime = await startPiSession({ cwd, env: { ...env }, persist: false });
    return (await runtime.getCommands()).some((command) =>
      command.source === "extension" && /^mcp(?::\d+)?$/.test(command.name) && (!command.sourceInfo || JSON.stringify(command.sourceInfo).includes("pi-mcp-adapter")),
    );
  } catch {
    return false;
  } finally {
    await runtime?.close().catch(() => undefined);
  }
}

function requireSession(sessions: Map<string, PiProviderSession>, id: string): PiProviderSession { const session = sessions.get(id); if (!session) throw new Error(`Unknown session: ${id}`); return session; }
function sessionFile(data: unknown): string | undefined { return data && typeof data === "object" && !Array.isArray(data) && typeof (data as Record<string, unknown>).sessionFile === "string" ? (data as Record<string, string>).sessionFile : undefined; }
function thinkingOptions() { return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id === "xhigh" ? "XHigh" : `${id[0]?.toUpperCase()}${id.slice(1)}`, ...(id === "medium" ? { isDefault: true } : {}) })); }
