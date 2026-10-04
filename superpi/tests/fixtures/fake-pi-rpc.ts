import { companionPrefix } from "../../shared/companion.js";
import type { PiExitListener, PiRecord, PiRecordListener, PiRpc } from "../../server/pi-rpc.js";

/**
 * Test-only `PiRpc` double.
 *
 * It answers the Stage 1 discovery/state commands, plays the companion
 * notification handshake, and lets tests emit arbitrary Pi JSONL records or a
 * terminal transport failure without spawning a real process.
 */

export interface FakePiRpcOptions {
  state?: Record<string, unknown>;
  /** Dynamic replacement for `get_state`, invoked per call. */
  stateProvider?: () => unknown;
  models?: unknown[];
  levels?: string[];
  commands?: unknown[];
  messages?: unknown[];
  /** Dynamic replacement for `get_messages`, invoked per call. */
  messagesProvider?: () => unknown[];
  /** Static `get_entries` payload, or a dynamic provider. */
  entries?: unknown[];
  /** Static `get_session_stats` payload, or a dynamic provider. */
  sessionStats?: unknown;
  sessionStatsProvider?: () => unknown;
  leafId?: string | null;
  entriesProvider?: () => unknown;
  /** Custom `clear_queue` response; defaults to empty queues. */
  clearQueue?: unknown;
  /** Custom companion `rewind` reply data; defaults to a successful no-op. */
  rewindData?: unknown;
  /** When set, the companion replies `ok: false` for a rewind with this error. */
  rewindError?: string;
  onRewind?: () => void;
  promptDisposition?: "started" | "queued" | "handled";
  /** Per-command disposition; takes precedence over `promptDisposition`. */
  promptDispositionProvider?: (command: PiRecord) => "started" | "queued" | "handled";
  onPrompt?: (command: PiRecord) => void;
  /** Invoked before default handling; may be async to hold a request open. */
  onRequest?: (command: PiRecord, fake: FakePiRpc) => void | Promise<void>;
  /** Companion `hello` data; defaults to a valid root state. */
  helloData?: unknown;
  companionStateProvider?: () => unknown;
}

export class FakePiRpc implements PiRpc {
  readonly pid = 4242;
  readonly requests: PiRecord[] = [];
  readonly sent: PiRecord[] = [];
  readonly companionSettings: { tier: string; longContext: boolean } = {
    tier: "default",
    longContext: false,
  };
  closed = false;
  private readonly recordListeners = new Set<PiRecordListener>();
  private readonly exitListeners = new Set<PiExitListener>();
  private readonly options: FakePiRpcOptions;

  constructor(options: FakePiRpcOptions = {}) {
    this.options = options;
  }

  emit(record: PiRecord): void {
    for (const listener of this.recordListeners) listener(record);
  }

  fail(error: Error): void {
    for (const listener of this.exitListeners) listener(error);
  }

  requestsOfType(type: string): PiRecord[] {
    return this.requests.filter((record) => record.type === type);
  }

  async request(command: PiRecord): Promise<unknown> {
    this.requests.push(command);
    await this.options.onRequest?.(command, this);
    switch (command.type) {
      case "get_state":
        if (this.options.stateProvider) return this.options.stateProvider();
        return (
          this.options.state ?? {
            sessionId: "pi-session-1",
            sessionFile: undefined,
            model: {
              provider: "test",
              id: "model",
              name: "Model",
              reasoning: true,
              contextWindow: 1000,
            },
            thinkingLevel: "medium",
          }
        );
      case "get_available_models":
        return { models: this.options.models ?? [] };
      case "get_available_thinking_levels":
        return { levels: this.options.levels ?? ["off", "medium", "high"] };
      case "get_commands":
        return {
          commands: this.options.commands ?? [{ name: "superpi-control", description: "Superpi companion" }],
        };
      case "get_messages":
        return {
          messages: this.options.messagesProvider
            ? this.options.messagesProvider()
            : (this.options.messages ?? []),
        };
      case "get_entries":
        if (this.options.entriesProvider) return this.options.entriesProvider();
        return {
          entries: this.options.entries ?? [],
          leafId: this.options.leafId ?? null,
        };
      case "get_session_stats":
        if (this.options.sessionStatsProvider) return this.options.sessionStatsProvider();
        return this.options.sessionStats ?? {
          sessionId: "pi-session-1",
          sessionFile: undefined,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
          contextUsage: { tokens: 0, contextWindow: 1000, percent: 0 },
        };
      case "prompt": {
        this.options.onPrompt?.(command);
        const message = String(command.message ?? "");
        if (message.startsWith("/superpi-control ")) {
          this.replyCompanion(message.slice("/superpi-control ".length));
          return { disposition: "handled" };
        }
        return {
          disposition:
            this.options.promptDispositionProvider?.(command) ??
            this.options.promptDisposition ??
            "started",
        };
      }
      case "clear_queue":
        return this.options.clearQueue ?? { steering: [], followUp: [] };
      default:
        return undefined;
    }
  }

  async send(record: PiRecord): Promise<void> {
    this.sent.push(record);
  }

  onRecord(listener: PiRecordListener): () => void {
    this.recordListeners.add(listener);
    return () => {
      this.recordListeners.delete(listener);
    };
  }

  onExit(listener: PiExitListener): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  diagnosticTail(): string {
    return "";
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private replyCompanion(encoded: string): void {
    const request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    let data: unknown;
    if (request.operation === "hello") {
      const hello = this.options.helloData;
      if (hello !== null && typeof hello === "object" && !Array.isArray(hello)) {
        const settings = (hello as { settings?: unknown }).settings;
        if (settings !== null && typeof settings === "object" && !Array.isArray(settings)) {
          const record = settings as Record<string, unknown>;
          if (typeof record.tier === "string") this.companionSettings.tier = record.tier;
          if (typeof record.longContext === "boolean") {
            this.companionSettings.longContext = record.longContext;
          }
        }
      }
      data =
        hello ?? {
          capabilities: ["tier", "context"],
          tiers: ["default", "fast", "flex", "ultrafast"],
          longContextAvailable: true,
          settings: { ...this.companionSettings },
          sessionId: "pi-session-1",
        };
    } else if (request.operation === "configure" || request.operation === "get-state") {
      const requested = request.data;
      if (requested !== null && typeof requested === "object" && !Array.isArray(requested)) {
        const record = requested as Record<string, unknown>;
        if (typeof record.tier === "string") this.companionSettings.tier = record.tier;
        if (typeof record.longContext === "boolean") {
          this.companionSettings.longContext = record.longContext;
        }
      }
      data = this.options.companionStateProvider?.() ?? {
        capabilities: ["tier", "context"],
        tiers: ["default", "fast", "flex", "ultrafast"],
        longContextAvailable: true,
        settings: { ...this.companionSettings },
        sessionId: "pi-session-1",
      };
    } else if (request.operation === "rewind") {
      this.options.onRewind?.();
      if (this.options.rewindError !== undefined) {
        this.emit({
          type: "extension_ui_request",
          method: "notify",
          message:
            companionPrefix +
            JSON.stringify({
              version: 1,
              sessionKey: request.sessionKey,
              requestId: request.requestId,
              operation: request.operation,
              ok: false,
              error: this.options.rewindError,
            }),
        });
        return;
      }
      const requested = request.data;
      const targetEntryId =
        requested !== null && typeof requested === "object" && !Array.isArray(requested)
          ? String((requested as Record<string, unknown>).targetEntryId ?? "")
          : "";
      data =
        this.options.rewindData ?? {
          cancelled: false,
          targetEntryId,
          settings: { ...this.companionSettings },
          activeChildren: 0,
        };
    } else {
      data = {};
    }
    this.emit({
      type: "extension_ui_request",
      method: "notify",
      message:
        companionPrefix +
        JSON.stringify({
          version: 1,
          sessionKey: request.sessionKey,
          requestId: request.requestId,
          operation: request.operation,
          ok: true,
          data,
        }),
    });
  }
}
