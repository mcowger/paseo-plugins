import { JSONL_RPC_NO_TIMEOUT, JsonlRpcProcess } from "./jsonl-rpc-process.js";
import type { PiAgentMessage, PiImageContent, PiModel, PiPromptAck, PiRpcSlashCommand, PiRuntimeEvent, PiSessionState, PiSessionStats } from "./rpc-types.js";

export interface PiRuntimeSession {
  onEvent(callback: (event: PiRuntimeEvent) => void): () => void;
  prompt(message: string, images?: PiImageContent[]): Promise<PiPromptAck>;
  steer(message: string, images?: PiImageContent[]): Promise<void>;
  clearQueue(): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<PiSessionState>;
  getMessages(): Promise<PiAgentMessage[]>;
  getAvailableModels(): Promise<PiModel[]>;
  setModel(provider: string, modelId: string): Promise<PiModel>;
  setThinkingLevel(level: string): Promise<void>;
  getSessionStats(): Promise<PiSessionStats>;
  getCommands(): Promise<PiRpcSlashCommand[]>;
  respondToExtensionUiRequest(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void;
  close(): Promise<void>;
}

export interface PiStartSessionInput {
  cwd: string;
  env: Record<string, string>;
  model?: string;
  thinkingOption?: string;
  sessionFile?: string;
  persist: boolean;
  mcpConfigPath?: string;
  extensionPath?: string;
}

export async function startPiSession(input: PiStartSessionInput): Promise<PiRuntimeSession> {
  const command = process.env.PI_COMMAND?.trim() || process.env.PI_ACP_PI_COMMAND?.trim() || "pi";
  const args = ["--mode", "rpc"];
  if (input.model) args.push("--model", input.model);
  if (input.thinkingOption) args.push("--thinking", input.thinkingOption);
  if (!input.persist) args.push("--no-session");
  else if (input.sessionFile) args.push("--session", input.sessionFile);
  if (input.mcpConfigPath) args.push("--mcp-config", input.mcpConfigPath);
  if (input.extensionPath) args.push("--extension", input.extensionPath);
  const processHandle = new JsonlRpcProcess({
    launch: { command, args, cwd: input.cwd, env: input.env },
  });
  return new RpcSession(processHandle);
}

class RpcSession implements PiRuntimeSession {
  private readonly listeners = new Set<(event: PiRuntimeEvent) => void>();

  constructor(private readonly process: JsonlRpcProcess) {
    process.onMessage((event) => {
      for (const listener of this.listeners) listener(event as PiRuntimeEvent);
    });
    process.onExit((error) => {
      for (const listener of this.listeners) listener({ type: "process_exit", error: error.message });
    });
  }

  onEvent(callback: (event: PiRuntimeEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async prompt(message: string, images?: PiImageContent[]): Promise<PiPromptAck> {
    const request = this.process.startRequest({ type: "prompt", message, ...(images?.length ? { images } : {}) });
    const data = await request.promise;
    return typeof data === "object" && data !== null && typeof (data as { agentInvoked?: unknown }).agentInvoked === "boolean"
      ? { requestId: request.id, agentInvoked: (data as { agentInvoked: boolean }).agentInvoked }
      : { requestId: request.id };
  }

  async steer(message: string, images?: PiImageContent[]): Promise<void> { await this.process.request({ type: "steer", message, ...(images?.length ? { images } : {}) }); }
  async clearQueue(): Promise<void> { await this.process.request({ type: "clear_queue" }); }
  async compact(customInstructions?: string): Promise<void> { await this.process.request({ type: "compact", ...(customInstructions ? { customInstructions } : {}) }, JSONL_RPC_NO_TIMEOUT); }
  async setAutoCompaction(enabled: boolean): Promise<void> { await this.process.request({ type: "set_auto_compaction", enabled }); }
  async abort(): Promise<void> { await this.process.request({ type: "abort" }); }
  async getState(): Promise<PiSessionState> { return await this.process.request({ type: "get_state" }) as PiSessionState; }
  async getMessages(): Promise<PiAgentMessage[]> { return ((await this.process.request({ type: "get_messages" })) as { messages?: PiAgentMessage[] }).messages ?? []; }
  async getAvailableModels(): Promise<PiModel[]> { return ((await this.process.request({ type: "get_available_models" })) as { models?: PiModel[] }).models ?? []; }
  async setModel(provider: string, modelId: string): Promise<PiModel> { return await this.process.request({ type: "set_model", provider, modelId }) as PiModel; }
  async setThinkingLevel(level: string): Promise<void> { await this.process.request({ type: "set_thinking_level", level }); }
  async getSessionStats(): Promise<PiSessionStats> {
    try {
      const stats = await this.process.request({ type: "get_session_stats" }) as PiSessionStats;
      if (stats.tokens || stats.cost !== undefined || stats.contextUsage) return stats;
    } catch {
      // Older Pi builds do not implement get_session_stats.
    }
    try {
      const state = await this.getState();
      return state.contextUsage ? { contextUsage: state.contextUsage } : {};
    } catch {
      return {};
    }
  }
  async getCommands(): Promise<PiRpcSlashCommand[]> { return ((await this.process.request({ type: "get_commands" })) as { commands?: PiRpcSlashCommand[] }).commands ?? []; }
  respondToExtensionUiRequest(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void { this.process.send({ type: "extension_ui_response", id, ...response }); }
  async close(): Promise<void> { await this.process.close(); }
}
