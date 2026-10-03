import type {
  ProviderCatalog,
  ProviderConnectRequest,
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { negotiateProviderCapabilities } from "@getpaseo/plugin/server/provider";
import { createDialogRegistry, type DialogRegistry } from "./dialogs.js";
import { createPiRpc, type PiRpc, type PiRpcOptions } from "./pi-rpc.js";
import {
  SUPERPI_SESSION_CAPABILITIES,
  SuperpiSession,
  mapPiModels,
  mapPiThinkingLevels,
} from "./session.js";

/**
 * Public Paseo provider for Pi over subprocess JSONL RPC (Stage 1 root slice).
 *
 * `createSuperpiProvider` returns the `ProviderRegistration` plus an idempotent
 * `close()` that tears down every live connection. The caller (plugin entry)
 * owns wiring the registration into `server.registerProvider(...)` and calling
 * `close()` from its contributed cleanup.
 */

export interface CreateSuperpiProviderOptions {
  /** Pi executable; defaults to `pi`. Internal launch value, not a registration field. */
  command?: string;
  /** Explicit path to the Superpi Pi companion extension. */
  companionPath: string;
  /** Plugin-owned root directory for durable session metadata. */
  stateDirectory: string;
  /** Test seam: override the transport factory to avoid spawning real Pi. */
  createPiRpc?: (options: PiRpcOptions) => Promise<PiRpc>;
}

export interface SuperpiProvider {
  registration: ProviderRegistration;
  /** Aggregated native dialog registry for the plugin RPC surface. */
  dialogs: DialogRegistry;
  close(): Promise<void>;
}

interface CatalogDiscovery {
  command: string;
  createRpc: (options: PiRpcOptions) => Promise<PiRpc>;
  cwd?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractArray(data: unknown, key: string): unknown[] {
  if (!isRecord(data)) return [];
  const value = data[key];
  return Array.isArray(value) ? value : [];
}

function modelKey(model: unknown): string | undefined {
  if (!isRecord(model)) return undefined;
  const provider = asString(model.provider);
  const id = asString(model.id);
  return provider && id ? `${provider}/${id}` : undefined;
}

/**
 * Launch a temporary, non-persistent Pi process, read its catalog, and close it.
 * Discovery performs no model work and leaves no session behind (`--no-session`).
 */
export async function discoverCatalog(input: CatalogDiscovery): Promise<ProviderCatalog> {
  const { command, createRpc, cwd } = input;
  const rpc = await createRpc({
    command,
    args: ["--mode", "rpc", "--no-session"],
    cwd: cwd ?? process.cwd(),
  });
  let catalog: ProviderCatalog;
  try {
    const state = await rpc.request({ type: "get_state" });
    const models = mapPiModels(
      extractArray(await rpc.request({ type: "get_available_models" }), "models"),
      modelKey(isRecord(state) ? state.model : undefined),
    );
    const thinkingOptions = mapPiThinkingLevels(
      extractArray(
        await rpc.request({ type: "get_available_thinking_levels" }),
        "levels",
      ).filter((level): level is string => typeof level === "string"),
    );
    const defaultModel = modelKey(isRecord(state) ? state.model : undefined);
    const defaultThinkingOption = isRecord(state) ? asString(state.thinkingLevel) : undefined;
    catalog = {
      models,
      modes: [],
      thinkingOptions,
      ...(defaultModel ? { defaultModel } : {}),
      ...(defaultThinkingOption ? { defaultThinkingOption } : {}),
    };
  } catch (error) {
    await rpc.close().catch(() => undefined);
    throw error;
  }
  // Unconfirmed cleanup must not be swallowed when discovery itself succeeded.
  await rpc.close();
  return catalog;
}

export function createSuperpiProvider(options: CreateSuperpiProviderOptions): SuperpiProvider {
  const command = options.command ?? "pi";
  const createRpc = options.createPiRpc ?? createPiRpc;
  const connections = new Set<SuperpiConnection>();
  const dialogs = createDialogRegistry();

  const registration: ProviderRegistration = {
    id: "superpi",
    label: "Superpi",
    description: "Pi over subprocess JSON-RPC with the required Superpi companion.",
    async getCatalogCacheKey() {
      return undefined;
    },
    async connect(request: ProviderConnectRequest): Promise<ProviderConnection> {
      const connection = new SuperpiConnection(request, {
        command,
        companionPath: options.companionPath,
        stateDirectory: options.stateDirectory,
        createRpc,
        dialogRegistry: dialogs,
      });
      connections.add(connection);
      return connection;
    },
  };

  return {
    registration,
    dialogs,
    async close(): Promise<void> {
      const live = [...connections];
      connections.clear();
      await Promise.all(live.map((connection) => connection.close()));
    },
  };
}

interface ConnectionDependencies {
  command: string;
  companionPath: string;
  stateDirectory: string;
  createRpc: (options: PiRpcOptions) => Promise<PiRpc>;
  dialogRegistry: DialogRegistry;
}

class SuperpiConnection implements ProviderConnection {
  readonly version = 1;
  readonly capabilities: readonly string[];
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly sessions = new Map<string, SuperpiSession>();
  private closed = false;

  constructor(
    request: ProviderConnectRequest,
    private readonly deps: ConnectionDependencies,
  ) {
    this.capabilities = negotiateProviderCapabilities(
      request.capabilities,
      SUPERPI_SESSION_CAPABILITIES,
    );
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A provider event listener must not break session delivery.
      }
    }
  }

  async send(input: ProviderInput): Promise<void> {
    if (this.closed) throw new Error("Superpi provider connection is closed");
    switch (input.type) {
      case "catalog":
        await this.handleCatalog(input);
        return;
      case "sessions":
        this.emit({ type: "sessions", requestId: input.requestId, sessions: [] });
        return;
      case "session.open":
        await this.handleOpen(input);
        return;
      case "session.prompt":
        await this.handlePrompt(input);
        return;
      case "session.configure":
        await this.handleConfigure(input);
        return;
      case "session.interrupt":
        await this.handleInterrupt(input);
        return;
      case "session.close":
        await this.handleClose(input);
        return;
      case "session.revert":
        await this.handleRevert(input);
        return;
      case "session.permission":
        await this.handlePermission(input);
        return;
      case "session.archive":
      case "session.unarchive":
        this.emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: `${input.type} is not supported by Superpi stage 1` },
        });
        return;
      default: {
        const exhaustive: never = input;
        throw new Error(`Unhandled Superpi provider input: ${String((exhaustive as { type?: string }).type)}`);
      }
    }
  }

  private async handleCatalog(
    input: Extract<ProviderInput, { type: "catalog" }>,
  ): Promise<void> {
    try {
      const catalog = await discoverCatalog({
        command: this.deps.command,
        createRpc: this.deps.createRpc,
        cwd: input.cwd,
      });
      this.emit({ type: "catalog", requestId: input.requestId, catalog });
    } catch (error) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: error instanceof Error ? { message: error.message } : { message: String(error) },
      });
    }
  }

  private async handleOpen(
    input: Extract<ProviderInput, { type: "session.open" }>,
  ): Promise<void> {
    if (this.sessions.has(input.sessionId)) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: `Superpi session already exists: ${input.sessionId}` },
      });
      return;
    }
    const session = new SuperpiSession({
      sessionId: input.sessionId,
      config: input.config,
      persistence: input.persistence,
      history: input.history,
      stateDirectory: this.deps.stateDirectory,
      command: this.deps.command,
      companionPath: this.deps.companionPath,
      capabilities: this.capabilities,
      dialogRegistry: this.deps.dialogRegistry,
      createPiRpc: this.deps.createRpc,
      emit: (event) => {
        this.emit(event);
        // A failed or self-closed session must not keep its map entry, or a
        // later open of the same id would be rejected as a duplicate.
        if (event.type === "session.closed" && event.sessionId === input.sessionId) {
          if (this.sessions.get(input.sessionId) === session) this.sessions.delete(input.sessionId);
        }
      },
    });
    this.sessions.set(input.sessionId, session);
    await session.open(input.requestId);
  }

  private async handlePrompt(
    input: Extract<ProviderInput, { type: "session.prompt" }>,
  ): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new Error(`Superpi session not found: ${input.sessionId}`);
    await session.prompt(input.prompt);
  }

  private async handleConfigure(
    input: Extract<ProviderInput, { type: "session.configure" }>,
  ): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: `Superpi session not found: ${input.sessionId}` },
      });
      return;
    }
    await session.configure(input.requestId, input.changes);
  }

  private async handleInterrupt(
    input: Extract<ProviderInput, { type: "session.interrupt" }>,
  ): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: `Superpi session not found: ${input.sessionId}` },
      });
      return;
    }
    await session.interrupt(input.requestId);
  }

  private async handleRevert(
    input: Extract<ProviderInput, { type: "session.revert" }>,
  ): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: `Superpi session not found: ${input.sessionId}` },
      });
      return;
    }
    await session.revert(input.requestId, input.token, input.scope);
  }

  private async handlePermission(
    input: Extract<ProviderInput, { type: "session.permission" }>,
  ): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) return;
    await session.respondPermission(input.permissionId, input.response);
  }

  private async handleClose(
    input: Extract<ProviderInput, { type: "session.close" }>,
  ): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    this.sessions.delete(input.sessionId);
    try {
      if (session) await session.close();
      else this.emit({ type: "session.closed", sessionId: input.sessionId });
      this.emit({ type: "request.completed", requestId: input.requestId });
    } catch (error) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: error instanceof Error ? { message: error.message } : { message: String(error) },
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const live = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(live.map((session) => session.close()));
    this.listeners.clear();
  }
}
