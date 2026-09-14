import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderCommand, ProviderConfigChanges, ProviderConfigState, ProviderEvent, ProviderPermissionRequest, ProviderPermissionResponse, ProviderPersistence, ProviderPrompt, ProviderSessionConfig, ProviderTimelineItem, ProviderUsage } from "@getpaseo/plugin/server/provider";

import type { PiAgentMessage, PiAgentSessionEvent, PiModel, PiRuntimeEvent, PiSessionState } from "./rpc-types.js";
import type { PiRuntimeSession } from "./runtime.js";
import { thinkingConfigForModel } from "./thinking.js";
import { PI_COMPATIBILITY_MODES } from "./modes.js";
import { mapToolDetail, parseToolArgs, parseToolResult, resolveToolCallName, type PiTrackedToolCall } from "./tool-call-mapper.js";

const DEFAULT_THINKING_LEVEL = "medium";
const RESPONSE_HEADER = "Response";
const AUTO_COMPACTION_SETTING = "autoCompaction";
const AUTO_RETRY_SETTING = "autoRetry";
const FAST_MODE_SETTING = "fastMode";
const FAST_MODE_COMMAND = "fast";
const FAST_MODE_STATUS_COMMAND = "fast-status";
const FAST_MODE_QUERY_TIMEOUT_MS = 5_000;
const BUILTIN_COMMANDS: readonly ProviderCommand[] = [
  {
    name: "compact",
    description: "Manually compact the session context",
    argumentHint: "[instructions]",
  },
];

export interface PiProviderSessionOptions {
  sessionId: string;
  config: ProviderSessionConfig;
  runtime: PiRuntimeSession;
  state: PiSessionState;
  models: PiModel[];
  emit(event: ProviderEvent): void;
  cleanup(): void;
}

interface PendingQuestion { method: string; }

interface ActiveCompaction {
  id: string;
  trigger: "auto" | "manual";
}

interface ManualCompactionCommand {
  clientMessageId: string;
  started: boolean;
  completed: boolean;
}

interface FastModeStatus {
  type: "pi-gpt-fast-mode.status";
  requestId?: string;
  enabled: boolean;
  model: string;
  supported: boolean;
}

export class PiProviderSession {
  private readonly toolCalls = new Map<string, PiTrackedToolCall>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly unsubscribe: () => void;
  private turnId: string | null = null;
  private clientMessageId: string | null = null;
  private assistantMessageId: string | null = null;
  private turnStarted = false;
  private pendingTerminalMessages: PiAgentMessage[] | null = null;
  private autoRetryEnabled = false;
  private activeCompaction: ActiveCompaction | null = null;
  private manualCompactionCommand: ManualCompactionCommand | null = null;
  private fastModeExtension = false;
  private fastModeAvailable = false;
  private fastModeEnabled = false;
  private readonly fastModeQueries = new Map<string, (status: FastModeStatus) => void>();
  private usageGeneration = 0;
  private usageTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly options: PiProviderSessionOptions) {
    this.autoRetryEnabled = settingBoolean(options.config.settings, AUTO_RETRY_SETTING) ?? false;
    this.unsubscribe = options.runtime.onEvent((event) => this.onEvent(event));
  }

  get persistence(): ProviderPersistence {
    return { version: 1, data: { sessionFile: this.options.state.sessionFile ?? null, cwd: this.options.config.cwd } };
  }

  async initialize(): Promise<void> {
    const autoCompaction = settingBoolean(this.options.config.settings, AUTO_COMPACTION_SETTING);
    if (autoCompaction !== undefined) {
      await this.options.runtime.setAutoCompaction(autoCompaction);
      this.options.state.autoCompactionEnabled = autoCompaction;
    }
    const autoRetry = settingBoolean(this.options.config.settings, AUTO_RETRY_SETTING);
    if (autoRetry !== undefined) {
      await this.options.runtime.setAutoRetry(autoRetry);
      this.autoRetryEnabled = autoRetry;
    }
    const commands = await this.options.runtime.getCommands().catch(() => []);
    this.fastModeExtension = hasExtensionCommand(commands, FAST_MODE_COMMAND)
      && hasExtensionCommand(commands, FAST_MODE_STATUS_COMMAND);
    if (this.fastModeExtension) {
      const status = await this.queryFastMode().catch(() => undefined);
      this.applyFastModeStatus(status);
      const configuredFastMode = settingBoolean(this.options.config.settings, FAST_MODE_SETTING);
      if (this.fastModeAvailable && configuredFastMode !== undefined) await this.setFastMode(configuredFastMode);
    }
    this.emitConfig();
    this.emit({
      type: "session.commands",
      sessionId: this.options.sessionId,
      commands: mergeCommands(commands.map((command): ProviderCommand => ({
        name: command.name,
        description: command.description ?? command.source,
      }))),
    });
  }

  async replayHistory(): Promise<void> {
    const messages = await this.options.runtime.getMessages();
    let userIndex = 0;
    for (const message of messages) {
      if (message.role === "user") {
        const text = messageText(message.content);
        if (text) this.timeline({ type: "user_message", id: `history-user-${++userIndex}`, messageId: `history-user-${userIndex}`, text });
      } else if (message.role === "custom") {
        const text = messageText(message.content);
        if (text) this.timeline({ type: "assistant_message", id: randomUUID(), text });
      } else if (message.role === "assistant") {
        const messageId = message.responseId ?? randomUUID();
        for (const content of message.content) {
          if (content.type === "text" && content.text) this.timeline({ type: "assistant_message", id: messageId, messageId, text: content.text });
          if (content.type === "thinking" && content.thinking) this.timeline({ type: "reasoning", id: `${messageId}:thinking`, text: content.thinking });
          if (content.type === "toolCall") {
            const tracked = parseToolArgs(content.name, content.arguments);
            this.toolCalls.set(content.id, tracked);
            this.emitTool(content.id, tracked, "running", null, null);
          }
        }
      } else if (message.role === "toolResult") {
        const tracked = this.toolCalls.get(message.toolCallId) ?? parseToolArgs(message.toolName, null);
        this.toolCalls.delete(message.toolCallId);
        this.emitTool(message.toolCallId, tracked, message.isError ? "failed" : "completed", parseToolResult(message.content), message.isError ? message.content : null);
      }
    }
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.closed) return this.promptFailed(prompt.clientMessageId, "Pi session is closed");
    const text = prompt.input.type === "command" ? `/${prompt.input.name}${prompt.input.arguments ? ` ${prompt.input.arguments}` : ""}` : prompt.input.content.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n\n");
    const images = prompt.input.type === "message" ? prompt.input.content.filter((part): part is Extract<typeof part, { type: "image" }> => part.type === "image") : [];
    const compactArguments = getCompactArguments(prompt, text);
    if (compactArguments !== null) {
      await this.executeCompactCommand(prompt.clientMessageId, compactArguments);
      return;
    }
    if (prompt.delivery === "steer" && this.turnId && !text.startsWith("/")) {
      try {
        await this.options.runtime.steer(text, images);
        this.emit({ type: "session.prompt_result", sessionId: this.options.sessionId, clientMessageId: prompt.clientMessageId, result: { type: "steer", turnId: this.turnId } });
      } catch (error) { this.promptFailed(prompt.clientMessageId, errorMessage(error)); }
      return;
    }
    if (this.turnId) return this.promptFailed(prompt.clientMessageId, "A Pi turn is already active");
    const turnId = randomUUID();
    this.turnId = turnId;
    this.usageGeneration += 1;
    this.scheduleUsagePoll(this.usageGeneration, turnId);
    this.clientMessageId = prompt.clientMessageId;
    this.turnStarted = false;
    this.pendingTerminalMessages = null;
    this.emit({ type: "session.prompt_result", sessionId: this.options.sessionId, clientMessageId: prompt.clientMessageId, result: { type: "turn", turnId } });
    try {
      const ack = await this.options.runtime.prompt(text, images);
      if (ack.agentInvoked === false && this.turnId === turnId) this.finish(turnId, []);
    } catch (error) {
      if (this.turnId !== turnId) return;
      this.finish(turnId, [], errorMessage(error));
    }
  }

  async interrupt(): Promise<void> {
    const turnId = this.turnId;
    try {
      await this.options.runtime.clearQueue();
    } catch (error) {
      if (errorMessage(error) !== "Unknown command: clear_queue") throw error;
    }
    await this.options.runtime.abort();
    if (turnId && this.turnId === turnId) this.finish(turnId, [], undefined, true);
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    if (changes.model) {
      const [provider, ...rest] = changes.model.split("/");
      const modelId = rest.join("/");
      if (!provider || !modelId) throw new Error("Pi model id must include a provider");
      await this.options.runtime.setModel(provider, modelId);
      this.options.state = await this.options.runtime.getState();
      this.options.config.model = changes.model;
      this.options.config.thinkingOption = this.options.state.thinkingLevel;
    }
    if (changes.thinkingOption !== undefined) {
      const level = changes.thinkingOption ?? DEFAULT_THINKING_LEVEL;
      await this.options.runtime.setThinkingLevel(level);
      this.options.state = await this.options.runtime.getState();
      this.options.config.thinkingOption = this.options.state.thinkingLevel;
    }
    if (changes.model && this.fastModeExtension) {
      this.applyFastModeStatus(await this.queryFastMode().catch(() => undefined));
    }
    const autoCompaction = settingBoolean(changes.settings, AUTO_COMPACTION_SETTING);
    if (autoCompaction !== undefined) {
      await this.options.runtime.setAutoCompaction(autoCompaction);
      this.options.state.autoCompactionEnabled = autoCompaction;
    }
    const autoRetry = settingBoolean(changes.settings, AUTO_RETRY_SETTING);
    if (autoRetry !== undefined) {
      await this.options.runtime.setAutoRetry(autoRetry);
      this.autoRetryEnabled = autoRetry;
    }
    const fastMode = settingBoolean(changes.settings, FAST_MODE_SETTING);
    if (fastMode !== undefined && this.fastModeAvailable) await this.setFastMode(fastMode);
    this.emitConfig();
  }

  respondToPermission(id: string, response: ProviderPermissionResponse): void {
    const question = this.questions.get(id);
    if (!question) throw new Error(`No pending permission request with id '${id}'`);
    this.questions.delete(id);
    if (response.behavior === "deny") this.options.runtime.respondToExtensionUiRequest(id, { cancelled: true });
    else {
      const answers = response.updatedInput?.answers;
      const answer = answers && typeof answers === "object" && typeof (answers as Record<string, unknown>)[RESPONSE_HEADER] === "string" ? (answers as Record<string, string>)[RESPONSE_HEADER] : undefined;
      this.options.runtime.respondToExtensionUiRequest(id, question.method === "confirm" ? { confirmed: /^yes$/i.test(answer ?? "") } : answer === undefined ? { cancelled: true } : { value: answer });
    }
    this.emit({ type: "session.permission_resolved", sessionId: this.options.sessionId, permissionId: id });
  }

  async revert(token: unknown): Promise<void> {
    if (this.turnId) throw new Error("Cannot rewind while a Pi turn is active");
    if (typeof token !== "string" || !token.trim()) throw new Error("Pi rewind requires a message id");
    await this.options.runtime.prompt(`/paseo_tree ${Buffer.from(JSON.stringify({ targetId: token.trim() })).toString("base64url")}`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.usageGeneration += 1;
    this.clearUsagePoll();
    this.unsubscribe();
    this.questions.clear();
    try { await this.options.runtime.close(); } finally { this.options.cleanup(); }
  }

  private onEvent(event: PiRuntimeEvent): void {
    if (this.closed) return;
    if (event.type === "process_exit") {
      if (this.turnId) this.finish(this.turnId, [], event.error);
      return;
    }
    if (event.type === "extension_ui_request") {
      if (event.method === "notify" && typeof event.message === "string") {
        const status = parseFastModeStatus(event.message);
        if (status) {
          const resolve = status.requestId ? this.fastModeQueries.get(status.requestId) : undefined;
          if (resolve) {
            this.fastModeQueries.delete(status.requestId!);
            resolve(status);
          }
          return;
        }
      }
      this.handleUi(event);
      return;
    }
    if (event.type === "agent_start" || event.type === "turn_start") {
      const shouldEmitStarted = !this.turnStarted;
      this.turnStarted = true;
      if (shouldEmitStarted && this.turnId) this.emit({ type: "session.turn", sessionId: this.options.sessionId, turnId: this.turnId, state: "started" });
      return;
    }
    if (event.type === "message_start" && event.message.role === "assistant") { this.assistantMessageId = event.message.responseId ?? randomUUID(); return; }
    if (event.type === "message_update") { this.handleUpdate(event); return; }
    if (event.type === "message_end") { this.handleMessageEnd(event); return; }
    if (event.type === "tool_execution_start") { const tracked = parseToolArgs(event.toolName, event.args); this.toolCalls.set(event.toolCallId, tracked); this.emitTool(event.toolCallId, tracked, "running", null, null); return; }
    if (event.type === "tool_execution_update") { const tracked = this.toolCalls.get(event.toolCallId); if (tracked) this.emitTool(event.toolCallId, tracked, "running", parseToolResult(event.partialResult), null); return; }
    if (event.type === "tool_execution_end") { const tracked = this.toolCalls.get(event.toolCallId) ?? parseToolArgs(event.toolName, null); this.toolCalls.delete(event.toolCallId); this.emitTool(event.toolCallId, tracked, event.isError ? "failed" : "completed", parseToolResult(event.result), event.isError ? event.result : null); this.emitUsage(); return; }
    if (event.type === "compaction_start") { this.handleCompactionEvent("loading", event.reason === "manual" ? "manual" : "auto"); return; }
    if (event.type === "compaction_end") { this.handleCompactionEvent("completed", event.reason === "manual" ? "manual" : "auto"); return; }
    if (event.type === "auto_retry_start") { this.timeline({ type: "error", id: randomUUID(), message: `Provider retry (attempt ${event.attempt}): ${event.errorMessage}` }); return; }
    if (event.type === "agent_end") {
      this.pendingTerminalMessages = event.messages ?? [];
      if (event.willRetry === undefined) this.finish(this.turnId, this.pendingTerminalMessages);
      return;
    }
    if (event.type === "agent_settled") this.finish(this.turnId, this.pendingTerminalMessages ?? []);
  }

  private async executeCompactCommand(clientMessageId: string, customInstructions: string | undefined): Promise<void> {
    if (this.manualCompactionCommand) {
      this.promptFailed(clientMessageId, "A Pi compact command is already running");
      return;
    }
    const command: ManualCompactionCommand = {
      clientMessageId,
      started: false,
      completed: false,
    };
    this.manualCompactionCommand = command;
    try {
      await this.options.runtime.compact(customInstructions);
      this.emit({
        type: "session.prompt_result",
        sessionId: this.options.sessionId,
        clientMessageId,
        result: { type: "completed" },
      });
    } catch (error) {
      if (this.manualCompactionCommand === command && command.started && !command.completed) {
        this.handleCompactionEvent("completed", "manual");
      }
      this.promptFailed(clientMessageId, `Failed to compact context: ${errorMessage(error)}`);
    } finally {
      if (this.manualCompactionCommand === command) {
        this.manualCompactionCommand = null;
      }
    }
  }

  private handleCompactionEvent(status: "loading" | "completed", trigger: "auto" | "manual"): void {
    const manualCommand = this.manualCompactionCommand;
    const activeCompaction = this.activeCompaction ?? {
      id: `compaction:${this.turnId ?? randomUUID()}`,
      trigger,
    };
    this.activeCompaction = activeCompaction;
    if (manualCommand && trigger === "manual") {
      if (status === "loading") manualCommand.started = true;
      if (status === "completed") manualCommand.completed = true;
    }
    this.timeline({
      type: "compaction",
      id: activeCompaction.id,
      status,
      trigger: activeCompaction.trigger,
    });
    if (status === "completed") {
      this.activeCompaction = null;
    }
  }

  private handleUpdate(event: Extract<PiAgentSessionEvent, { type: "message_update" }>): void {
    if (event.message && event.message.role !== "assistant") return;
    if (event.assistantMessageEvent.type === "text_delta") { this.assistantMessageId ??= event.message?.role === "assistant" ? event.message.responseId ?? randomUUID() : randomUUID(); this.timeline({ type: "assistant_message", id: this.assistantMessageId, messageId: this.assistantMessageId, text: event.assistantMessageEvent.delta ?? "" }); }
    if (event.assistantMessageEvent.type === "thinking_delta") this.timeline({ type: "reasoning", id: `${this.assistantMessageId ?? "thinking"}:reasoning`, text: event.assistantMessageEvent.delta ?? "" });
  }

  private handleMessageEnd(event: Extract<PiAgentSessionEvent, { type: "message_end" }>): void {
    if (event.message.role === "assistant") { this.assistantMessageId = null; this.emitUsage(); return; }
    if (event.message.role === "custom") { const text = messageText(event.message.content); if (text) this.timeline({ type: "assistant_message", id: randomUUID(), text }); }
  }

  private handleUi(event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>): void {
    if (event.method === "notify" && typeof event.message === "string") { this.timeline({ type: "notification", id: randomUUID(), level: event.notifyType === "error" || event.notifyType === "warning" ? event.notifyType : "info", message: event.message }); return; }
    if (!["select", "input", "editor", "confirm"].includes(event.method)) return;
    const title = [typeof event.title === "string" ? event.title : undefined, typeof event.message === "string" ? event.message : undefined].filter(Boolean).join("\n\n") || "Pi request";
    const options = event.method === "confirm" ? ["Yes", "No"] : Array.isArray(event.options) ? event.options.filter((value): value is string => typeof value === "string") : [];
    const request: ProviderPermissionRequest = { id: event.id, name: `Pi ${event.method}`, kind: "question", title, input: { questions: [{ question: title, header: RESPONSE_HEADER, options: options.map((label) => ({ label })), multiSelect: false, ...(typeof event.placeholder === "string" ? { placeholder: event.placeholder } : {}), ...(options.length === 0 ? { allowEmpty: true, dismissLabel: "Skip" } : {}) }] } };
    this.questions.set(event.id, { method: event.method });
    this.emit({ type: "session.permission", sessionId: this.options.sessionId, request });
  }

  private finish(turnId: string | null, messages: PiAgentMessage[], forcedError?: string, canceled = false): void {
    if (!turnId || this.turnId !== turnId) return;
    const error = forcedError ?? latestAssistantError(messages);
    this.turnId = null; this.clientMessageId = null; this.turnStarted = false; this.pendingTerminalMessages = null; this.assistantMessageId = null;
    this.usageGeneration += 1;
    this.clearUsagePoll();
    this.emit({ type: "session.turn", sessionId: this.options.sessionId, turnId, state: canceled ? "canceled" : error ? "failed" : "completed", ...(error && !canceled ? { error: { message: error } } : {}) });
    this.emitUsage(turnId);
  }

  private emitTool(id: string, tracked: PiTrackedToolCall, status: "running" | "completed" | "failed", result: ReturnType<typeof parseToolResult>, error: unknown): void { this.timeline({ type: "tool_call", id, callId: id, name: resolveToolCallName(tracked, result), detail: mapToolDetail(tracked, result), status, error: status === "failed" ? (error ?? "Tool failed") as never : null }); }
  private emitConfig(): void {
    const model = this.options.state.model;
    const currentThinking = model ? thinkingConfigForModel(model) : { thinkingOptions: [], defaultThinkingOptionId: undefined };
    const config: ProviderConfigState = {
      ...(model ? { model: `${model.provider}/${model.id}` } : {}),
      models: this.options.models.map((item) => {
        const thinking = thinkingConfigForModel(item);
        return {
          id: `${item.provider}/${item.id}`,
          label: item.name ?? `${item.provider}/${item.id}`,
          ...(item.contextWindow ? { contextWindowMaxTokens: item.contextWindow } : {}),
          ...(item.reasoning ? thinking : {}),
        };
      }),
      modes: PI_COMPATIBILITY_MODES,
      thinkingOption: this.options.state.thinkingLevel,
      thinkingOptions: currentThinking.thinkingOptions,
      settings: [
        {
          type: "select",
          id: AUTO_COMPACTION_SETTING,
          label: "Compact",
          description: "Compact long conversations automatically.",
          value: this.options.state.autoCompactionEnabled ? "on" : "off",
          options: [
            { label: "Compact: ✓", value: "on" },
            { label: "Compact: ×", value: "off" },
          ],
        },
        {
          type: "select",
          id: AUTO_RETRY_SETTING,
          label: "Retry",
          description: "Retry transient provider errors automatically.",
          value: this.autoRetryEnabled ? "on" : "off",
          options: [
            { label: "Retry: ✓", value: "on" },
            { label: "Retry: ×", value: "off" },
          ],
        },
        ...(this.fastModeAvailable ? [{
          type: "select" as const,
          id: FAST_MODE_SETTING,
          label: "Fast",
          description: "Use the provider's priority service tier when supported.",
          value: this.fastModeEnabled ? "on" : "off",
          options: [
            { label: "Fast: ✓", value: "on" },
            { label: "Fast: ×", value: "off" },
          ],
        }] : []),
      ],
    };
    this.emit({ type: "session.config", sessionId: this.options.sessionId, config });
  }
  private scheduleUsagePoll(generation: number, turnId: string): void {
    this.clearUsagePoll();
    this.usageTimer = setTimeout(() => {
      this.usageTimer = null;
      if (this.closed || this.usageGeneration !== generation || this.turnId !== turnId) return;
      this.emitUsage(turnId);
      this.scheduleUsagePoll(generation, turnId);
    }, 3_000);
  }
  private clearUsagePoll(): void {
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.usageTimer = null;
  }
  private emitUsage(turnId = this.turnId ?? undefined): void { void this.options.runtime.getSessionStats().then((stats) => { const usage: ProviderUsage = { inputTokens: stats.tokens?.input, cachedInputTokens: stats.tokens?.cacheRead, outputTokens: stats.tokens?.output, totalCostUsd: stats.cost, contextWindowMaxTokens: stats.contextUsage?.contextWindow ?? undefined, contextWindowUsedTokens: stats.contextUsage?.tokens ?? undefined }; this.emit({ type: "session.usage", sessionId: this.options.sessionId, ...(turnId ? { turnId } : {}), usage }); }).catch(() => undefined); }
  private async setFastMode(enabled: boolean): Promise<void> {
    await this.options.runtime.prompt(`/fast ${enabled ? "on" : "off"}`);
    this.applyFastModeStatus(await this.queryFastMode());
  }
  private async queryFastMode(): Promise<FastModeStatus> {
    const requestId = randomUUID();
    const status = new Promise<FastModeStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fastModeQueries.delete(requestId);
        reject(new Error("Timed out querying Pi GPT Fast mode"));
      }, FAST_MODE_QUERY_TIMEOUT_MS);
      this.fastModeQueries.set(requestId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    try {
      await this.options.runtime.prompt(`/fast-status ${requestId}`);
      return await status;
    } catch (error) {
      this.fastModeQueries.delete(requestId);
      throw error;
    }
  }
  private applyFastModeStatus(status: FastModeStatus | undefined): void {
    this.fastModeAvailable = Boolean(this.fastModeExtension && status?.supported);
    if (status) this.fastModeEnabled = status.enabled;
  }
  private timeline(item: ProviderTimelineItem): void { this.emit({ type: "timeline.item", sessionId: this.options.sessionId, item }); }
  private emit(event: ProviderEvent): void { if (!this.closed) this.options.emit(event); }
  private promptFailed(clientMessageId: string, message: string): void { this.emit({ type: "session.prompt_result", sessionId: this.options.sessionId, clientMessageId, result: { type: "failed", error: { message } } }); }
}

export function createPaseoExtension(systemPrompt?: string): { path: string; cleanup(): void } {
  const directory = mkdtempSync(join(tmpdir(), "paseo-pi-rpc-"));
  const path = join(directory, "paseo-bridge.mjs");
  const systemPromptHook = systemPrompt
    ? `pi.on("before_agent_start", async (event) => ({
  systemPrompt: event.systemPrompt + "\\n\\n" + ${JSON.stringify(systemPrompt)},
}));`
    : "";
  writeFileSync(
    path,
    `
function decodePayload(encoded) {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

export default function paseoIntegration(pi) {
  ${systemPromptHook}

  pi.registerCommand("paseo_tree", {
    description: "Internal Paseo tree navigation bridge",
    handler: async (args, ctx) => {
      const payload = decodePayload(args.trim());
      return await ctx.navigateTree(payload.targetId, { summarize: false });
    },
  });
}
`.trimStart(),
    { encoding: "utf8", mode: 0o600 },
  );
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function mergeCommands(commands: readonly ProviderCommand[]): ProviderCommand[] {
  const merged = new Map(BUILTIN_COMMANDS.map((command) => [command.name, { ...command }]));
  for (const command of commands) {
    const builtin = merged.get(command.name);
    merged.set(command.name, {
      ...command,
      ...(builtin?.argumentHint && !command.argumentHint ? { argumentHint: builtin.argumentHint } : {}),
    });
  }
  return [...merged.values()];
}

function hasExtensionCommand(commands: readonly { name: string; source: string }[], name: string): boolean {
  return commands.some((command) => command.name === name && command.source === "extension");
}

function getCompactArguments(prompt: ProviderPrompt, text: string): string | null {
  if (prompt.input.type === "command") {
    return prompt.input.name.toLowerCase() === "compact" ? prompt.input.arguments.trim() : null;
  }
  if (prompt.input.content.some((part) => part.type !== "text")) return null;
  const match = /^\/compact(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  return match ? match[1]?.trim() ?? "" : null;
}

function settingBoolean(
  settings: Readonly<Record<string, unknown>> | undefined,
  id: string,
): boolean | undefined {
  const value = settings?.[id];
  if (typeof value === "boolean") return value;
  if (value === "on") return true;
  if (value === "off") return false;
  return undefined;
}
function parseFastModeStatus(message: string): FastModeStatus | undefined {
  try {
    const value = JSON.parse(message) as Partial<FastModeStatus>;
    if (value.type !== "pi-gpt-fast-mode.status" || typeof value.enabled !== "boolean" || typeof value.model !== "string" || typeof value.supported !== "boolean") return undefined;
    return value as FastModeStatus;
  } catch {
    return undefined;
  }
}
function messageText(content: string | Array<{ type: string; text?: string }>): string { return typeof content === "string" ? content : content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text!).join("\n\n"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function latestAssistantError(messages: PiAgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.errorMessage?.trim()) return message.errorMessage;
  }
  return undefined;
}
