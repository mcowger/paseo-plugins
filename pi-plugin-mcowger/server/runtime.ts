import { execFile } from "node:child_process";

import { JsonlRpcProcess, JSONL_RPC_NO_TIMEOUT } from "./jsonl-rpc.js";
import type {
  PiAgentMessage,
  PiModel,
  PiPromptAck,
  PiRpcCommand,
  PiRpcSlashCommand,
  PiRuntimeEvent,
  PiSessionState,
  PiSessionStats,
} from "../shared/rpc-types.js";

export const MIN_PI_VERSION = "0.85.1";
export const DEFAULT_PI_COMMAND = process.env.PI_COMMAND ?? "pi";

export interface PiStartSessionInput {
  cwd: string;
  env?: Record<string, string>;
  model?: string;
  thinkingLevel?: string;
  session?: string;
  noSession?: boolean;
  mcpConfigPath?: string;
  extensionPaths?: string[];
  extraArgs?: string[];
  requestLog?: PiRequestLog;
}

export interface PiRuntimeSession {
  onEvent(callback: (event: PiRuntimeEvent) => void): () => void;
  prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<PiPromptAck>;
  steer(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void>;
  clearQueue(): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<PiSessionState>;
  getMessages(): Promise<PiAgentMessage[]>;
  getEntries(): Promise<{ entries: unknown[]; leafId: string | null }>;
  getAvailableModels(timeoutMs?: number | null): Promise<PiModel[]>;
  getAvailableThinkingLevels(): Promise<string[]>;
  setModel(provider: string, modelId: string): Promise<PiModel>;
  setThinkingLevel(level: string): Promise<void>;
  getSessionStats(): Promise<PiSessionStats>;
  getCommands(): Promise<PiRpcSlashCommand[]>;
  request(command: PiRpcCommand, timeoutMs?: number | null): Promise<unknown>;
  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void;
  close(): Promise<void>;
}

export function buildPiLaunchArgv(command: string, session: PiStartSessionInput): string[] {
  const argv = [command, "--mode", "rpc"];
  if (session.extraArgs?.length) {
    argv.push(...session.extraArgs);
  }
  if (session.model) {
    argv.push("--model", session.model);
  }
  if (session.thinkingLevel) {
    argv.push("--thinking", session.thinkingLevel);
  }
  if (session.noSession) {
    argv.push("--no-session");
  } else if (session.session) {
    argv.push("--session", session.session);
  }
  if (session.mcpConfigPath) {
    argv.push("--mcp-config", session.mcpConfigPath);
  }
  for (const extensionPath of session.extensionPaths ?? []) {
    argv.push("--extension", extensionPath);
  }
  return argv;
}

export interface PiCliRuntimeOptions {
  command?: string;
  requestTimeoutMs?: number;
}

type PiRequestLog = (message: string) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class PiCliRuntime {
  private readonly command: string;
  private readonly requestTimeoutMs: number;

  constructor(options: PiCliRuntimeOptions = {}) {
    this.command = options.command ?? DEFAULT_PI_COMMAND;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async startSession(input: PiStartSessionInput): Promise<PiRuntimeSession> {
    const [command, ...args] = buildPiLaunchArgv(this.command, input);
    const log = input.requestLog;
    log?.(`spawn: ${command} ${args.join(" ")} (cwd=${input.cwd})`);
    const process = new JsonlRpcProcess({
      launch: { command, args, cwd: input.cwd, env: input.env },
      diagnosticName: "Pi RPC",
      defaultRequestTimeoutMs: this.requestTimeoutMs,
      onProblem: (problem) => {
        console.warn(`[pi-plugin-mcowger] Ignoring invalid Pi RPC frame: ${problem}`);
      },
    });
    return new PiCliRuntimeSession(process, log);
  }

  async probeVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.command,
        ["--version"],
        { timeout: 15_000 },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          const match = stdout.trim().match(/(\d+)\.(\d+)\.(\d+)/);
          if (!match) {
            reject(new Error(`Could not parse pi version from: ${stdout.trim()}`));
            return;
          }
          resolve(`${match[1]}.${match[2]}.${match[3]}`);
        },
      );
    });
  }
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

class PiCliRuntimeSession implements PiRuntimeSession {
  private readonly subscribers = new Set<(event: PiRuntimeEvent) => void>();
  private readonly log?: PiRequestLog;

  constructor(process: JsonlRpcProcess, log?: PiRequestLog) {
    this.process = process;
    this.log = log;
    process.onMessage((message) => {
      this.emit(message as PiRuntimeEvent);
    });
    process.onExit(({ error }) => {
      this.log?.(`pi process exited: ${error.message.split("\n")[0]}`);
      this.emit({ type: "process_exit", error: error.message });
    });
  }

  private readonly process: JsonlRpcProcess;

  onEvent(callback: (event: PiRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<PiPromptAck> {
    const { id: requestId, promise } = this.process.startRequest({
      type: "prompt",
      message,
      ...(images?.length ? { images } : {}),
    });
    const data = await promise;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const { agentInvoked } = data as Record<string, unknown>;
      if (typeof agentInvoked === "boolean") {
        return { requestId, agentInvoked };
      }
    }
    return { requestId };
  }

  async steer(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void> {
    await this.request({
      type: "steer",
      message,
      ...(images?.length ? { images } : {}),
    });
  }

  async clearQueue(): Promise<void> {
    await this.request({ type: "clear_queue" });
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" });
  }

  async getState(): Promise<PiSessionState> {
    return (await this.request({ type: "get_state" })) as PiSessionState;
  }

  async getMessages(): Promise<PiAgentMessage[]> {
    const data = (await this.request({ type: "get_messages" })) as {
      messages?: PiAgentMessage[];
    };
    return data.messages ?? [];
  }

  async getEntries(): Promise<{ entries: unknown[]; leafId: string | null }> {
    const data = (await this.request({ type: "get_entries" })) as {
      entries?: unknown[];
      leafId?: string | null;
    };
    return { entries: data.entries ?? [], leafId: data.leafId ?? null };
  }

  async getAvailableModels(timeoutMs?: number | null): Promise<PiModel[]> {
    const data = (await this.request({ type: "get_available_models" }, timeoutMs)) as {
      models?: PiModel[];
    };
    return data.models ?? [];
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    const data = (await this.request({ type: "get_available_thinking_levels" })) as {
      levels?: string[];
    };
    return data.levels ?? [];
  }

  async setModel(provider: string, modelId: string): Promise<PiModel> {
    return (await this.request({ type: "set_model", provider, modelId })) as PiModel;
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.request({ type: "set_thinking_level", level: level as never });
  }

  async getSessionStats(): Promise<PiSessionStats> {
    return (await this.request({ type: "get_session_stats" })) as PiSessionStats;
  }

  async getCommands(): Promise<PiRpcSlashCommand[]> {
    const data = (await this.request({ type: "get_commands" })) as {
      commands?: PiRpcSlashCommand[];
    };
    return data.commands ?? [];
  }

  request(command: PiRpcCommand, timeoutMs?: number | null): Promise<unknown> {
    const startedAt = Date.now();
    this.log?.(`rpc -> ${command.type}`);
    return this.process.request(command, timeoutMs).then(
      (data) => {
        this.log?.(`rpc <- ${command.type} ok in ${Date.now() - startedAt}ms`);
        return data;
      },
      (error) => {
        this.log?.(
          `rpc <- ${command.type} failed in ${Date.now() - startedAt}ms: ${
            error instanceof Error ? error.message.split("\n")[0] : String(error)
          }`,
        );
        throw error;
      },
    );
  }

  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void {
    this.process.send({ type: "extension_ui_response", id, ...response });
  }

  async close(): Promise<void> {
    await this.process.close(new Error("Pi RPC session is closed"));
  }

  private emit(event: PiRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

export { JSONL_RPC_NO_TIMEOUT };
