import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderCommand, ProviderConfigChanges, ProviderConfigState, ProviderEvent, ProviderPermissionRequest, ProviderPermissionResponse, ProviderPersistence, ProviderPrompt, ProviderSessionConfig, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

import type { PiAgentMessage, PiAgentSessionEvent, PiModel, PiRuntimeEvent, PiSessionEntry, PiSessionState } from "./rpc-types.js";
import type { PiRuntimeSession } from "./runtime.js";
import { PiImageMaterializer, PiImageValidationError, convertPromptImages } from "./image.js";
import { mapPiCatalogModel, normalizePiThinkingOption, thinkingConfigForModel } from "./thinking.js";
import { mapToolDetail, parseToolArgs, parseToolResult, resolveToolCallName, type PiTrackedToolCall } from "./tool-call-mapper.js";
import type { PiRuntimeSetting, PiRuntimeSettingId } from "../shared/runtime-settings.js";
import { PiHistoryMapper } from "./history-mapper.js";
import { PiUsagePoller, type PiUsagePollScheduler } from "./usage-poller.js";
import { PiStreamCoalescer } from "./stream-coalescer.js";
import type { PiScheduler } from "./scheduler.js";
import { PiSessionCompaction } from "./session-compaction.js";
import { PiPublicError } from "./bounds.js";
import { PiRevertTokens, isRevertToken, parseCapturedEntries, parseExtensionMarkerPayload, revertPiConversation, type PiCapturedEntry } from "./rewind.js";
import { checkTerminalKey, decideLegacyTerminal, shouldHonorNoTurnAck, type LegacyTerminalEvidence, type TurnTerminalSignal } from "./turn-terminal.js";
import { WjSubagents, isWjTool, wjToolDetail } from "./wj-subagents.js";

const DEFAULT_THINKING_LEVEL = "medium";
const RESPONSE_HEADER = "Response";
const AUTO_COMPACTION_SETTING = "autoCompaction";
const AUTO_RETRY_SETTING = "autoRetry";
const FAST_MODE_SETTING = "fastMode";
const FAST_MODE_COMMAND = "fast";
const FAST_MODE_STATUS_COMMAND = "fast-status";
const LONG_CONTEXT_SETTING = "longContext";
const LONG_CONTEXT_COMMAND = "long-context";
const LONG_CONTEXT_STATUS_COMMAND = "long-context-status";
const MICROGPT_PACKAGE_NAME = "@mcowger/pi-microgpt";
const MICROGPT_RESPONSE_TYPE = "pi-microgpt.response";
const MICROGPT_QUERY_TIMEOUT_MS = 5_000;
const PASEO_PI_TREE_EXTENSION_COMMAND = "paseo_tree";
const PASEO_PI_CAPTURE_EXTENSION_COMMAND = "paseo_capture_entries";
const PASEO_PI_ENTRY_CAPTURE_MARKER = "PASEO_ENTRY_CAPTURE";
const PASEO_PI_SUBMITTED_USER_ENTRY_MARKER = "PASEO_SUBMITTED_USER_ENTRY";
const PASEO_PI_COMMAND_RESULT_MARKER = "PASEO_COMMAND_RESULT";
const PASEO_PI_WJ_PROBE_COMMAND = "paseo_wj_probe";
const DEFAULT_EXTENSION_RESULT_TIMEOUT_MS = 30_000;
const MICROGPT_COMMANDS = [
  FAST_MODE_COMMAND,
  FAST_MODE_STATUS_COMMAND,
  LONG_CONTEXT_COMMAND,
  LONG_CONTEXT_STATUS_COMMAND,
] as const;
const BUILTIN_COMMANDS: readonly ProviderCommand[] = [
  {
    name: "compact",
    description: "Manually compact the session context",
    argumentHint: "[instructions]",
  },
  {
    name: "autocompact",
    description: "Toggle automatic context compaction",
    argumentHint: "[on|off|toggle]",
  },
];

export interface PiProviderSessionOptions {
  sessionId: string;
  config: ProviderSessionConfig;
  runtime: PiRuntimeSession;
  state: PiSessionState;
  models: PiModel[];
  extensionTimeoutMs?: number;
  usagePollScheduler?: PiUsagePollScheduler;
  streamScheduler?: PiScheduler;
  // Per-session nonce baked into the bridge extension source by
  // `createPaseoExtension(..., { nonce })`. When set, extension markers
  // carrying any other nonce are swallowed instead of minting revert
  // tokens, recording captures, or resolving command results.
  extensionNonce?: string;
  emit(event: ProviderEvent): void;
  cleanup(): void;
}

interface PendingQuestion { method: string; }

interface PendingExtensionResult {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingEarlyTerminal {
  kind: "agent_end" | "agent_settled";
  requestId: string | undefined;
  messages: PiAgentMessage[];
  willRetry?: boolean;
}


interface MicroGptStatus {
  type: "pi-microgpt.response";
  command: typeof FAST_MODE_COMMAND | typeof LONG_CONTEXT_COMMAND;
  success: boolean;
  requestId?: string;
  enabled: boolean;
  supported: boolean;
  provider?: string;
  model?: string;
  contextWindow?: number;
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
  private readonly compaction: PiSessionCompaction;
  private microgptExtension = false;
  private fastModeAvailable = false;
  private fastModeEnabled = false;
  private readonly fastModeQueries = new Map<string, (status: MicroGptStatus) => void>();
  private longContextAvailable = false;
  private longContextEnabled = false;
  private readonly longContextQueries = new Map<string, (status: MicroGptStatus) => void>();
  private readonly usagePoller: PiUsagePoller;
  private readonly streamer: PiStreamCoalescer;
  private flushingCoalescer = false;
  private closed = false;
  private readonly images = new PiImageMaterializer();
  private turnImagePaths: string[] = [];
  private readonly capturedUserEntries: PiCapturedEntry[] = [];
  private readonly capturedUserEntriesById = new Map<string, PiCapturedEntry>();
  private readonly pendingExtensionResults = new Map<string, PendingExtensionResult>();
  private readonly revertTokens = new PiRevertTokens();
  private readonly extensionTimeoutMs: number;
  private activePromptRequestId: string | null = null;
  private readonly pendingPromptResults = new Map<string, boolean>();
  private pendingEarlyTerminal: PendingEarlyTerminal | null = null;
  private turnCapturedEntryFresh = false;
  private turnNativeActivity = false;
  private steerInFlight = false;
  private wjSubagents: WjSubagents | null = null;

  constructor(private readonly options: PiProviderSessionOptions) {
    this.autoRetryEnabled = settingBoolean(options.config.settings, AUTO_RETRY_SETTING) ?? false;
    this.extensionTimeoutMs = options.extensionTimeoutMs ?? DEFAULT_EXTENSION_RESULT_TIMEOUT_MS;
    this.usagePoller = new PiUsagePoller({
      scheduler: options.usagePollScheduler,
      readStats: () => this.options.runtime.getSessionStats(),
      onUsage: (usage, turnId) => {
        this.emit({
          type: "session.usage",
          sessionId: this.options.sessionId,
          ...(turnId === undefined ? {} : { turnId }),
          usage,
        });
      },
      // Upstream logs poll failures at debug level and keeps polling; the
      // plugin has no server log here, so failures stay silent and the
      // periodic poll continues on the next tick.
      onPollError: () => undefined,
    });
    // NG item 9: live text/reasoning deltas coalesce behind the shared
    // scheduler seam; item 4 replay calls `timeline` directly and stays
    // synchronous/uncoalesced.
    this.streamer = new PiStreamCoalescer({
      scheduler: options.streamScheduler,
      emit: (item) => this.timeline(item),
    });
    this.compaction = new PiSessionCompaction({
      timeline: (item) => this.timeline(item),
      refreshUsage: () => this.refreshUsageSnapshot(),
    });
    this.unsubscribe = options.runtime.onEvent((event) => this.onEvent(event));
  }

  get persistence(): ProviderPersistence {
    return {
      version: 1,
      data: {
        bridgeSessionId: this.options.sessionId,
        sessionFile: this.options.state.sessionFile ?? null,
        cwd: this.options.config.cwd,
      },
    };
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
    if (commands.some((command) => command.name === "agents" && command.source === "extension")) {
      try {
        const result = await this.runWjProbe();
        if (WjSubagents.isAvailable(result)) {
          this.wjSubagents = new WjSubagents(this.options.sessionId, this.options.config.cwd, (event) => this.emit(event));
        }
      } catch {
        // A missing or incompatible extension never changes regular Pi sessions.
      }
    }
    this.microgptExtension = hasMicroGptCommands(commands);
    if (this.microgptExtension) {
      this.applyFastModeStatus(await this.queryFastMode().catch(() => undefined));
      const configuredFastMode = settingBoolean(this.options.config.settings, FAST_MODE_SETTING);
      if (this.fastModeAvailable && configuredFastMode !== undefined) await this.setFastMode(configuredFastMode);
      await this.applyLongContextStatus(await this.queryLongContext().catch(() => undefined));
      const configuredLongContext = settingBoolean(this.options.config.settings, LONG_CONTEXT_SETTING);
      if (this.longContextAvailable && configuredLongContext !== undefined && configuredLongContext !== this.longContextEnabled) {
        await this.setLongContext(configuredLongContext);
      }
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
    // NG item 9 replay transition: flush pending live frames synchronously
    // so coalesced streaming never interleaves with synchronous replay.
    // Item 4 replay stays synchronous/uncoalesced below.
    this.streamer.flushSync();
    try {
      await this.requestEntryCapture("history");
    } catch {
      // A capture timeout (or a Pi build without the bridge extension)
      // must not blank history: replay proceeds without entry linkage,
      // and no revert tokens are minted for unlinked rows.
      this.recordCapturedUserEntries([]);
    }
    const messages = await this.options.runtime.getMessages();
    // `capturedUserEntries` is the full branch entry list while
    // `getMessages()` is the agent-visible list; the two diverge after
    // compaction (messages collapsed into a summary) or when internal
    // capture prompts are not recorded as entries. Positional linkage is
    // only sound when the counts align, so a mismatch replays history
    // without revert tokens rather than pointing rewind at wrong entries.
    const userMessageCount = messages.filter((message) => message.role === "user").length;
    const captured = userMessageCount === this.capturedUserEntries.length
      ? this.capturedUserEntries
      : [];
    // The mapper runs to completion before the first timeline emission, so a
    // budget breach throws with nothing emitted: all-or-nothing history.
    const mapper = new PiHistoryMapper("pi", captured, {
      mintRevertToken: (entryId) => this.revertTokens.mint(entryId),
      mapToolDetail: (tracked, result) => this.mapTrackedTool(tracked, result),
      mapCustomMessage: (_text, customType) => this.wjSubagents && customType?.startsWith("wj-pi-subagents-") && customType !== "wj-pi-subagents-activity" ? false : null,
    });
    const items = mapper.mapMessages(messages);
    if (this.wjSubagents) {
      for (const message of messages) {
        if (message.role === "custom" && message.customType !== "wj-pi-subagents-activity") this.wjSubagents.custom(message.customType, message.content);
        if (message.role === "assistant") for (const block of message.content) {
          if (block.type === "toolCall") this.wjSubagents.rootToolStart(block.id, block.name, block.arguments);
        }
        if (message.role === "toolResult") this.wjSubagents.rootToolEnd(message.toolCallId, message.toolName, { content: message.content, details: message.details });
      }
      const history = await this.options.runtime.getEntries().catch(() => ({ entries: [] as PiSessionEntry[], leafId: null }));
      const byId = new Map(history.entries.map((entry) => [entry.id, entry]));
      const activeIds = new Set<string>();
      let cursor = history.leafId;
      while (cursor && !activeIds.has(cursor)) {
        activeIds.add(cursor);
        cursor = byId.get(cursor)?.parentId ?? null;
      }
      for (const entry of history.entries) {
        if (activeIds.has(entry.id)) this.wjSubagents.activityEntry(entry);
      }
    }
    for (const item of items) this.timeline(item);
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.closed) return this.promptFailed(prompt.clientMessageId, "Pi session is closed");
    const rawText = prompt.input.type === "command" ? `/${prompt.input.name}${prompt.input.arguments ? ` ${prompt.input.arguments}` : ""}` : prompt.input.content.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n\n");
    const rawImages = prompt.input.type === "message" ? prompt.input.content.filter((part): part is Extract<typeof part, { type: "image" }> => part.type === "image") : [];
    const compactArguments = getCompactArguments(prompt, rawText);
    if (compactArguments !== null) {
      await this.executeCompactCommand(prompt.clientMessageId, compactArguments);
      return;
    }
    const autoCompactArguments = getAutoCompactArguments(prompt, rawText);
    if (autoCompactArguments !== null) {
      await this.executeAutoCompactCommand(prompt.clientMessageId, autoCompactArguments);
      return;
    }
    const textParts = prompt.input.type === "command" ? [rawText] : prompt.input.content.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text);
    let converted: { text: string; images: { type: "image"; data: string; mimeType: string }[]; materializedPaths: string[] };
    try {
      converted = convertPromptImages(textParts, rawImages, { model: this.options.state.model ?? undefined, materializer: this.images });
    } catch (error) {
      return this.promptFailed(prompt.clientMessageId, error instanceof PiImageValidationError ? error.message : errorMessage(error));
    }
    const text = prompt.input.type === "command" ? rawText : converted.text;
    const images = prompt.input.type === "command" ? [] : converted.images;
    if (prompt.delivery === "steer" && this.turnId && !text.startsWith("/")) {
      if (converted.materializedPaths.length > 0) this.turnImagePaths.push(...converted.materializedPaths);
      this.steerInFlight = true;
      try {
        await this.options.runtime.steer(text, images);
        this.emit({ type: "session.prompt_result", sessionId: this.options.sessionId, clientMessageId: prompt.clientMessageId, result: { type: "steer", turnId: this.turnId } });
      } catch (error) {
        this.images.release(converted.materializedPaths);
        this.turnImagePaths = this.turnImagePaths.filter((path) => !converted.materializedPaths.includes(path));
        this.promptFailed(prompt.clientMessageId, errorMessage(error));
      } finally {
        this.steerInFlight = false;
      }
      return;
    }
    if (this.turnId) {
      this.images.release(converted.materializedPaths);
      return this.promptFailed(prompt.clientMessageId, "A Pi turn is already active");
    }
    const turnId = randomUUID();
    this.turnId = turnId;
    this.turnImagePaths = converted.materializedPaths;
    this.usagePoller.startTurn();
    this.streamer.nextTurn();
    this.clientMessageId = prompt.clientMessageId;
    this.turnStarted = false;
    this.pendingTerminalMessages = null;
    this.activePromptRequestId = null;
    this.pendingEarlyTerminal = null;
    this.turnCapturedEntryFresh = false;
    this.turnNativeActivity = false;
    this.emit({ type: "session.prompt_result", sessionId: this.options.sessionId, clientMessageId: prompt.clientMessageId, result: { type: "turn", turnId } });
    try {
      const ack = await this.options.runtime.prompt(text, images);
      if (this.turnId !== turnId) { this.images.release(converted.materializedPaths); return; }
      // Upstream `startTurn` ack correlation (`agent.ts` ~1344): a
      // `prompt_result` event may arrive before the ack resolves.
      this.activePromptRequestId = ack.requestId ?? null;
      const correlatedResult = ack.requestId ? this.pendingPromptResults.get(ack.requestId) : undefined;
      if (ack.requestId) this.pendingPromptResults.delete(ack.requestId);
      const agentInvoked = correlatedResult ?? ack.agentInvoked;
      if (agentInvoked === false) {
        // Local-only no-turn completion, unless the runtime already showed
        // contradictory native activity (NG item 7).
        if (shouldHonorNoTurnAck(this.turnNativeActivity)) this.finish(turnId, []);
      }
      this.drainEarlyTerminal(turnId);
    } catch (error) {
      if (this.turnId !== turnId) { this.images.release(converted.materializedPaths); return; }
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
      if (!provider || !modelId) throw new PiPublicError("Pi model id must include a provider");
      await this.options.runtime.setModel(provider, modelId);
      this.options.state = await this.options.runtime.getState();
      this.options.config.model = changes.model;
      this.options.config.thinkingOption = this.options.state.thinkingLevel;
    }
    if (changes.thinkingOption !== undefined) {
      const level = normalizePiThinkingOption(changes.thinkingOption) ?? DEFAULT_THINKING_LEVEL;
      await this.options.runtime.setThinkingLevel(level);
      this.options.state = await this.options.runtime.getState();
      this.options.config.thinkingOption = this.options.state.thinkingLevel;
    }
    if (changes.model && this.microgptExtension) {
      this.applyFastModeStatus(await this.queryFastMode().catch(() => undefined));
      await this.applyLongContextStatus(await this.queryLongContext().catch(() => undefined));
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
    const longContext = settingBoolean(changes.settings, LONG_CONTEXT_SETTING);
    if (longContext !== undefined && this.longContextAvailable && longContext !== this.longContextEnabled) await this.setLongContext(longContext);
    this.emitConfig();
  }

  getRuntimeSettings(): PiRuntimeSetting[] {
    return [
      {
        id: AUTO_COMPACTION_SETTING,
        label: "Compact",
        description: "Compact long conversations automatically.",
        value: Boolean(this.options.state.autoCompactionEnabled),
      },
      {
        id: AUTO_RETRY_SETTING,
        label: "Retry",
        description: "Retry transient provider errors automatically.",
        value: this.autoRetryEnabled,
      },
      ...(this.fastModeAvailable ? [{
        id: FAST_MODE_SETTING,
        label: "Fast",
        description: "Use the provider's priority service tier when supported.",
        value: this.fastModeEnabled,
      } satisfies PiRuntimeSetting] : []),
      ...(this.longContextAvailable ? [{
        id: LONG_CONTEXT_SETTING,
        label: "Long context",
        description: "Use the larger context window for supported OpenAI models. Higher usage rates may apply.",
        value: this.longContextEnabled,
      } satisfies PiRuntimeSetting] : []),
    ];
  }

  async updateRuntimeSetting(id: PiRuntimeSettingId, value: boolean): Promise<PiRuntimeSetting[]> {
    if (id === AUTO_COMPACTION_SETTING) {
      await this.options.runtime.setAutoCompaction(value);
      this.options.state.autoCompactionEnabled = value;
    } else if (id === AUTO_RETRY_SETTING) {
      await this.options.runtime.setAutoRetry(value);
      this.autoRetryEnabled = value;
    } else if (id === FAST_MODE_SETTING) {
      if (!this.fastModeAvailable) throw new PiPublicError("Fast mode is not available for this model");
      await this.setFastMode(value);
    } else if (id === LONG_CONTEXT_SETTING) {
      if (!this.longContextAvailable) throw new PiPublicError("Long context is not available for this model");
      if (value !== this.longContextEnabled) await this.setLongContext(value);
    }
    this.emitConfig();
    return this.getRuntimeSettings();
  }

  respondToPermission(id: string, response: ProviderPermissionResponse): void {
    const question = this.questions.get(id);
    if (!question) throw new PiPublicError(`No pending permission request with id '${id}'`);
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
    if (this.turnId) throw new PiPublicError("Cannot rewind the Pi conversation while a turn is active");
    if (!isRevertToken(token)) throw new PiPublicError("Pi rewind token is malformed");
    const entryId = this.revertTokens.resolve(token);
    if (!entryId) throw new PiPublicError("Pi rewind token is unknown or stale");
    await this.requestEntryCapture("rewind");
    const target = this.capturedUserEntriesById.get(entryId);
    if (!target) throw new PiPublicError("Pi rewind target was not found in captured tree entries");
    await revertPiConversation({
      entryId,
      navigator: { navigateTree: (treeEntryId) => this.runPiTreeExtensionCommand(treeEntryId) },
    });
    this.revertTokens.clear();
    this.toolCalls.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.rejectAllExtensionResults(new Error("Pi session closed"));
    // NG item 9 close boundary: flush pending frames while emit still works.
    this.streamer.flushSync();
    this.wjSubagents?.close();
    this.closed = true;
    this.streamer.close();
    this.usagePoller.close();
    this.images.clear();
    this.turnImagePaths = [];
    this.unsubscribe();
    this.questions.clear();
    this.pendingPromptResults.clear();
    this.pendingEarlyTerminal = null;
    try { await this.options.runtime.close(); } finally { this.options.cleanup(); }
  }

  private onEvent(event: PiRuntimeEvent): void {
    if (this.closed) return;
    if (event.type === "process_exit") {
      this.rejectAllExtensionResults(new Error(event.error));
      if (this.turnId) this.finish(this.turnId, [], event.error);
      return;
    }
    if (event.type === "extension_ui_request") {
      if (event.method === "notify" && typeof event.message === "string") {
        const status = parseMicroGptStatus(event.message);
        if (status?.command === FAST_MODE_COMMAND) {
          const resolve = status.requestId ? this.fastModeQueries.get(status.requestId) : undefined;
          if (resolve) {
            this.fastModeQueries.delete(status.requestId!);
            resolve(status);
          }
          return;
        }
        if (status?.command === LONG_CONTEXT_COMMAND) {
          const resolve = status.requestId ? this.longContextQueries.get(status.requestId) : undefined;
          if (resolve) {
            this.longContextQueries.delete(status.requestId!);
            resolve(status);
          }
          return;
        }
      }
      this.handleUi(event);
      return;
    }
    if (event.type === "prompt_result") {
      this.handlePromptResultEvent(event.id, event.agentInvoked);
      return;
    }
    if (event.type === "entry_appended") {
      this.wjSubagents?.activityEntry(event.entry);
      return;
    }
    if (event.type === "agent_start" || event.type === "turn_start") {
      if (this.turnId) this.turnNativeActivity = true;
      const shouldEmitStarted = !this.turnStarted;
      this.turnStarted = true;
      if (shouldEmitStarted && this.turnId) this.emit({ type: "session.turn", sessionId: this.options.sessionId, turnId: this.turnId, state: "started" });
      return;
    }
    if (event.type === "message_start" && event.message.role === "assistant") { if (this.turnId) this.turnNativeActivity = true; this.assistantMessageId = event.message.responseId ?? randomUUID(); return; }
    if (event.type === "message_update") { this.handleUpdate(event); return; }
    if (event.type === "message_end") { this.handleMessageEnd(event); return; }
    if (event.type === "tool_execution_start") { if (this.turnId) this.turnNativeActivity = true; const tracked = parseToolArgs(event.toolName, event.args); this.toolCalls.set(event.toolCallId, tracked); this.wjSubagents?.rootToolStart(event.toolCallId, event.toolName, event.args); this.emitTool(event.toolCallId, tracked, "running", null, null); return; }
    if (event.type === "tool_execution_update") { if (this.turnId) this.turnNativeActivity = true; const tracked = this.toolCalls.get(event.toolCallId); if (tracked) this.emitTool(event.toolCallId, tracked, "running", parseToolResult(event.partialResult), null); return; }
    if (event.type === "tool_execution_end") { if (this.turnId) this.turnNativeActivity = true; const tracked = this.toolCalls.get(event.toolCallId) ?? parseToolArgs(event.toolName, null); this.toolCalls.delete(event.toolCallId); this.wjSubagents?.rootToolEnd(event.toolCallId, event.toolName, event.result); this.emitTool(event.toolCallId, tracked, event.isError ? "failed" : "completed", parseToolResult(event.result), event.isError ? event.result : null); void this.usagePoller.refreshNow(); return; }
    if (event.type === "compaction_start") { this.handleCompactionEvent("loading", event.reason === "manual" ? "manual" : "auto"); return; }
    if (event.type === "compaction_end") { this.handleCompactionEvent("completed", event.reason === "manual" ? "manual" : "auto"); return; }
    if (event.type === "auto_retry_start") { this.timeline({ type: "error", id: randomUUID(), message: `Provider retry (attempt ${event.attempt}): ${event.errorMessage}` }); return; }
    if (event.type === "agent_end") {
      this.handleAgentEnd({ type: "agent_end", requestId: event.requestId }, event.messages ?? [], event.willRetry);
      return;
    }
    if (event.type === "agent_settled") {
      this.handleAgentSettled(event.requestId);
      return;
    }
  }

  private async executeCompactCommand(clientMessageId: string, customInstructions: string | undefined): Promise<void> {
    if (this.compaction.isManualActive()) {
      this.promptFailed(clientMessageId, "A Pi compact command is already running");
      return;
    }
    this.compaction.beginManual(clientMessageId);
    try {
      await this.options.runtime.compact(customInstructions);
      this.compaction.recordOutcome("completed");
      this.emit({
        type: "session.prompt_result",
        sessionId: this.options.sessionId,
        clientMessageId,
        result: { type: "completed" },
      });
    } catch (error) {
      this.compaction.completeManualAfterFailure();
      this.promptFailed(clientMessageId, `Failed to compact context: ${errorMessage(error)}`);
    } finally {
      this.compaction.endManual();
    }
  }

  private async executeAutoCompactCommand(clientMessageId: string, mode: string | undefined): Promise<void> {
    const result = await this.compaction.runAutoCompact(mode, this.options.runtime);
    if (result.ok) {
      this.options.state.autoCompactionEnabled = result.enabled;
      this.timeline({ type: "assistant_message", id: randomUUID(), text: result.message });
      this.emit({
        type: "session.prompt_result",
        sessionId: this.options.sessionId,
        clientMessageId,
        result: { type: "completed" },
      });
      return;
    }
    // Failure surfaces once via `prompt_result`; the timeline keeps only
    // the success message so invalid input is not rendered twice.
    this.promptFailed(clientMessageId, result.message);
  }

  private handleCompactionEvent(status: "loading" | "completed", trigger: "auto" | "manual"): void {
    this.compaction.handleEvent(status, trigger);
  }

  private handlePromptResultEvent(id: unknown, agentInvoked: unknown): void {
    // Port of upstream `prompt_result` buffering (`agent.ts` ~2141): the
    // event may arrive before the prompt ack resolves the active request id.
    const requestId = typeof id === "string" ? id : undefined;
    const invoked = typeof agentInvoked === "boolean" ? agentInvoked : undefined;
    if (!requestId || invoked === undefined || !this.turnId) return;
    if (requestId === this.activePromptRequestId && invoked === false) {
      if (shouldHonorNoTurnAck(this.turnNativeActivity)) this.finish(this.turnId, []);
    } else if (this.activePromptRequestId === null) {
      this.pendingPromptResults.set(requestId, invoked);
    }
  }

  private handleAgentEnd(signal: TurnTerminalSignal, messages: PiAgentMessage[], willRetry: boolean | undefined): void {
    const turnId = this.turnId;
    if (!turnId) return;
    switch (checkTerminalKey(signal.requestId, this.activePromptRequestId)) {
      case "mismatch":
        return;
      case "ack-pending":
        this.pendingEarlyTerminal = { kind: "agent_end", requestId: signal.requestId, messages, willRetry };
        return;
      case "match":
      case "unkeyed":
        break;
    }
    if (willRetry !== undefined) {
      this.pendingTerminalMessages = messages;
      return;
    }
    if (signal.requestId !== undefined) {
      // Keyed match: authoritative terminal.
      this.finish(turnId, messages);
      return;
    }
    // Legacy fallback for binaries omitting requestId (NG item 7).
    void this.finishLegacyTerminal(turnId, messages);
  }

  private handleAgentSettled(requestId: string | undefined): void {
    const turnId = this.turnId;
    if (!turnId) return;
    switch (checkTerminalKey(requestId, this.activePromptRequestId)) {
      case "mismatch":
        return;
      case "ack-pending":
        // An `agent_end` buffered while the ack was pending may carry the
        // only failure payload (`messages`/`willRetry`); a following
        // `agent_settled` must not discard it. Stash it where the settled
        // drain looks (`pendingTerminalMessages`) before overwriting.
        if (this.pendingEarlyTerminal?.kind === "agent_end"
          && this.pendingEarlyTerminal.messages.length > 0
          && this.pendingTerminalMessages === null) {
          this.pendingTerminalMessages = this.pendingEarlyTerminal.messages;
        }
        this.pendingEarlyTerminal = { kind: "agent_settled", requestId, messages: [] };
        return;
      case "match":
      case "unkeyed":
        break;
    }
    if (this.pendingTerminalMessages !== null) {
      this.finish(turnId, this.pendingTerminalMessages);
      return;
    }
    if (requestId !== undefined) {
      // Keyed settled with no buffered retry payload: authoritative terminal.
      this.finish(turnId, []);
      return;
    }
    void this.finishLegacyTerminal(turnId, []);
  }

  private async finishLegacyTerminal(turnId: string, messages: PiAgentMessage[]): Promise<void> {
    const evidence = await this.readTerminalEvidence();
    if (this.turnId !== turnId) return;
    const decision = decideLegacyTerminal(evidence);
    if (decision.kind === "ignore") return;
    if (decision.kind === "failTurn") {
      // Confirmed-idle ambiguity: fail only the Paseo turn; the process
      // stays alive for the next prompt.
      this.finish(turnId, messages, "Pi turn ended without a correlated terminal event");
      return;
    }
    this.finish(turnId, messages);
  }

  private async readTerminalEvidence(): Promise<LegacyTerminalEvidence> {
    let runtimeIdle = false;
    let runtimeCompacting = true;
    try {
      const runtimeState = await this.options.runtime.getState();
      runtimeIdle = !runtimeState.isStreaming;
      runtimeCompacting = runtimeState.isCompacting;
    } catch {
      // Fail closed: an unreadable runtime looks busy, so ambiguous
      // terminals are ignored instead of ending the turn.
    }
    return {
      hasFreshCapturedEntry: this.turnCapturedEntryFresh,
      hasCurrentTurnActivity: this.turnNativeActivity,
      runtimeIdle,
      runtimeCompacting,
      hasConflictingWork: this.hasConflictingTurnWork(),
    };
  }

  private hasConflictingTurnWork(): boolean {
    return this.questions.size > 0
      || this.toolCalls.size > 0
      || this.steerInFlight
      || this.pendingExtensionResults.size > 0
      || this.compaction.isManualActive()
      || this.compaction.activeCompaction !== null;
  }

  private drainEarlyTerminal(turnId: string): void {
    const buffered = this.pendingEarlyTerminal;
    this.pendingEarlyTerminal = null;
    if (!buffered || this.turnId !== turnId) return;
    if (buffered.kind === "agent_end") {
      this.handleAgentEnd({ type: "agent_end", requestId: buffered.requestId }, buffered.messages, buffered.willRetry);
    } else {
      this.handleAgentSettled(buffered.requestId);
    }
  }

  private handleUpdate(event: Extract<PiAgentSessionEvent, { type: "message_update" }>): void {
    if (event.message && event.message.role !== "assistant") return;
    if (this.turnId) this.turnNativeActivity = true;
    // NG item 9: live deltas accumulate behind the scheduler seam and flush
    // as one cumulative snapshot per ~32ms frame with stable ids.
    if (event.assistantMessageEvent.type === "text_delta") { this.assistantMessageId ??= event.message?.role === "assistant" ? event.message.responseId ?? randomUUID() : randomUUID(); this.streamer.appendAssistantText(this.assistantMessageId, event.assistantMessageEvent.delta ?? "", this.assistantMessageId); }
    if (event.assistantMessageEvent.type === "thinking_delta") this.streamer.appendReasoning(`${this.assistantMessageId ?? "thinking"}:reasoning`, event.assistantMessageEvent.delta ?? "");
  }

  private handleMessageEnd(event: Extract<PiAgentSessionEvent, { type: "message_end" }>): void {
    if (this.turnId) this.turnNativeActivity = true;
    // NG item 9 flush boundary: no final character waits for a frame.
    this.streamer.flushSync();
    if (event.message.role === "assistant") { this.assistantMessageId = null; void this.usagePoller.refreshNow(); return; }
    if (event.message.role === "custom") {
      if (this.wjSubagents?.custom(event.message.customType, event.message.content)) return;
      const text = messageText(event.message.content);
      if (text) this.timeline({ type: "assistant_message", id: randomUUID(), text });
    }
  }

  private async requestEntryCapture(reason: string): Promise<void> {
    const requestId = randomUUID();
    const resultPromise = this.waitForExtensionResult(requestId);
    const payload = Buffer.from(JSON.stringify({ requestId, reason })).toString("base64url");
    try {
      await this.options.runtime.prompt(`/${PASEO_PI_CAPTURE_EXTENSION_COMMAND} ${payload}`);
    } catch (error) {
      // The send failed, so `await resultPromise` below is never reached:
      // reject the pending entry now (or its timer fires later), and mark
      // the abandoned waiter handled so neither rejection is unhandled.
      resultPromise.catch(() => undefined);
      this.rejectExtensionResult(requestId, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    await resultPromise;
  }

  private async runWjProbe(): Promise<unknown> {
    const requestId = randomUUID();
    const resultPromise = this.waitForExtensionResult(requestId);
    try {
      await this.options.runtime.prompt(`/${PASEO_PI_WJ_PROBE_COMMAND} ${requestId}`);
      return await resultPromise;
    } catch (error) {
      resultPromise.catch(() => undefined);
      this.rejectExtensionResult(requestId, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async runPiTreeExtensionCommand(targetId: string): Promise<unknown> {
    const requestId = randomUUID();
    const resultPromise = this.waitForExtensionResult(requestId);
    const payload = Buffer.from(JSON.stringify({ targetId, requestId })).toString("base64url");
    try {
      await this.options.runtime.prompt(`/${PASEO_PI_TREE_EXTENSION_COMMAND} ${payload}`);
    } catch (error) {
      resultPromise.catch(() => undefined);
      this.rejectExtensionResult(requestId, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    return await resultPromise;
  }

  private waitForExtensionResult(requestId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExtensionResults.delete(requestId);
        reject(new Error(`Pi extension result timed out for request ${requestId}`));
      }, this.extensionTimeoutMs);
      this.pendingExtensionResults.set(requestId, { resolve, reject, timer });
    });
  }

  private resolveExtensionResult(requestId: string, result: unknown): void {
    const pending = this.pendingExtensionResults.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingExtensionResults.delete(requestId);
    pending.resolve(result);
  }

  private rejectExtensionResult(requestId: string, error: Error): void {
    const pending = this.pendingExtensionResults.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingExtensionResults.delete(requestId);
    pending.reject(error);
  }

  private rejectAllExtensionResults(error: Error): void {
    for (const requestId of this.pendingExtensionResults.keys()) {
      this.rejectExtensionResult(requestId, error);
    }
  }

  private recordCapturedUserEntries(entries: PiCapturedEntry[]): void {
    this.capturedUserEntries.splice(0, this.capturedUserEntries.length, ...entries);
    this.capturedUserEntriesById.clear();
    for (const entry of entries) {
      this.capturedUserEntriesById.set(entry.id, entry);
    }
  }

  private handleSubmittedUserEntryMarker(message: string): boolean {
    const payload = parseExtensionMarkerPayload(message, PASEO_PI_SUBMITTED_USER_ENTRY_MARKER);
    if (!payload) return false;
    if (!this.isLiveExtensionMarker(payload)) return true;
    const [entry] = parseCapturedEntries([payload.entry]);
    if (!entry) return true;
    this.recordCapturedEntry(entry);
    this.timeline({
      type: "user_message",
      id: randomUUID(),
      messageId: entry.id,
      text: entry.text,
      revertToken: this.revertTokens.mint(entry.id),
      ...(this.clientMessageId ? { clientMessageId: this.clientMessageId } : {}),
    });
    return true;
  }

  private recordCapturedEntry(entry: PiCapturedEntry): void {
    if (this.turnId) this.turnCapturedEntryFresh = true;
    const existing = this.capturedUserEntriesById.get(entry.id);
    if (existing) {
      existing.text = entry.text;
      existing.parentId = entry.parentId;
      return;
    }
    this.capturedUserEntries.push(entry);
    this.capturedUserEntriesById.set(entry.id, entry);
  }

  private handleEntryCaptureMarker(message: string): boolean {
    const payload = parseExtensionMarkerPayload(message, PASEO_PI_ENTRY_CAPTURE_MARKER);
    if (!payload) return false;
    if (!this.isLiveExtensionMarker(payload)) return true;
    const entries = parseCapturedEntries(payload.entries);
    this.recordCapturedUserEntries(entries);
    if (typeof payload.requestId === "string") {
      this.resolveExtensionResult(payload.requestId, entries);
    }
    return true;
  }

  private handleCommandResultMarker(message: string): boolean {
    const payload = parseExtensionMarkerPayload(message, PASEO_PI_COMMAND_RESULT_MARKER);
    if (!payload) return false;
    if (!this.isLiveExtensionMarker(payload)) return true;
    if (typeof payload.requestId !== "string") return true;
    if (payload.ok === true) {
      this.resolveExtensionResult(payload.requestId, payload.result);
      return true;
    }
    const error = typeof payload.error === "string" ? payload.error : "Pi extension command failed";
    this.rejectExtensionResult(payload.requestId, new Error(error));
    return true;
  }

  // Per-session nonce baked into the bridge extension source (see
  // `createPaseoExtension(..., { nonce })`). Markers from any other
  // extension, tool output routed through `ui.notify`, or replayed text
  // carry a missing/wrong nonce and are swallowed: they must not mint
  // revert tokens, record captures, or resolve command results. Sessions
  // constructed without a nonce (tests) accept all markers.
  private isLiveExtensionMarker(payload: Record<string, unknown>): boolean {
    return this.options.extensionNonce === undefined || payload.nonce === this.options.extensionNonce;
  }

  private handleUi(event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>): void {
    if (event.method === "notify" && typeof event.message === "string") {
      if (
        this.handleSubmittedUserEntryMarker(event.message)
        || this.handleEntryCaptureMarker(event.message)
        || this.handleCommandResultMarker(event.message)
      ) return;
      this.timeline({ type: "notification", id: randomUUID(), level: event.notifyType === "error" || event.notifyType === "warning" ? event.notifyType : "info", message: event.message }); return;
    }
    if (!["select", "input", "editor", "confirm"].includes(event.method)) return;
    const title = [typeof event.title === "string" ? event.title : undefined, typeof event.message === "string" ? event.message : undefined].filter(Boolean).join("\n\n") || "Pi request";
    const options = event.method === "confirm" ? ["Yes", "No"] : Array.isArray(event.options) ? event.options.filter((value): value is string => typeof value === "string") : [];
    const request: ProviderPermissionRequest = { id: event.id, name: `Pi ${event.method}`, kind: "question", title, input: { questions: [{ question: title, header: RESPONSE_HEADER, options: options.map((label) => ({ label })), multiSelect: false, ...(typeof event.placeholder === "string" ? { placeholder: event.placeholder } : {}), ...(options.length === 0 ? { allowEmpty: true, dismissLabel: "Skip" } : {}) }] } };
    this.questions.set(event.id, { method: event.method });
    this.emit({ type: "session.permission", sessionId: this.options.sessionId, request });
  }

  private finish(turnId: string | null, messages: PiAgentMessage[], forcedError?: string, canceled = false): void {
    if (!turnId || this.turnId !== turnId) return;
    // NG item 9 terminal boundary: accepted terminals and interrupts flush
    // pending frames synchronously before turn state changes.
    this.streamer.flushSync();
    this.images.release(this.turnImagePaths);
    this.turnImagePaths = [];
    const error = forcedError ?? latestAssistantError(messages);
    // Mirror upstream `completeTurn`: failed and canceled turns stop polling
    // without a final sample; completed turns flush one final bounded sample.
    if (error || canceled) this.usagePoller.stopTurn();
    else void this.usagePoller.completeTurn(turnId);
    this.turnId = null; this.clientMessageId = null; this.turnStarted = false; this.pendingTerminalMessages = null; this.assistantMessageId = null;
    this.activePromptRequestId = null; this.pendingPromptResults.clear(); this.pendingEarlyTerminal = null; this.turnCapturedEntryFresh = false; this.turnNativeActivity = false;
    // Retire per-turn tracking: a tool call orphaned by interrupt/abort
    // never receives `tool_execution_end`, and a buffered `prompt_result`
    // for a request id that never became active would otherwise leak for
    // the session lifetime (and could end a later turn on id reuse).
    // Clearing here keeps stale state from suppressing legacy terminal
    // detection on subsequent turns.
    this.toolCalls.clear();
    this.emit({ type: "session.turn", sessionId: this.options.sessionId, turnId, state: canceled ? "canceled" : error ? "failed" : "completed", ...(error && !canceled ? { error: { message: error } } : {}) });
  }

  private emitTool(id: string, tracked: PiTrackedToolCall, status: "running" | "completed" | "failed", result: ReturnType<typeof parseToolResult>, error: unknown): void {
    this.timeline({ type: "tool_call", id, callId: id, name: resolveToolCallName(tracked, result), detail: this.mapTrackedTool(tracked, result), status, error: status === "failed" ? (error ?? "Tool failed") as never : null });
  }
  private mapTrackedTool(tracked: PiTrackedToolCall, result: ReturnType<typeof parseToolResult>): ReturnType<typeof mapToolDetail> {
    if (this.wjSubagents && isWjTool(tracked.toolName)) {
      return wjToolDetail(tracked.toolName, tracked.args, result) ?? mapToolDetail(tracked, result);
    }
    return mapToolDetail(tracked, result);
  }
  private emitConfig(): void {
    const model = this.options.state.model;
    const currentThinking = model ? thinkingConfigForModel(model) : { thinkingOptions: [], defaultThinkingOptionId: undefined };
    const config: ProviderConfigState = {
      ...(model ? { model: `${model.provider}/${model.id}` } : {}),
      models: this.options.models.map((item) => mapPiCatalogModel(item)),
      modes: [],
      thinkingOption: this.options.state.thinkingLevel,
      thinkingOptions: currentThinking.thinkingOptions,
      settings: [],
    };
    this.emit({ type: "session.config", sessionId: this.options.sessionId, config });
  }
  private refreshUsageSnapshot(): void { void this.usagePoller.refreshNow(); }
  private async setFastMode(enabled: boolean): Promise<void> {
    await this.options.runtime.prompt(`/fast ${enabled ? "on" : "off"}`);
    this.applyFastModeStatus(await this.queryFastMode());
  }
  private async setLongContext(enabled: boolean): Promise<void> {
    await this.options.runtime.prompt(`/${LONG_CONTEXT_COMMAND} ${enabled ? "on" : "off"}`);
    await this.applyLongContextStatus(await this.queryLongContext());
  }
  private async queryLongContext(): Promise<MicroGptStatus> {
    const requestId = randomUUID();
    const status = new Promise<MicroGptStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.longContextQueries.delete(requestId);
        reject(new Error("Timed out querying pi-microgpt long context"));
      }, MICROGPT_QUERY_TIMEOUT_MS);
      this.longContextQueries.set(requestId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    try {
      await this.options.runtime.prompt(`/${LONG_CONTEXT_STATUS_COMMAND} ${requestId}`);
      return await status;
    } catch (error) {
      this.longContextQueries.delete(requestId);
      throw error;
    }
  }
  private async queryFastMode(): Promise<MicroGptStatus> {
    const requestId = randomUUID();
    const status = new Promise<MicroGptStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fastModeQueries.delete(requestId);
        reject(new Error("Timed out querying pi-microgpt Fast mode"));
      }, MICROGPT_QUERY_TIMEOUT_MS);
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
  private applyFastModeStatus(status: MicroGptStatus | undefined): void {
    this.fastModeAvailable = Boolean(this.microgptExtension && status?.success && status.supported);
    if (status?.success) this.fastModeEnabled = status.enabled;
  }
  private async applyLongContextStatus(status: MicroGptStatus | undefined): Promise<void> {
    this.longContextAvailable = Boolean(this.microgptExtension && status?.success && status.supported);
    if (!status?.success) return;
    this.longContextEnabled = status.enabled;
    if (!status.provider || !status.model || status.contextWindow === undefined) return;
    const [state, models] = await Promise.all([this.options.runtime.getState(), this.options.runtime.getAvailableModels()]);
    this.options.state = state.model?.provider === status.provider && state.model.id === status.model
      ? { ...state, model: { ...state.model, contextWindow: status.contextWindow } }
      : state;
    this.options.models = models.map((model) => model.provider === status.provider && model.id === status.model
      ? { ...model, contextWindow: status.contextWindow }
      : model);
    this.refreshUsageSnapshot();
  }
  private timeline(item: ProviderTimelineItem): void {
    // NG item 9 ordering boundary: non-coalesced items (tool calls,
    // notifications, errors) must never overtake text/reasoning buffered in
    // a pending coalescer frame, so flush before emitting anything else.
    // Reentrancy-guarded: flushDirty clears each block before emitting, and
    // the nested timeline calls made during the flush skip the nested flush.
    if (!this.flushingCoalescer) {
      this.flushingCoalescer = true;
      try { this.streamer.flushSync(); } finally { this.flushingCoalescer = false; }
    }
    this.emit({ type: "timeline.item", sessionId: this.options.sessionId, item });
  }
  private emit(event: ProviderEvent): void { if (!this.closed) this.options.emit(event); }
  private promptFailed(clientMessageId: string, message: string): void { this.emit({ type: "session.prompt_result", sessionId: this.options.sessionId, clientMessageId, result: { type: "failed", error: { message } } }); }
}

export function createPaseoExtension(systemPrompt?: string, options?: { nonce?: string }): { path: string; cleanup(): void } {
  const directory = mkdtempSync(join(tmpdir(), "paseo-pi-extension-"));
  const path = join(directory, "paseo-integration.mjs");
  writeFileSync(
    path,
    `
\tfunction decodePayload(encoded) {
\t  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
\t}

\tconst PASEO_NONCE = ${JSON.stringify(options?.nonce ?? null)};

\tfunction withNonce(payload) {
\t  return PASEO_NONCE === null || PASEO_NONCE === undefined
\t    ? payload
\t    : { ...payload, nonce: PASEO_NONCE };
\t}

\tfunction readTextContent(content) {
\t  if (typeof content === "string") {
\t    return content;
\t  }
\t  if (!Array.isArray(content)) {
\t    return "";
\t  }
\t  return content
\t    .filter((part) => part && part.type === "text" && typeof part.text === "string")
\t    .map((part) => part.text)
\t    .join("\\n\\n");
\t}

\tfunction getCapturedUserEntries(ctx) {
\t  return ctx.sessionManager
\t    .getEntries()
\t    .filter((entry) => entry.type === "message" && entry.message?.role === "user")
\t    .map(toCapturedUserEntry);
\t}

\tfunction toCapturedUserEntry(entry) {
\t  return {
\t      id: entry.id,
\t      parentId: entry.parentId ?? null,
\t      text: readTextContent(entry.message.content),
\t    };
\t}

\tfunction emitEntryCapture(ctx, reason, requestId) {
\t  ctx.ui.notify(
\t    "${PASEO_PI_ENTRY_CAPTURE_MARKER} " +
\t      JSON.stringify(withNonce({ reason, requestId, entries: getCapturedUserEntries(ctx) })),
\t    "info",
\t  );
\t}

\tfunction emitCommandResult(ctx, requestId, result) {
\t  ctx.ui.notify(
\t    "${PASEO_PI_COMMAND_RESULT_MARKER} " + JSON.stringify(withNonce({ requestId, ...result })),
\t    result.ok ? "info" : "error",
\t  );
\t}

\texport default function paseoIntegration(pi) {
\t  const submittedUserMessages = [];

\t  function emitSubmittedUserEntries(ctx) {
\t    const entries = ctx.sessionManager.getEntries();
\t    for (let index = 0; index < submittedUserMessages.length; index += 1) {
\t      const message = submittedUserMessages[index];
\t      // Pi assigns the entry ID after message_end, then persists this same message object.
\t      // Reference equality preserves the exact association even when another extension edits it.
\t      const entry = entries.find(
\t        (candidate) => candidate.type === "message" && candidate.message === message,
\t      );
\t      if (!entry) {
\t        continue;
\t      }
\t      submittedUserMessages.splice(index, 1);
\t      index -= 1;
\t      ctx.ui.notify(
\t        "${PASEO_PI_SUBMITTED_USER_ENTRY_MARKER} " +
\t          JSON.stringify(withNonce({ entry: toCapturedUserEntry(entry) })),
\t        "info",
\t      );
\t    }
\t  }

\t  ${
      systemPrompt
        ? `pi.on("before_agent_start", async (event) => ({
\t    systemPrompt: event.systemPrompt + "\\n\\n" + ${JSON.stringify(systemPrompt)},
\t  }));`
        : ""
    }

\t  pi.on("session_start", async (_event, ctx) => {
\t    emitEntryCapture(ctx, "session_start");
\t  });

\t  pi.on("message_end", async (event) => {
\t    if (event.message?.role === "user") {
\t      submittedUserMessages.push(event.message);
\t    }
\t  });

\t  pi.on("message_start", async (event, ctx) => {
\t    if (event.message?.role === "assistant") {
\t      emitSubmittedUserEntries(ctx);
\t    }
\t  });

\t  pi.on("turn_end", async (_event, ctx) => {
\t    emitSubmittedUserEntries(ctx);
\t    emitEntryCapture(ctx, "turn_end");
\t  });

\t  pi.registerCommand("${PASEO_PI_CAPTURE_EXTENSION_COMMAND}", {
\t    description: "Internal Paseo entry capture bridge",
\t    handler: async (args, ctx) => {
\t      const payload = decodePayload(args.trim());
\t      emitEntryCapture(ctx, "command", payload.requestId);
\t    },
\t  });

\t  pi.registerCommand("${PASEO_PI_WJ_PROBE_COMMAND}", {
\t    description: "Internal Paseo subagent capability probe",
\t    handler: async (args, ctx) => {
\t      const requestId = args.trim();
\t      try {
\t        const tools = pi.getAllTools()
\t          .filter((tool) => tool && typeof tool.name === "string")
\t          .map((tool) => tool.name);
\t        emitCommandResult(ctx, requestId, { ok: true, result: tools });
\t      } catch (error) {
\t        emitCommandResult(ctx, requestId, { ok: false, error: String(error) });
\t      }
\t    },
\t  });

\t  pi.registerCommand("${PASEO_PI_TREE_EXTENSION_COMMAND}", {
\t    description: "Internal Paseo tree navigation bridge",
\t    handler: async (args, ctx) => {
\t      const payload = decodePayload(args.trim());
\t      try {
\t        const result = await ctx.navigateTree(payload.targetId, { summarize: false });
\t        emitEntryCapture(ctx, "tree_navigation");
\t        emitCommandResult(ctx, payload.requestId, { ok: true, result });
\t      } catch (error) {
\t        const message = error instanceof Error ? error.message : String(error);
\t        emitCommandResult(ctx, payload.requestId, { ok: false, error: message });
\t        throw error;
\t      }
\t    },
\t  });
\t}
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

function hasMicroGptCommands(commands: readonly { name: string; source: string; sourceInfo?: Record<string, unknown> }[]): boolean {
  return MICROGPT_COMMANDS.every((name) => commands.some((command) =>
    command.name === name
    && command.source === "extension"
    && isMicroGptSource(command.sourceInfo),
  ));
}

function isMicroGptSource(sourceInfo: Record<string, unknown> | undefined): boolean {
  if (!sourceInfo || sourceInfo.origin !== "package" || typeof sourceInfo.baseDir !== "string") return false;
  try {
    const manifest = JSON.parse(readFileSync(join(sourceInfo.baseDir, "package.json"), "utf8")) as { name?: unknown };
    return manifest.name === MICROGPT_PACKAGE_NAME;
  } catch {
    return false;
  }
}

function getSlashCommandArguments(
  prompt: ProviderPrompt,
  text: string,
  name: string,
  emptyArgs: string,
): string | null;
function getSlashCommandArguments(
  prompt: ProviderPrompt,
  text: string,
  name: string,
  emptyArgs: undefined,
): string | undefined | null;
function getSlashCommandArguments(
  prompt: ProviderPrompt,
  text: string,
  name: string,
  emptyArgs: string | undefined,
): string | undefined | null {
  if (prompt.input.type === "command") {
    if (prompt.input.name.toLowerCase() !== name) return null;
    const trimmed = prompt.input.arguments.trim();
    return trimmed ? trimmed : emptyArgs;
  }
  if (prompt.input.content.some((part) => part.type !== "text")) return null;
  const match = new RegExp(`^/${name}(?:\\s+([\\s\\S]*))?$`, "iu").exec(text.trim());
  if (!match) return null;
  const args = match[1]?.trim();
  return args ? args : emptyArgs;
}

function getAutoCompactArguments(prompt: ProviderPrompt, text: string): string | undefined | null {
  return getSlashCommandArguments(prompt, text, "autocompact", undefined);
}

function getCompactArguments(prompt: ProviderPrompt, text: string): string | null {
  // emptyArgs "" can never surface as undefined: null still means
  // "not a compact command" and must be preserved.
  return getSlashCommandArguments(prompt, text, "compact", "");
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
function parseMicroGptStatus(message: string): MicroGptStatus | undefined {
  try {
    const value = JSON.parse(message) as Partial<MicroGptStatus>;
    if (
      value.type !== MICROGPT_RESPONSE_TYPE
      || (value.command !== FAST_MODE_COMMAND && value.command !== LONG_CONTEXT_COMMAND)
      || typeof value.success !== "boolean"
      || typeof value.enabled !== "boolean"
      || typeof value.supported !== "boolean"
      || (value.requestId !== undefined && typeof value.requestId !== "string")
      || (value.provider !== undefined && typeof value.provider !== "string")
      || (value.model !== undefined && typeof value.model !== "string")
      || (value.contextWindow !== undefined && typeof value.contextWindow !== "number")
    ) return undefined;
    return value as MicroGptStatus;
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
