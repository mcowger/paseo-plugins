import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PiAgentSessionEvent, PiAgentSessionLike, PiSessionManagerLike } from "../shared/pi-sdk-types.js";
import type {
  ProviderCommand,
  ProviderConfigChanges,
  ProviderConfigState,
  ProviderEvent,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";

import type { PiAgentMessage, PiImageContent, PiModel, PiThinkingLevel } from "../shared/rpc-types.js";
import type { McpBridgeHandle } from "./mcp-bridge.js";
import {
  createHeadlessUiContext,
  type PiUiDialogRequest,
  type PiUiDialogResponse,
} from "./pi-ui-context.js";
import {
  readActivePresetName,
  presetsToModes,
  type PiPreset,
  type PiPresetsConfig,
} from "./presets.js";
import {
  getUserMessageText,
  PiHistoryMapper,
  type PiCommandHistoryEntry,
} from "./history-mapper.js";
import {
  DEFAULT_PI_THINKING_LEVEL,
  clampThinkingLevel,
  mapPiModel,
  normalizePiThinkingLevel,
  parsePiModelReference,
  supportedThinkingLevels,
  thinkingOptionsForModel,
} from "./thinking.js";
import {
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
  type PiToolResult,
  type PiTrackedToolCall,
} from "./tool-call-mapper.js";
import { hasPiToolGlob, resolvePiToolPatterns } from "./tool-patterns.js";
import { extractTodoSnapshot, PI_TODO_TIMELINE_ITEM_ID } from "./todo.js";

const QUESTION_RESPONSE_HEADER = "Response";
const PI_COMPACTION_ITEM_ID = "pi-compaction";
const PI_COMMAND_ANCHOR_ENTRY_TYPE = "paseo-command-anchor";
const PI_COMMAND_ENTRY_TYPE = "paseo-command";
const TODO_TOOL_NAMES = new Set(["todo"]);

export interface SdkSessionBundle {
  session: PiAgentSessionLike;
  sessionManager: PiSessionManagerLike;
  mcp: McpBridgeHandle | null;
  presets: PiPresetsConfig;
  promptCommands: ProviderCommand[];
}

export interface PiProviderSessionOptions {
  sessionId: string;
  bundle: SdkSessionBundle;
  config: ProviderSessionConfig;
  models: PiModel[];
  loadPresets?: () => PiPresetsConfig;
  emit(event: ProviderEvent): void;
  cleanup?: () => void;
}

interface PiPromptPayload {
  text: string;
  images?: PiImageContent[];
}

interface PiPendingSteerSubmission {
  text: string;
  clientMessageId: string | null;
}

interface PendingDialog {
  method: PiUiDialogRequest["method"];
  resolve(response: PiUiDialogResponse): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const AUTO_COMPACTION_SETTING = "autoCompaction";
const AUTO_RETRY_SETTING = "autoRetry";

function settingBoolean(settings: Readonly<Record<string, unknown>>, id: string): boolean | undefined {
  return typeof settings[id] === "boolean" ? settings[id] : undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return /\brequest was aborted\b|\babort(ed)?\b/i.test(toErrorMessage(error));
}

function modelToId(model: { provider?: string; id?: string } | null | undefined): string | null {
  return model?.provider && model.id ? `${model.provider}/${model.id}` : null;
}

function materializeImage(image: { data: string; mimeType: string }): string {
  const extension = image.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
  const dir = mkdtempSync(join(tmpdir(), "paseo-pi-image-"));
  const filePath = join(dir, `image.${extension}`);
  writeFileSync(filePath, Buffer.from(image.data, "base64"));
  return filePath;
}

function renderTextOnlyImageHint(image: { data: string; mimeType: string }): string {
  try {
    return `[Image available at: ${materializeImage(image)}]`;
  } catch (error) {
    return `[Image attachment omitted: failed to write local file (${toErrorMessage(error)})]`;
  }
}

function renderAttachmentAsText(part: Record<string, unknown>): string {
  const title = optionalString(part.title);
  const url = optionalString(part.url);
  const body = optionalString(part.body);
  if (part.type === "uploaded_file") {
    const fileName = optionalString(part.fileName) ?? "file";
    const path = optionalString(part.path);
    return path ? `[File: ${fileName}]\nPath: ${path}` : `[File: ${fileName}]`;
  }
  if (title || url) {
    const header = title && url ? `[${title}](${url})` : (title ?? url ?? "Attachment");
    return body ? `${header}\n\n${body}` : header;
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  return `[Attachment: ${JSON.stringify(part)}]`;
}

function convertPromptInput(
  prompt: Extract<ProviderPrompt["input"], { type: "message" }>,
  options: { model: PiModel | null | undefined },
): PiPromptPayload {
  const textParts: string[] = [];
  const images: PiImageContent[] = [];
  const forwardImages = options.model?.input?.includes("image") === true;

  for (const block of prompt.content) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "image") {
      if (forwardImages) {
        images.push({ type: "image", data: block.data, mimeType: block.mimeType });
      } else {
        textParts.push(renderTextOnlyImageHint(block));
      }
      continue;
    }
    textParts.push(renderAttachmentAsText(block as unknown as Record<string, unknown>));
  }

  const payload: PiPromptPayload = { text: textParts.join("\n\n") };
  if (images.length > 0) {
    payload.images = images;
  }
  return payload;
}

function latestPiErrorMessage(messages: readonly PiAgentMessage[]): string | null {
  const latestAssistant = messages.findLast((message) => message.role === "assistant");
  if (!latestAssistant || !latestAssistant.errorMessage?.trim()) {
    return null;
  }
  const details = [
    latestAssistant.stopReason ? `stopReason=${latestAssistant.stopReason}` : null,
    latestAssistant.provider && latestAssistant.model
      ? `model=${latestAssistant.provider}/${latestAssistant.model}`
      : null,
  ].filter((detail): detail is string => detail !== null);
  const headline = latestAssistant.errorMessage.trim();
  return details.length > 0 ? `${headline} (${details.join(", ")})` : headline;
}

function isAbortedTerminalResponse(messages: readonly PiAgentMessage[]): boolean {
  const latestAssistant = messages.findLast((message) => message.role === "assistant");
  return latestAssistant?.stopReason?.toLowerCase() === "aborted";
}

export class PiProviderSession {
  private readonly sessionId: string;
  private readonly sdk: PiAgentSessionLike;
  private readonly sessionManager: PiSessionManagerLike;
  private readonly config: ProviderSessionConfig;
  private readonly emitEvent: (event: ProviderEvent) => void;
  private readonly cleanup?: () => void;
  private presets: PiPresetsConfig;
  private readonly promptCommands: ProviderCommand[];
  private readonly mcp: McpBridgeHandle | null;
  private readonly loadPresets?: () => PiPresetsConfig;

  private models: PiModel[];
  private currentMode: string | null = null;
  private activePresetInstructions: string | null = null;
  private activePresetDefinitionModified = false;
  private pendingPresetNotice: string | null = null;
  private configurationQueue: Promise<unknown> = Promise.resolve();
  private lastConfigStateJson: string | null = null;
  private lastPersistenceJson: string | null = null;

  private readonly activeToolCalls = new Map<string, PiTrackedToolCall>();
  private readonly pendingDialogs = new Map<string, PendingDialog>();
  private activeTurnId: string | null = null;
  private activeClientMessageId: string | null = null;
  private activeAssistantMessageId: string | null = null;
  private activeAssistantText = "";
  private activeReasoningId: string | null = null;
  private activeReasoningText = "";
  private activeTurnStarted = false;
  private pendingSettledMessages: PiAgentMessage[] | null = null;
  private readonly pendingSteerSubmissions: PiPendingSteerSubmission[] = [];
  private readonly emittedUserEntryIds = new Set<string>();
  private interruptingTurn: { turnId: string | undefined } | null = null;
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(options: PiProviderSessionOptions) {
    this.sessionId = options.sessionId;
    this.sdk = options.bundle.session;
    this.sessionManager = options.bundle.sessionManager;
    this.presets = options.bundle.presets;
    this.promptCommands = options.bundle.promptCommands;
    this.mcp = options.bundle.mcp;
    this.config = options.config;
    this.models = options.models;
    this.loadPresets = options.loadPresets;
    this.emitEvent = options.emit;
    this.cleanup = options.cleanup;

    this.currentMode = readActivePresetName(this.sessionManager.getBranch());
    const restoredPreset = this.currentMode ? this.presets[this.currentMode] : undefined;
    if (restoredPreset?.appendSystemPrompt) {
      this.applyPresetInstructions(restoredPreset.appendSystemPrompt);
    }

    void this.sdk.bindExtensions({
      uiContext: createHeadlessUiContext({
        requestDialog: (request) => this.requestDialog(request),
        notify: (message, level) => this.emitNotification(message, level),
      }),
      mode: "rpc",
    });

    this.unsubscribe = this.sdk.subscribe((event) => {
      this.handleSessionEvent(event as PiAgentSessionEvent);
    });
  }

  get persistence(): ProviderPersistence {
    return {
      version: 2,
      data: {
        sessionFile: this.sdk.sessionFile ?? null,
        leafId: this.sessionManager.getLeafId(),
        cwd: this.config.cwd,
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.thinkingOption ? { thinkingOption: this.config.thinkingOption } : {}),
      },
    };
  }

  configState(): ProviderConfigState {
    this.refreshPresets();
    const currentModelId = modelToId(this.sdk.model);
    const currentModel = this.currentModel();
    return {
      ...(currentModelId ? { model: currentModelId } : {}),
      models: this.models.map((model) => mapPiModel(model)),
      modes: presetsToModes(this.presets, this.currentMode, this.currentPresetIsModified()),
      ...(this.currentMode && this.presets[this.currentMode] ? { mode: this.currentMode } : {}),
      thinkingOption: normalizePiThinkingLevel(this.sdk.thinkingLevel) ?? undefined,
      thinkingOptions: currentModel ? (thinkingOptionsForModel(currentModel) ?? []) : [],
      settings: [
        {
          type: "toggle",
          id: AUTO_COMPACTION_SETTING,
          label: "Auto-compaction",
          description: "Compact long conversations automatically.",
          value: this.sdk.autoCompactionEnabled,
        },
        {
          type: "toggle",
          id: AUTO_RETRY_SETTING,
          label: "Auto-retry",
          description: "Retry transient provider errors automatically.",
          value: this.sdk.autoRetryEnabled,
        },
      ],
    };
  }

  emitConfigState(): void {
    const config = this.configState();
    const json = JSON.stringify(config);
    if (json === this.lastConfigStateJson) {
      return;
    }
    this.lastConfigStateJson = json;
    this.emit({ type: "session.config", sessionId: this.sessionId, config });
  }

  emitPersistence(): void {
    const persistence = this.persistence;
    const json = JSON.stringify(persistence);
    if (json === this.lastPersistenceJson) {
      return;
    }
    this.lastPersistenceJson = json;
    this.emit({ type: "session.persistence", sessionId: this.sessionId, persistence });
  }

  /** Read state directly from the SDK session and re-emit config/persistence. */
  refreshState(): void {
    this.emitConfigState();
    this.emitPersistence();
  }

  updatePresets(presets: PiPresetsConfig): void {
    void this.enqueueConfiguration(async () => {
      const previousPreset = this.currentMode ? this.presets[this.currentMode] : undefined;
      const previousName = previousPreset?.name ?? this.currentMode;
      const activeModeRemoved = Boolean(this.currentMode && !presets[this.currentMode]);
      const activeModeChanged = Boolean(
        this.currentMode &&
          presets[this.currentMode] &&
          JSON.stringify(previousPreset) !== JSON.stringify(presets[this.currentMode]),
      );
      this.presets = presets;
      if (activeModeRemoved) {
        this.currentMode = null;
        this.activePresetDefinitionModified = false;
        if (previousName) {
          this.emitNotification(
            `Pi preset "${previousName}" was removed. Its current settings remain active until another preset or model is selected.`,
            "warning",
          );
        }
      } else if (activeModeChanged) {
        this.activePresetDefinitionModified = true;
        this.emitNotification(
          `Pi preset "${previousName ?? this.currentMode}" changed in Paseo settings. Reselect it to apply the new definition.`,
          "warning",
        );
      }
      this.emitConfigState();
    });
  }

  listCommands(): ProviderCommand[] {
    return this.promptCommands;
  }

  async replayHistory(): Promise<void> {
    const commandItemsByUserCount = new Map<number, PiCommandHistoryEntry[]>();
    const userEntries: { id: string; text: string }[] = [];
    let userCount = 0;

    for (const entry of this.sessionManager.getBranch()) {
      if (!isRecord(entry)) continue;
      if (entry.type === "message") {
        const message = entry.message;
        if (!isRecord(message) || message.role !== "user") continue;
        const id = optionalString(entry.id);
        if (!id) continue;
        const content = message.content as
          | string
          | Array<{ type: string; text?: string }>
          | undefined;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter((part) => part && part.type === "text" && typeof part.text === "string")
                  .map((part) => part.text)
                  .join("\n\n")
              : "";
        if (text) userEntries.push({ id, text });
        userCount += 1;
        continue;
      }
      if (entry.type !== "custom" || entry.customType !== PI_COMMAND_ENTRY_TYPE) continue;
      const data = isRecord(entry.data) ? entry.data : null;
      const id = optionalString(entry.id);
      const text = optionalString(data?.text);
      const anchorId = optionalString(data?.anchorId);
      if (!id || !text || !anchorId) continue;
      const commandEntry: PiCommandHistoryEntry = { id, text, anchorId, userCount };
      const commands = commandItemsByUserCount.get(userCount) ?? [];
      commands.push(commandEntry);
      commandItemsByUserCount.set(userCount, commands);
    }

    const mapper = new PiHistoryMapper(userEntries);
    const messages = this.sdk.messages as unknown as PiAgentMessage[];
    let mappedUserCount = 0;
    for (const message of messages) {
      if (message.role === "user") {
        for (const command of commandItemsByUserCount.get(mappedUserCount) ?? []) {
          this.emit({
            type: "timeline.item",
            sessionId: this.sessionId,
            item: mapper.mapCommandEntry(command),
          });
        }
        mappedUserCount += 1;
      }
      for (const item of mapper.mapMessage(message)) {
        this.emit({ type: "timeline.item", sessionId: this.sessionId, item });
      }
    }
    for (const command of commandItemsByUserCount.get(mappedUserCount) ?? []) {
      this.emit({
        type: "timeline.item",
        sessionId: this.sessionId,
        item: mapper.mapCommandEntry(command),
      });
    }
  }

  async handlePrompt(prompt: ProviderPrompt): Promise<void> {
    if (this.closed) {
      this.emitPromptResult(prompt.clientMessageId, {
        type: "failed",
        error: { message: "Pi session is closed" },
      });
      return;
    }

    if (prompt.input.type === "command") {
      await this.handleCommand(prompt);
      return;
    }

    const textParts = prompt.input.content.filter(
      (part): part is Extract<typeof part, { type: "text" }> => part.type === "text",
    );
    const text =
      textParts.length === prompt.input.content.length
        ? textParts.map((part) => part.text).join("\n")
        : "";
    const runtimeSetting = this.parseRuntimeSettingCommand(text);
    if (runtimeSetting) {
      await this.applyRuntimeSetting(runtimeSetting.id, runtimeSetting.value, prompt.clientMessageId);
      return;
    }

    let payload = convertPromptInput(prompt.input, { model: this.currentModel() });
    const slashInvocation = this.parseSlashCommandInput(payload.text);
    if (!slashInvocation) {
      payload = { ...payload, text: this.consumePresetNotice(payload.text) };
    }

    if (prompt.delivery === "steer" && this.activeTurnId && !slashInvocation) {
      await this.steerActiveTurn(payload, prompt);
      return;
    }
    if (prompt.delivery === "steer" && this.activeTurnId && slashInvocation) {
      await this.interrupt();
    }
    await this.startTurn(payload, prompt);
  }

  private async handleCommand(prompt: ProviderPrompt): Promise<void> {
    const { name, arguments: args } = prompt.input as { name: string; arguments: string };
    const commandText = `/${name}${args ? ` ${args}` : ""}`;

    if (name === "preset") {
      const commandEntry = this.appendCommandEntry(commandText);
      this.emitCommandUserMessage(prompt.clientMessageId, commandText, commandEntry);
      try {
        await this.applyPreset(args.trim());
        this.emitPromptResult(prompt.clientMessageId, { type: "completed" });
      } catch (error) {
        this.emitPromptResult(prompt.clientMessageId, {
          type: "failed",
          error: { message: toErrorMessage(error) },
        });
      }
      this.refreshState();
      return;
    }

    if (name === "compact") {
      const commandEntry = this.appendCommandEntry(commandText);
      this.emitCommandUserMessage(prompt.clientMessageId, commandText, commandEntry);
      try {
        await this.sdk.compact(args.trim() || undefined);
        this.emitPromptResult(prompt.clientMessageId, { type: "completed" });
      } catch (error) {
        this.emitPromptResult(prompt.clientMessageId, {
          type: "failed",
          error: { message: toErrorMessage(error) },
        });
      }
      return;
    }

    // Any other published command (prompt templates): forward through pi's
    // prompt pipeline, which expands templates / dispatches extension commands.
    const payload: PiPromptPayload = { text: commandText };
    await this.startTurn(payload, prompt);
  }

  private appendCommandEntry(text: string): { id: string; anchorId: string } {
    const anchorId = this.sessionManager.appendCustomEntry(PI_COMMAND_ANCHOR_ENTRY_TYPE, { text });
    const id = this.sessionManager.appendCustomEntry(PI_COMMAND_ENTRY_TYPE, {
      text,
      anchorId,
    });
    return { id, anchorId };
  }

  private emitCommandUserMessage(
    clientMessageId: string,
    text: string,
    commandEntry: { id: string; anchorId: string },
  ): void {
    this.emit({
      type: "timeline.item",
      sessionId: this.sessionId,
      item: {
        type: "user_message",
        id: commandEntry.id,
        messageId: commandEntry.id,
        revertToken: commandEntry.anchorId,
        text,
        clientMessageId,
      },
    });
  }

  private async steerActiveTurn(payload: PiPromptPayload, prompt: ProviderPrompt): Promise<void> {
    const turnId = this.activeTurnId;
    try {
      await this.sdk.steer(payload.text, payload.images);
    } catch (error) {
      this.emitPromptResult(prompt.clientMessageId, {
        type: "failed",
        error: { message: toErrorMessage(error) },
      });
      return;
    }
    if (this.closed || this.activeTurnId !== turnId || !turnId) {
      this.emitPromptResult(prompt.clientMessageId, {
        type: "failed",
        error: { message: "The active turn ended before the steer was queued" },
      });
      return;
    }
    this.pendingSteerSubmissions.push({
      text: payload.text,
      clientMessageId: prompt.clientMessageId,
    });
    if (prompt.clearPendingPermissions) {
      this.cancelPendingDialogs("The user answered with a message instead of approving.");
    }
    this.emitPromptResult(prompt.clientMessageId, { type: "steer", turnId });
  }

  private async startTurn(payload: PiPromptPayload, prompt: ProviderPrompt): Promise<void> {
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    this.activeClientMessageId = prompt.clientMessageId;
    this.activeAssistantMessageId = null;
    this.activeAssistantText = "";
    this.activeReasoningId = null;
    this.activeReasoningText = "";
    this.activeTurnStarted = false;
    this.pendingSettledMessages = null;
    this.pendingSteerSubmissions.length = 0;

    this.emitPromptResult(prompt.clientMessageId, { type: "turn", turnId });
    this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "started" });

    void (async () => {
      try {
        await this.sdk.prompt(payload.text, {
          ...(payload.images?.length
            ? {
                images: payload.images.map((image) => ({
                  type: "image" as const,
                  data: image.data,
                  mimeType: image.mimeType,
                })),
              }
            : {}),
          ...(this.activeTurnStarted ? { streamingBehavior: "steer" as const } : {}),
        });
        if (this.closed || this.activeTurnId !== turnId) {
          return;
        }
        // prompt() resolution is the backstop for turns that never produced
        // agent activity (extension commands, rejected prompts). Real agent
        // turns complete via agent_end/agent_settled events.
        if (!this.activeTurnStarted) {
          this.completeTurn(turnId, this.sdk.messages as PiAgentMessage[]);
        }
      } catch (error) {
        if (this.closed || this.activeTurnId !== turnId) {
          return;
        }
        this.resetTurnState();
        if (isAbortError(error)) {
          this.emit({
            type: "session.turn",
            sessionId: this.sessionId,
            turnId,
            state: "canceled",
            error: { message: toErrorMessage(error) },
          });
          return;
        }
        this.emit({
          type: "session.turn",
          sessionId: this.sessionId,
          turnId,
          state: "failed",
          error: { message: toErrorMessage(error) },
        });
      }
    })();
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeTurnId ?? undefined;
    if (this.activeTurnId || this.activeTurnStarted) {
      this.interruptingTurn = { turnId };
    }
    try {
      await this.sdk.abort();
    } catch (error) {
      this.interruptingTurn = null;
      throw error;
    }
    if (
      this.interruptingTurn?.turnId === turnId &&
      (this.activeTurnId || this.activeTurnStarted) &&
      (this.activeTurnId ?? undefined) === turnId
    ) {
      this.resetTurnState();
      this.emit({
        type: "session.turn",
        sessionId: this.sessionId,
        turnId: turnId ?? randomUUID(),
        state: "canceled",
      });
    }
    this.interruptingTurn = null;
  }

  respondToPermission(requestId: string, response: ProviderPermissionResponse): void {
    const pending = this.pendingDialogs.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request with id '${requestId}'`);
    }
    this.pendingDialogs.delete(requestId);

    if (response.behavior === "deny") {
      pending.resolve({ kind: "cancelled" });
    } else if (pending.method === "confirm") {
      const answer = this.firstAnswer(response.updatedInput);
      pending.resolve({ kind: "confirmed", confirmed: /^yes$/i.test(answer?.trim() ?? "") });
    } else {
      const answer = this.firstAnswer(response.updatedInput);
      pending.resolve(answer === null ? { kind: "cancelled" } : { kind: "value", value: answer });
    }
    this.emit({
      type: "session.permission_resolved",
      sessionId: this.sessionId,
      permissionId: requestId,
    });
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    await this.enqueueConfiguration(() => this.configureNow(changes));
  }

  private async configureNow(changes: ProviderConfigChanges): Promise<void> {
    this.refreshPresets();
    if (changes.mode) {
      await this.applyPresetNow(changes.mode, {});
    }
    if (changes.model) {
      const reference = parsePiModelReference(changes.model);
      if (!reference?.provider) {
        throw new Error(`Pi model id must include a provider: ${changes.model}`);
      }
      const model = this.sdk.modelRuntime.getModel(reference.provider, reference.id);
      if (!model) {
        throw new Error(`Model not found: ${changes.model}`);
      }
      await this.sdk.setModel(model);
      this.config.model = modelToId(model) ?? this.config.model;
      this.upsertModel(model as unknown as PiModel);
      this.syncThinkingToCurrentModel();
    }
    if (changes.thinkingOption !== undefined) {
      const level = normalizePiThinkingLevel(changes.thinkingOption) ?? DEFAULT_PI_THINKING_LEVEL;
      this.syncThinkingToCurrentModel(level);
    }
    if (changes.settings) {
      const autoCompaction = settingBoolean(changes.settings, AUTO_COMPACTION_SETTING);
      const autoRetry = settingBoolean(changes.settings, AUTO_RETRY_SETTING);
      if (autoCompaction !== undefined) this.sdk.setAutoCompactionEnabled(autoCompaction);
      if (autoRetry !== undefined) this.sdk.setAutoRetryEnabled(autoRetry);
    }
    const currentPreset = this.currentMode ? this.presets[this.currentMode] : undefined;
    if (currentPreset) {
      this.applyPresetInstructions(currentPreset.appendSystemPrompt ?? null);
    }
    this.refreshState();
  }

  /** Activate a pi preset natively: model, thinking, tools, and instructions. */
  async applyPreset(name: string, options: { announce?: boolean } = {}): Promise<void> {
    await this.enqueueConfiguration(() => this.applyPresetNow(name, options));
  }

  private async applyPresetNow(name: string, options: { announce?: boolean }): Promise<void> {
    this.refreshPresets();
    const preset = this.presets[name];
    if (!preset) {
      const available = Object.keys(this.presets).join(", ") || "(none defined)";
      throw new Error(`Unknown pi preset "${name}". Available: ${available}`);
    }

    const reference = parsePiModelReference(preset.model);
    if (!reference?.provider) {
      throw new Error(`Preset "${name}" model must include a provider: ${preset.model}`);
    }
    const model = this.sdk.modelRuntime.getModel(reference.provider, reference.id);
    if (!model) {
      throw new Error(`Preset "${name}" model not found: ${preset.model}`);
    }
    const activeTools =
      preset.tools === undefined ? undefined : this.resolvePresetTools(preset.tools);

    await this.sdk.setModel(model);
    this.upsertModel(model as unknown as PiModel);
    this.config.model = modelToId(model) ?? this.config.model;
    this.syncThinkingToCurrentModel(preset.thinkingLevel);

    if (activeTools !== undefined) {
      this.sdk.setActiveToolsByName(activeTools);
    }
    this.applyPresetInstructions(preset.appendSystemPrompt ?? null);

    const changed = this.currentMode !== name;
    this.sessionManager.appendCustomEntry("preset-state", { name });
    this.currentMode = name;
    this.activePresetDefinitionModified = false;
    if (options.announce !== false && changed) {
      this.pendingPresetNotice = this.buildPresetChangeNotice(preset);
      this.emitNotification(`Pi preset changed to ${preset.name}.`, "info");
    }
    this.emitConfigState();
  }

  private applyPresetInstructions(instructions: string | null): void {
    const state = this.sdk.agent.state as { systemPrompt: string };
    let prompt = state.systemPrompt;
    const previous = this.activePresetInstructions;
    if (previous) {
      const suffix = `\n\n${previous}`;
      if (prompt.endsWith(suffix)) {
        prompt = prompt.slice(0, -suffix.length);
      }
    }
    state.systemPrompt = instructions ? `${prompt}\n\n${instructions}` : prompt;
    this.activePresetInstructions = instructions;
  }

  async revertConversation(token: unknown): Promise<void> {
    if (this.activeTurnId) {
      throw new Error("Cannot rewind the Pi conversation while a turn is active");
    }
    const targetId = typeof token === "string" ? token.trim() : "";
    if (!targetId) {
      throw new Error("Pi rewind requires a user message id revert token");
    }
    const target = this.sessionManager.getEntry(targetId);
    if (!isRecord(target)) {
      throw new Error(`Pi rewind target ${targetId} was not found in the session tree`);
    }
    const isUserMessage =
      target.type === "message" && isRecord(target.message) && target.message.role === "user";
    const isCommandAnchor =
      target.type === "custom" && target.customType === PI_COMMAND_ANCHOR_ENTRY_TYPE;
    if (!isUserMessage && !isCommandAnchor) {
      throw new Error(`Pi rewind target ${targetId} is not a user message or command anchor`);
    }
    const result = await this.sdk.navigateTree(targetId, { summarize: false });
    if (isRecord(result) && result.cancelled === true) {
      throw new Error(`Pi rewind target ${targetId} was not selected`);
    }
    this.activeToolCalls.clear();
    this.activeAssistantMessageId = null;
    this.activeAssistantText = "";
    this.activeReasoningId = null;
    this.activeReasoningText = "";
    this.pendingSettledMessages = null;
    this.pendingSteerSubmissions.length = 0;
    this.currentMode = readActivePresetName(this.sessionManager.getBranch());
    this.cancelPendingDialogs("The Pi conversation was rewound.");
    this.refreshState();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribe();
    this.cancelAllDialogs(new Error("Pi session closed"));
    try {
      if (this.mcp) {
        await this.mcp.close().catch(() => undefined);
      }
    } finally {
      this.sdk.dispose();
      this.cleanup?.();
    }
  }

  private enqueueConfiguration<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.configurationQueue.then(operation, operation);
    this.configurationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private resolvePresetTools(patterns: readonly string[]): string[] {
    const availableTools = this.sdk.getAllTools?.().map((tool) => tool.name);
    if (!availableTools) {
      if (patterns.some(hasPiToolGlob)) {
        throw new Error("Pi did not expose its tool list, so preset glob patterns cannot be resolved");
      }
      return [...patterns];
    }
    return resolvePiToolPatterns(availableTools, patterns);
  }

  private syncThinkingToCurrentModel(preferredLevel?: string): void {
    const requested =
      normalizePiThinkingLevel(preferredLevel) ??
      normalizePiThinkingLevel(this.sdk.thinkingLevel) ??
      DEFAULT_PI_THINKING_LEVEL;
    const clamped = this.clampToCurrentModel(requested);
    this.sdk.setThinkingLevel(clamped);
    this.config.thinkingOption = clamped;
  }

  private refreshPresets(): void {
    if (this.loadPresets) {
      this.presets = this.loadPresets();
    }
    if (this.currentMode && !this.presets[this.currentMode]) {
      this.currentMode = null;
      this.activePresetDefinitionModified = false;
    }
  }

  private currentPresetIsModified(): boolean {
    const preset = this.currentMode ? this.presets[this.currentMode] : undefined;
    if (!preset) {
      return false;
    }
    if (this.activePresetDefinitionModified) {
      return true;
    }
    if (modelToId(this.sdk.model) !== preset.model) {
      return true;
    }
    const expectedThinking = this.clampToCurrentModel(preset.thinkingLevel);
    if (normalizePiThinkingLevel(this.sdk.thinkingLevel) !== expectedThinking) {
      return true;
    }
    if ((this.activePresetInstructions ?? null) !== (preset.appendSystemPrompt ?? null)) {
      return true;
    }
    if (preset.tools !== undefined && this.sdk.getActiveToolNames) {
      const expectedTools = this.resolvePresetTools(preset.tools).sort();
      const actualTools = [...this.sdk.getActiveToolNames()].sort();
      if (
        expectedTools.length !== actualTools.length ||
        expectedTools.some((tool, index) => tool !== actualTools[index])
      ) {
        return true;
      }
    }
    return false;
  }

  private buildPresetChangeNotice(preset: PiPreset): string {
    const instructions = preset.appendSystemPrompt ?? "(No additional preset instructions.)";
    return `NOTE: YOUR PRESET MODE HAS CHANGED TO ${preset.name}. FOLLOW ITS INSTRUCTIONS:\n${instructions}`;
  }

  private consumePresetNotice(text: string): string {
    const notice = this.pendingPresetNotice;
    if (!notice) {
      return text;
    }
    this.pendingPresetNotice = null;
    return text ? `${notice}\n\n${text}` : notice;
  }

  private currentModel(): PiModel | null {
    const model = this.sdk.model;
    if (!model) {
      return null;
    }
    return (model as unknown as PiModel) ?? null;
  }

  private upsertModel(model: PiModel): void {
    const index = this.models.findIndex(
      (candidate) => candidate.provider === model.provider && candidate.id === model.id,
    );
    if (index === -1) {
      this.models = [...this.models, model];
    } else {
      this.models = this.models.map((candidate, i) => (i === index ? model : candidate));
    }
  }

  private clampToCurrentModel(level: string): PiThinkingLevel {
    const current = this.currentModel();
    const requested = normalizePiThinkingLevel(level) ?? DEFAULT_PI_THINKING_LEVEL;
    if (!current) {
      return requested;
    }
    const supported = supportedThinkingLevels(current);
    if (supported.length === 0) {
      return requested;
    }
    return clampThinkingLevel(requested, supported) ?? requested;
  }

  private emit(event: ProviderEvent): void {
    if (this.closed) {
      return;
    }
    this.emitEvent(event);
  }

  private emitPromptResult(
    clientMessageId: string,
    result: Extract<ProviderEvent, { type: "session.prompt_result" }>["result"],
  ): void {
    this.emit({
      type: "session.prompt_result",
      sessionId: this.sessionId,
      clientMessageId,
      result,
    });
  }

  private resetTurnState(): void {
    this.activeTurnId = null;
    this.activeClientMessageId = null;
    this.activeAssistantMessageId = null;
    this.activeAssistantText = "";
    this.activeReasoningId = null;
    this.activeReasoningText = "";
    this.activeTurnStarted = false;
    this.pendingSettledMessages = null;
    this.pendingSteerSubmissions.length = 0;
  }

  private parseRuntimeSettingCommand(text: string): { id: string; value: boolean } | null {
    const match = /^\/settings\s+(auto-compaction|auto-retry)\s+(on|off)$/i.exec(text.trim());
    if (!match) return null;
    return {
      id:
        match[1].toLowerCase() === "auto-compaction"
          ? AUTO_COMPACTION_SETTING
          : AUTO_RETRY_SETTING,
      value: match[2].toLowerCase() === "on",
    };
  }

  private async applyRuntimeSetting(id: string, value: boolean, clientMessageId: string): Promise<void> {
    if (id === AUTO_COMPACTION_SETTING) this.sdk.setAutoCompactionEnabled(value);
    else if (id === AUTO_RETRY_SETTING) this.sdk.setAutoRetryEnabled(value);
    else throw new Error(`Unsupported Pi runtime setting: ${id}`);
    this.emitPromptResult(clientMessageId, { type: "completed" });
    this.emitConfigState();
  }

  private parseSlashCommandInput(text: string): { commandName: string; args?: string } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/") || trimmed.length <= 1) {
      return null;
    }
    const withoutPrefix = trimmed.slice(1);
    const firstWhitespaceIdx = withoutPrefix.search(/\s/);
    const commandName =
      firstWhitespaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, firstWhitespaceIdx);
    if (!commandName || commandName.includes("/")) {
      return null;
    }
    const rawArgs =
      firstWhitespaceIdx === -1 ? "" : withoutPrefix.slice(firstWhitespaceIdx + 1).trim();
    return rawArgs.length > 0 ? { commandName, args: rawArgs } : { commandName };
  }

  private takePendingSteerSubmission(text: string): PiPendingSteerSubmission | undefined {
    const index = this.pendingSteerSubmissions.findIndex(
      (submission) => submission.text === text,
    );
    if (index < 0) {
      return undefined;
    }
    const [submission] = this.pendingSteerSubmissions.splice(index, 1);
    return submission;
  }

  private firstAnswer(input: Record<string, unknown> | undefined): string | null {
    const answers = isRecord(input?.answers) ? input.answers : null;
    if (!answers) {
      return null;
    }
    const first = Object.values(answers).find((value) => typeof value === "string");
    return typeof first === "string" ? first : null;
  }

  private requestDialog(dialog: PiUiDialogRequest): Promise<PiUiDialogResponse> {
    if (this.closed) {
      return Promise.resolve({ kind: "cancelled" });
    }
    const id = randomUUID();
    const question = this.dialogQuestion(dialog);
    const request: ProviderPermissionRequest = {
      id,
      name: `Pi ${dialog.method}`,
      kind: "question",
      title: question.title,
      input: {
        questions: [
          {
            question: question.title,
            header: QUESTION_RESPONSE_HEADER,
            options: question.options.map((label) => ({ label })),
            multiSelect: false,
            ...(question.placeholder ? { placeholder: question.placeholder } : {}),
            ...(question.options.length === 0 ? { allowEmpty: true } : {}),
            ...(question.options.length === 0 ? { dismissLabel: "Skip" } : {}),
          },
        ],
      },
      metadata: { extensionUiMethod: dialog.method },
    };
    const promise = new Promise<PiUiDialogResponse>((resolve) => {
      this.pendingDialogs.set(id, { method: dialog.method, resolve });
    });
    this.emit({ type: "session.permission", sessionId: this.sessionId, request });
    return promise;
  }

  private dialogQuestion(dialog: PiUiDialogRequest): {
    title: string;
    options: string[];
    placeholder?: string;
  } {
    switch (dialog.method) {
      case "select":
        return { title: dialog.title ?? "Select an option", options: dialog.options ?? [] };
      case "confirm":
        return {
          title: [dialog.title, dialog.message].filter(Boolean).join("\n\n"),
          options: ["Yes", "No"],
        };
      case "input":
        return {
          title: dialog.title ?? "Enter a value",
          options: [],
          ...(dialog.placeholder ? { placeholder: dialog.placeholder } : {}),
        };
      case "editor":
        return {
          title: dialog.title ?? "Edit text",
          options: [],
          ...(dialog.placeholder ? { placeholder: dialog.placeholder } : {}),
        };
    }
  }

  private cancelPendingDialogs(message: string): void {
    void message;
    for (const [, pending] of this.pendingDialogs) {
      pending.resolve({ kind: "cancelled" });
    }
    this.pendingDialogs.clear();
  }

  private cancelAllDialogs(error: Error): void {
    void error;
    this.cancelPendingDialogs("closed");
  }

  private emitNotification(message: string, level: "info" | "warning" | "error"): void {
    this.emit({
      type: "timeline.item",
      sessionId: this.sessionId,
      item: {
        type: "notification",
        id: `notification:${randomUUID()}`,
        level,
        message,
      },
    });
  }

  private emitUsage(): void {
    let stats: ReturnType<PiAgentSessionLike["getSessionStats"]>;
    try {
      stats = this.sdk.getSessionStats();
    } catch {
      return;
    }
    const usage: ProviderUsage = {
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cachedInputTokens: stats.tokens.cacheRead,
      totalCostUsd: stats.cost,
      ...(typeof stats.contextUsage?.contextWindow === "number"
        ? { contextWindowMaxTokens: stats.contextUsage.contextWindow }
        : {}),
      ...(typeof stats.contextUsage?.tokens === "number"
        ? { contextWindowUsedTokens: stats.contextUsage.tokens }
        : {}),
    };
    this.emit({
      type: "session.usage",
      sessionId: this.sessionId,
      usage,
      ...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
    });
  }

  private handleSessionEvent(event: PiAgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        if (!this.activeTurnId) return;
        this.activeTurnStarted = true;
        return;
      case "turn_start":
        if (!this.activeTurnId) return;
        this.activeTurnStarted = true;
        return;
      case "message_start":
        if ((event.message as { role?: string }).role === "assistant") {
          this.activeAssistantMessageId =
            optionalString(
              (event.message as unknown as Record<string, unknown>).responseId,
            ) ?? randomUUID();
          this.activeAssistantText = "";
          this.activeReasoningId = `${this.activeAssistantMessageId}:reasoning`;
          this.activeReasoningText = "";
        }
        return;
      case "message_end":
        this.handleMessageEnd(event as { message: PiAgentMessage });
        return;
      case "message_update":
        this.handleMessageUpdate(event as never);
        return;
      case "tool_execution_start": {
        const toolCall = parseToolArgs(event.toolName, event.args);
        this.activeToolCalls.set(event.toolCallId, toolCall);
        this.emitToolCallEvent(event.toolCallId, toolCall, "running", null, null);
        return;
      }
      case "tool_execution_update": {
        const toolCall = this.activeToolCalls.get(event.toolCallId);
        if (!toolCall) {
          return;
        }
        const partialResult = parseToolResult(event.partialResult);
        this.emitToolCallEvent(event.toolCallId, toolCall, "running", partialResult, null);
        return;
      }
      case "tool_execution_end":
        this.handleToolExecutionEnd(event);
        this.emitUsage();
        return;
      case "compaction_start":
        this.emit({
          type: "timeline.item",
          sessionId: this.sessionId,
          item: {
            type: "compaction",
            id: PI_COMPACTION_ITEM_ID,
            status: "loading",
            trigger: event.reason === "manual" ? "manual" : "auto",
          },
        });
        return;
      case "compaction_end":
        this.emit({
          type: "timeline.item",
          sessionId: this.sessionId,
          item: {
            type: "compaction",
            id: PI_COMPACTION_ITEM_ID,
            status: "completed",
            trigger: event.reason === "manual" ? "manual" : "auto",
          },
        });
        return;
      case "auto_retry_start":
        this.emit({
          type: "timeline.item",
          sessionId: this.sessionId,
          item: {
            type: "error",
            id: `retry:${randomUUID()}`,
            message: `Provider retry (attempt ${event.attempt}): ${event.errorMessage}`,
          },
        });
        return;
      case "entry_appended":
        this.handleEntryAppended(event.entry);
        return;
      case "agent_end":
        if (!this.activeTurnId && !this.activeTurnStarted) return;
        this.pendingSettledMessages = (event.messages ?? []) as unknown as PiAgentMessage[];
        if (!event.willRetry) {
          this.completeTurn(this.activeTurnId ?? undefined, this.pendingSettledMessages);
        }
        return;
      case "agent_settled":
        if (!this.activeTurnId && !this.activeTurnStarted) return;
        this.completeTurn(this.activeTurnId ?? undefined, this.pendingSettledMessages ?? []);
        return;
      default:
        return;
    }
  }

  private handleEntryAppended(entry: unknown): void {
    if (!isRecord(entry) || entry.type !== "message") {
      return;
    }
    const message = entry.message;
    if (!isRecord(message) || message.role !== "user") {
      return;
    }
    this.emitPersistedUserMessage(entry, message);
  }

  private emitPersistedUserMessage(entry: Record<string, unknown>, message: Record<string, unknown>): void {
    const entryId = optionalString(entry.id);
    if (!entryId || this.emittedUserEntryIds.has(entryId)) {
      return;
    }
    const text = getUserMessageText(
      message.content as Extract<PiAgentMessage, { role: "user" }>["content"],
    );
    if (!text) {
      return;
    }
    this.emittedUserEntryIds.add(entryId);
    const pendingSteer = this.takePendingSteerSubmission(text);
    const clientMessageId = pendingSteer
      ? pendingSteer.clientMessageId
      : this.activeClientMessageId;
    this.emit({
      type: "timeline.item",
      sessionId: this.sessionId,
      item: {
        type: "user_message",
        id: entryId,
        text,
        messageId: entryId,
        revertToken: entryId,
        ...(clientMessageId ? { clientMessageId } : {}),
      },
    });
  }

  private emitUserMessageAfterPersistence(
    message: Extract<PiAgentMessage, { role: "user" }>,
  ): void {
    queueMicrotask(() => {
      const entry = this.sessionManager.getEntries().find((candidate) => {
        if (!isRecord(candidate) || candidate.type !== "message") return false;
        return candidate.message === message;
      });
      if (isRecord(entry)) {
        this.emitPersistedUserMessage(entry, message as unknown as Record<string, unknown>);
      }
    });
  }

  private handleMessageEnd(event: { message: PiAgentMessage }): void {
    if (event.message.role === "user") {
      this.emitUserMessageAfterPersistence(event.message);
      return;
    }
    if (event.message.role === "assistant") {
      this.activeAssistantMessageId = null;
      this.activeReasoningId = null;
      this.emitUsage();
      return;
    }
    if (event.message.role === "custom") {
      const text = getUserMessageText(event.message.content);
      if (text) {
        this.emit({
          type: "timeline.item",
          sessionId: this.sessionId,
          item: { type: "assistant_message", id: `custom:${randomUUID()}`, text },
        });
      }
    }
  }

  private handleMessageUpdate(event: {
    message?: PiAgentMessage;
    assistantMessageEvent: { type: string; delta?: string };
  }): void {
    if (event.message && event.message.role !== "assistant") {
      return;
    }
    if (event.assistantMessageEvent.type === "text_delta") {
      this.activeAssistantMessageId ??=
        (event.message?.role === "assistant" && event.message.responseId) || randomUUID();
      this.activeAssistantText += event.assistantMessageEvent.delta ?? "";
      this.emit({
        type: "timeline.item",
        sessionId: this.sessionId,
        item: {
          type: "assistant_message",
          id: this.activeAssistantMessageId,
          text: this.activeAssistantText,
          messageId: this.activeAssistantMessageId,
        },
      });
      return;
    }
    if (event.assistantMessageEvent.type === "thinking_delta") {
      this.activeReasoningId ??= `${randomUUID()}:reasoning`;
      this.activeReasoningText += event.assistantMessageEvent.delta ?? "";
      this.emit({
        type: "timeline.item",
        sessionId: this.sessionId,
        item: {
          type: "reasoning",
          id: this.activeReasoningId,
          text: this.activeReasoningText,
        },
      });
    }
  }

  private emitToolCallEvent(
    toolCallId: string,
    toolCall: PiTrackedToolCall,
    status: "running" | "completed" | "failed",
    result: PiToolResult,
    error: unknown,
  ): void {
    const detail = mapToolDetail(toolCall, result);
    const baseItem = {
      type: "tool_call" as const,
      id: toolCallId,
      callId: toolCallId,
      name: resolveToolCallName(toolCall, result),
      detail,
    };
    const item =
      status === "failed"
        ? { ...baseItem, status, error: (error ?? "Tool call failed") as never }
        : { ...baseItem, status, error: null };
    this.emit({ type: "timeline.item", sessionId: this.sessionId, item });
  }

  private handleToolExecutionEnd(event: {
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError?: boolean;
  }): void {
    const toolCall =
      this.activeToolCalls.get(event.toolCallId) ?? parseToolArgs(event.toolName, null);
    this.activeToolCalls.delete(event.toolCallId);

    const result = parseToolResult(event.result);
    const error = event.isError ? event.result : null;
    const status = event.isError ? "failed" : "completed";
    this.emitToolCallEvent(event.toolCallId, toolCall, status, result, error);

    if (TODO_TOOL_NAMES.has(event.toolName)) {
      const todos = extractTodoSnapshot(toolCall, result);
      if (todos) {
        this.emit({
          type: "timeline.item",
          sessionId: this.sessionId,
          item: {
            type: "todo",
            id: PI_TODO_TIMELINE_ITEM_ID,
            items: todos.map((todo) => ({
              text: todo.text,
              completed: todo.status === "completed",
              ...(todo.id ? { id: todo.id } : {}),
              status: todo.status,
              ...(todo.activeForm ? { activeForm: todo.activeForm } : {}),
            })),
          },
        });
      }
    }
  }

  private completeTurn(turnId: string | undefined, messages: readonly PiAgentMessage[]): void {
    const errorMessage = latestPiErrorMessage(messages);
    if (
      this.interruptingTurn &&
      this.interruptingTurn.turnId === turnId &&
      (errorMessage || isAbortedTerminalResponse(messages))
    ) {
      // Interrupted on purpose: swallow the abort-shaped terminal error.
      this.interruptingTurn = null;
      this.resetTurnState();
      this.emitUsage();
      this.refreshState();
      return;
    }
    this.interruptingTurn = null;
    const finalTurnId = turnId ?? randomUUID();
    this.resetTurnState();
    if (errorMessage) {
      this.emit({
        type: "session.turn",
        sessionId: this.sessionId,
        turnId: finalTurnId,
        state: "failed",
        error: { message: errorMessage },
      });
    } else {
      this.emit({
        type: "session.turn",
        sessionId: this.sessionId,
        turnId: finalTurnId,
        state: "completed",
      });
    }
    this.emitUsage();
    try {
      const active = readActivePresetName(this.sessionManager.getBranch());
      if (active !== this.currentMode) {
        this.currentMode = active;
      }
    } catch {
      // best-effort
    }
    this.refreshState();
  }
}
