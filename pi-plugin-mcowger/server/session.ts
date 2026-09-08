import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ProviderCommand,
  ProviderConfigChanges,
  ProviderConfigState,
  ProviderError,
  ProviderEvent,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";

import type {
  PiAgentMessage,
  PiAgentSessionEvent,
  PiImageContent,
  PiModel,
  PiRuntimeEvent,
  PiSessionState,
} from "../shared/rpc-types.js";
import {
  PASEO_PI_CAPTURE_EXTENSION_COMMAND,
  PASEO_PI_COMMAND_RESULT_MARKER,
  PASEO_PI_ENTRY_CAPTURE_MARKER,
  PASEO_PI_SUBMITTED_USER_ENTRY_MARKER,
  PASEO_PI_TREE_EXTENSION_COMMAND,
} from "./extension.js";
import { getUserMessageText, PiHistoryMapper } from "./history-mapper.js";
import { presetsToModes, readActivePresetName, type PiPresetsConfig } from "./presets.js";
import type { PiRuntimeSession } from "./runtime.js";
import {
  DEFAULT_PI_THINKING_LEVEL,
  clampThinkingLevel,
  mapPiModel,
  normalizePiThinkingLevel,
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
import { extractTodoSnapshot, PI_TODO_TIMELINE_ITEM_ID } from "./todo.js";
import { PiUsagePoller, type PiUsagePollScheduler } from "./usage-poller.js";

const DEFAULT_PI_EXTENSION_RESULT_TIMEOUT_MS = 30_000;
const QUESTION_RESPONSE_HEADER = "Response";
const QUESTION_COMMENT_HEADER = "Comment";
const PI_ASK_USER_FREEFORM_SENTINEL = "✏️ Type custom response...";
const COMBINED_ASK_USER_METADATA = "ask_user_select_optional_comment";
const PI_COMPACTION_ITEM_ID = "pi-compaction";

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

interface PiPromptPayload {
  text: string;
  images?: PiImageContent[];
}

interface PiModelReference {
  provider?: string;
  id: string;
}

interface PiCapturedEntry {
  id: string;
  parentId: string | null;
  text: string;
}

interface PendingExtensionResult {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveAskUserDialog {
  allowComment: boolean;
  allowFreeform: boolean;
  allowMultiple: boolean;
}

interface PendingCombinedAskUserResponse {
  comment: string;
  freeform: string | null;
}

interface PiSlashCommandInvocation {
  commandName: string;
  args?: string;
}

interface PiPendingSteerSubmission {
  text: string;
  clientMessageId: string | null;
}

export interface PiProviderSessionOptions {
  sessionId: string;
  runtimeSession: PiRuntimeSession;
  config: ProviderSessionConfig;
  initialState: PiSessionState;
  piModels: PiModel[];
  presets?: PiPresetsConfig;
  initialMode?: string | null;
  emit(event: ProviderEvent): void;
  onRuntimeFailed(error: ProviderError): void;
  cleanup?: () => void;
  extensionTimeoutMs?: number;
  usagePollScheduler?: PiUsagePollScheduler;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function toNotificationLevel(value: unknown): "info" | "warning" | "error" {
  if (value === "info" || value === "warning" || value === "error") {
    return value;
  }
  return "info";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function modelToId(model: PiModel | null | undefined): string | null {
  return model?.provider && model.id ? `${model.provider}/${model.id}` : null;
}

function parseModelReference(modelId: string | null): PiModelReference | null {
  if (!modelId) {
    return null;
  }
  if (modelId.includes("/")) {
    const [provider, ...rest] = modelId.split("/");
    const id = rest.join("/");
    if (provider && id) {
      return { provider, id };
    }
  }
  if (modelId.includes(":")) {
    const [provider, ...rest] = modelId.split(":");
    const id = rest.join(":");
    if (provider && id) {
      return { provider, id };
    }
  }
  return { id: modelId };
}

function parseExtensionMarkerPayload(
  message: string,
  marker: string,
): Record<string, unknown> | null {
  const prefix = `${marker} `;
  if (!message.startsWith(prefix)) {
    return null;
  }
  try {
    const parsed = JSON.parse(message.slice(prefix.length)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseCapturedEntries(value: unknown): PiCapturedEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): PiCapturedEntry[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = optionalString(entry.id)?.trim();
    const text = optionalString(entry.text);
    if (!id || text === undefined) {
      return [];
    }
    const parentId = entry.parentId === null ? null : optionalString(entry.parentId)?.trim();
    return [{ id, parentId: parentId || null, text }];
  });
}

function piModelSupportsImageInput(model: PiModel | null | undefined): boolean {
  return model?.input?.includes("image") === true;
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
  const forwardImages = piModelSupportsImageInput(options.model);

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

function readActiveAskUserDialog(toolName: string, args: unknown): ActiveAskUserDialog | null {
  if (toolName !== "ask_user" || !isRecord(args)) {
    return null;
  }
  return {
    allowComment: optionalBoolean(args.allowComment) ?? false,
    allowFreeform: optionalBoolean(args.allowFreeform) ?? true,
    allowMultiple: optionalBoolean(args.allowMultiple) ?? false,
  };
}

function isOptionalInputPlaceholder(placeholder: string | undefined): boolean {
  return /\boptional\b|\bskip\b/i.test(placeholder ?? "");
}

function getInputQuestionTitle(title: string | undefined, placeholder: string | undefined): string {
  if (!isOptionalInputPlaceholder(placeholder)) {
    return title ?? "Enter a value";
  }
  if (/\bcomment\b/i.test(`${title ?? ""}\n${placeholder ?? ""}`)) {
    return "Optional comment";
  }
  return "Optional response";
}

function isPiAskUserFreeformOption(option: string): boolean {
  return option === PI_ASK_USER_FREEFORM_SENTINEL;
}

function buildQuestionPermission(
  event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
  input: {
    question: string;
    options: string[];
    multiSelect: boolean;
    placeholder?: string;
    allowEmpty?: boolean;
    dismissLabel?: string;
  },
): ProviderPermissionRequest {
  return {
    id: event.id,
    name: `Pi ${event.method}`,
    kind: "question",
    title: input.question,
    input: {
      questions: [
        {
          question: input.question,
          header: QUESTION_RESPONSE_HEADER,
          options: input.options.map((label) => ({ label })),
          multiSelect: input.multiSelect,
          ...(input.placeholder ? { placeholder: input.placeholder } : {}),
          ...(input.allowEmpty ? { allowEmpty: true } : {}),
          ...(input.dismissLabel ? { dismissLabel: input.dismissLabel } : {}),
        },
      ],
    },
    metadata: {
      extensionUiMethod: event.method,
      answerHeader: QUESTION_RESPONSE_HEADER,
    },
  };
}

function buildCombinedAskUserPermission(
  event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
  input: { question: string; options: string[]; allowFreeform: boolean },
): ProviderPermissionRequest {
  const visibleOptions = input.options.filter((option) => !isPiAskUserFreeformOption(option));
  const allowOther = input.allowFreeform || visibleOptions.length !== input.options.length;
  return {
    id: event.id,
    name: "Pi ask_user",
    kind: "question",
    title: input.question,
    input: {
      questions: [
        {
          question: input.question,
          header: QUESTION_RESPONSE_HEADER,
          options: visibleOptions.map((label) => ({ label })),
          multiSelect: false,
          ...(allowOther ? { allowOther: true } : {}),
        },
        {
          question: "Optional comment",
          header: QUESTION_COMMENT_HEADER,
          options: [],
          multiSelect: false,
          placeholder: "Optional comment (press Enter to skip)...",
          allowEmpty: true,
        },
      ],
    },
    metadata: {
      extensionUiMethod: event.method,
      answerHeader: QUESTION_RESPONSE_HEADER,
      commentHeader: QUESTION_COMMENT_HEADER,
      combinedAskUser: COMBINED_ASK_USER_METADATA,
      selectOptions: visibleOptions,
      ...(allowOther ? { freeformSentinel: PI_ASK_USER_FREEFORM_SENTINEL } : {}),
    },
  };
}

function mapExtensionUiRequestToPermission(
  event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
  options: { combineOptionalComment?: boolean; allowFreeform?: boolean } = {},
): ProviderPermissionRequest | null {
  switch (event.method) {
    case "select": {
      const selectOptions = readStringArray(event.options);
      if (options.combineOptionalComment) {
        return buildCombinedAskUserPermission(event, {
          question: optionalString(event.title) ?? "Select an option",
          options: selectOptions,
          allowFreeform: options.allowFreeform === true,
        });
      }
      return buildQuestionPermission(event, {
        question: optionalString(event.title) ?? "Select an option",
        options: selectOptions,
        multiSelect: false,
      });
    }
    case "input": {
      const placeholder = optionalString(event.placeholder);
      const title = optionalString(event.title);
      const allowEmpty = isOptionalInputPlaceholder(placeholder);
      return buildQuestionPermission(event, {
        question: getInputQuestionTitle(title, placeholder),
        options: [],
        multiSelect: false,
        ...(placeholder ? { placeholder } : {}),
        ...(allowEmpty ? { allowEmpty: true, dismissLabel: "Skip" } : {}),
      });
    }
    case "editor":
      return buildQuestionPermission(event, {
        question: optionalString(event.title) ?? "Edit text",
        options: [],
        multiSelect: false,
      });
    case "confirm":
      return buildQuestionPermission(event, {
        question: [optionalString(event.title), optionalString(event.message)]
          .filter(Boolean)
          .join("\n\n"),
        options: ["Yes", "No"],
        multiSelect: false,
      });
    default:
      return null;
  }
}

function permissionAnswer(input: Record<string, unknown> | undefined, header: string): string | null {
  const answers = isRecord(input?.answers) ? input.answers : null;
  if (!answers) {
    return null;
  }
  const answer = answers[header];
  return typeof answer === "string" ? answer : null;
}

function firstPermissionAnswer(input: Record<string, unknown> | undefined): string | null {
  const answers = isRecord(input?.answers) ? input.answers : null;
  if (!answers) {
    return null;
  }
  const first = Object.values(answers).find((value) => typeof value === "string");
  return typeof first === "string" ? first : null;
}

function isCombinedAskUserPermission(request: ProviderPermissionRequest): boolean {
  return request.metadata?.combinedAskUser === COMBINED_ASK_USER_METADATA;
}

function buildCombinedAskUserSelectionResponse(
  request: ProviderPermissionRequest,
  response: Extract<ProviderPermissionResponse, { behavior: "allow" }>,
): {
  uiResponse: { value?: string; cancelled?: boolean };
  pendingResponse: PendingCombinedAskUserResponse | null;
} {
  const answer = permissionAnswer(response.updatedInput, QUESTION_RESPONSE_HEADER);
  if (answer === null) {
    return { uiResponse: { cancelled: true }, pendingResponse: null };
  }

  const selectOptions = readStringArray(request.metadata?.selectOptions);
  const freeformSentinel = optionalString(request.metadata?.freeformSentinel);
  const isFreeform = Boolean(freeformSentinel) && !selectOptions.includes(answer);
  const comment = permissionAnswer(response.updatedInput, QUESTION_COMMENT_HEADER) ?? "";
  return {
    uiResponse: { value: isFreeform ? freeformSentinel : answer },
    pendingResponse: {
      comment,
      freeform: isFreeform ? answer : null,
    },
  };
}

function buildExtensionUiResponse(
  request: ProviderPermissionRequest,
  response: ProviderPermissionResponse,
): { value?: string; confirmed?: boolean; cancelled?: boolean } {
  if (response.behavior === "deny") {
    return { cancelled: true };
  }

  const method = optionalString(request.metadata?.extensionUiMethod);
  const answer = firstPermissionAnswer(response.updatedInput);
  if (answer === null) {
    return { cancelled: true };
  }

  if (method === "confirm") {
    return { confirmed: /^yes$/i.test(answer.trim()) };
  }
  return { value: answer };
}

function piAssistantText(message: Extract<PiAgentMessage, { role: "assistant" }>): string | null {
  const text = message.content
    .flatMap((part) => {
      if (part.type === "text") {
        return [part.text];
      }
      if (part.type === "thinking") {
        return [part.thinking];
      }
      return [];
    })
    .join("\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

function formatPiErrorMessage(message: Extract<PiAgentMessage, { role: "assistant" }>): string {
  const headline = message.errorMessage?.trim() || "Pi turn failed";
  const details = [
    message.stopReason ? `stopReason=${message.stopReason}` : null,
    message.provider && message.model ? `model=${message.provider}/${message.model}` : null,
    message.responseModel ? `responseModel=${message.responseModel}` : null,
    message.responseId ? `responseId=${message.responseId}` : null,
  ].filter((detail): detail is string => detail !== null);
  const partialText = piAssistantText(message);
  if (partialText) {
    details.push(`partial=${JSON.stringify(partialText.slice(0, 500))}`);
  }
  return details.length > 0 ? `${headline} (${details.join(", ")})` : headline;
}

function latestPiErrorMessage(messages: PiAgentMessage[]): string | null {
  const latestAssistant = messages.findLast((message) => message.role === "assistant");
  if (!latestAssistant || !latestAssistant.errorMessage?.trim()) {
    return null;
  }
  return formatPiErrorMessage(latestAssistant);
}

function isPiAbortedTerminalResponse(messages: PiAgentMessage[]): boolean {
  const latestAssistant = messages.findLast((message) => message.role === "assistant");
  return latestAssistant?.stopReason?.toLowerCase() === "aborted";
}

function isPiAgentSessionEvent(event: PiRuntimeEvent): event is PiAgentSessionEvent {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "message_start":
    case "message_end":
    case "message_update":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "compaction_start":
    case "compaction_end":
    case "agent_end":
    case "agent_settled":
    case "auto_retry_start":
      return true;
    default:
      return false;
  }
}

export class PiProviderSession {
  private readonly sessionId: string;
  private readonly runtimeSession: PiRuntimeSession;
  private readonly config: ProviderSessionConfig;
  private readonly emitEvent: (event: ProviderEvent) => void;
  private readonly onRuntimeFailed: (error: ProviderError) => void;
  private readonly cleanup?: () => void;
  private readonly extensionTimeoutMs: number;
  private readonly usagePoller: PiUsagePoller;

  private state: PiSessionState;
  private piModels: PiModel[];
  private readonly presets: PiPresetsConfig;
  private currentMode: string | null;
  private lastConfigStateJson: string | null = null;
  private lastPersistenceJson: string | null = null;

  private readonly activeToolCalls = new Map<string, PiTrackedToolCall>();
  private readonly pendingExtensionUiRequests = new Map<string, ProviderPermissionRequest>();
  private activeAskUserDialog: ActiveAskUserDialog | null = null;
  private pendingCombinedAskUserResponse: PendingCombinedAskUserResponse | null = null;
  private activeTurnId: string | null = null;
  private activeClientMessageId: string | null = null;
  private activeAssistantMessageId: string | null = null;
  private activeAssistantText = "";
  private activeReasoningId: string | null = null;
  private activeReasoningText = "";
  private activeTurnStarted = false;
  private pendingSettledMessages: PiAgentMessage[] | null = null;
  private activeNoTurnPromptText: string | null = null;
  private readonly pendingNoTurnOutputs: Array<{ turnId: string; message: string }> = [];
  private activePromptRequestId: string | null = null;
  private readonly pendingPromptResults = new Map<string, boolean>();
  private readonly pendingSteerSubmissions: PiPendingSteerSubmission[] = [];
  private readonly capturedUserEntries: PiCapturedEntry[] = [];
  private readonly capturedUserEntriesById = new Map<string, PiCapturedEntry>();
  private readonly pendingExtensionResults = new Map<string, PendingExtensionResult>();
  private commandCache: ProviderCommand[] | null = null;
  private closed = false;
  private interruptingTurn: { turnId: string | undefined; error: string | null } | null = null;

  constructor(options: PiProviderSessionOptions) {
    this.sessionId = options.sessionId;
    this.runtimeSession = options.runtimeSession;
    this.config = options.config;
    this.state = options.initialState;
    this.piModels = options.piModels;
    this.presets = options.presets ?? {};
    this.currentMode = options.initialMode ?? null;
    this.emitEvent = options.emit;
    this.onRuntimeFailed = options.onRuntimeFailed;
    this.cleanup = options.cleanup;
    this.extensionTimeoutMs =
      options.extensionTimeoutMs ?? DEFAULT_PI_EXTENSION_RESULT_TIMEOUT_MS;

    this.usagePoller = new PiUsagePoller({
      scheduler: options.usagePollScheduler,
      readStats: () => this.runtimeSession.getSessionStats(),
      onUsage: (usage, turnId) => {
        this.emit({
          type: "session.usage",
          sessionId: this.sessionId,
          usage,
          ...(turnId === undefined ? {} : { turnId }),
        });
      },
      onPollError: () => {
        // Usage polling is best-effort.
      },
    });

    this.runtimeSession.onEvent((event) => {
      this.handleRuntimeEvent(event);
    });
  }

  get persistence(): ProviderPersistence {
    return {
      version: 1,
      data: {
        sessionFile: this.state.sessionFile ?? null,
        cwd: this.config.cwd,
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.thinkingOption ? { thinkingOption: this.config.thinkingOption } : {}),
      },
    };
  }

  configState(): ProviderConfigState {
    const currentModelId = modelToId(this.state.model);
    const currentPiModel = this.currentPiModel();
    return {
      ...(currentModelId ? { model: currentModelId } : {}),
      models: this.piModels.map((model) => mapPiModel(model)),
      modes: presetsToModes(this.presets),
      ...(this.currentMode && this.presets[this.currentMode]
        ? { mode: this.currentMode }
        : {}),
      thinkingOption: normalizePiThinkingLevel(this.state.thinkingLevel) ?? undefined,
      thinkingOptions: currentPiModel ? (thinkingOptionsForModel(currentPiModel) ?? []) : [],
      settings: [],
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

  async refreshState(): Promise<void> {
    this.state = await this.runtimeSession.getState();
    this.emitConfigState();
    this.emitPersistence();
  }

  async listCommands(): Promise<ProviderCommand[]> {
    if (this.commandCache) {
      return this.commandCache;
    }
    const commands = await this.runtimeSession.getCommands();
    const mapped = commands
      .filter(
        (command) =>
          command.name !== PASEO_PI_CAPTURE_EXTENSION_COMMAND &&
          command.name !== PASEO_PI_TREE_EXTENSION_COMMAND &&
          !command.name.startsWith("paseo_"),
      )
      .map((command) => ({
        name: command.name,
        description: command.description ?? command.source,
        ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
      }));
    this.commandCache = mapped;
    return mapped;
  }

  async replayHistory(): Promise<void> {
    await this.requestEntryCapture("history");
    const messages = await this.runtimeSession.getMessages();
    const mapper = new PiHistoryMapper(this.capturedUserEntries);
    for (const item of mapper.mapMessages(messages)) {
      this.emit({ type: "timeline.item", sessionId: this.sessionId, item });
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

    const payload =
      prompt.input.type === "command"
        ? { text: `/${prompt.input.name}${prompt.input.arguments ? ` ${prompt.input.arguments}` : ""}` }
        : convertPromptInput(prompt.input, { model: this.state.model });
    const slashInvocation = this.parseSlashCommandInput(payload.text);

    if (prompt.delivery === "steer" && this.activeTurnId && !slashInvocation) {
      await this.steerActiveTurn(payload, prompt);
      return;
    }

    if (prompt.delivery === "steer" && this.activeTurnId && slashInvocation) {
      // Pi rejects steer RPCs that are extension commands: interrupt the active
      // turn and run the command as a fresh prompt instead.
      await this.interrupt();
    }

    await this.startTurn(payload, prompt, slashInvocation !== null);
  }

  private async steerActiveTurn(
    payload: PiPromptPayload,
    prompt: ProviderPrompt,
  ): Promise<void> {
    const turnId = this.activeTurnId;
    try {
      await this.runtimeSession.steer(payload.text, payload.images);
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
      await this.clearPendingPermissionsForSteer();
    }
    this.emitPromptResult(prompt.clientMessageId, { type: "steer", turnId });
  }

  private async startTurn(
    payload: PiPromptPayload,
    prompt: ProviderPrompt,
    shouldProbeForNoTurnPrompt: boolean,
  ): Promise<void> {
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    this.usagePoller.startTurn();
    this.activeClientMessageId = prompt.clientMessageId;
    this.activeAssistantMessageId = null;
    this.activeAssistantText = "";
    this.activeReasoningId = null;
    this.activeReasoningText = "";
    this.activeTurnStarted = false;
    this.pendingSettledMessages = null;
    this.activePromptRequestId = null;
    this.pendingSteerSubmissions.length = 0;
    this.clearNoTurnBuffers();
    this.activeNoTurnPromptText = payload.text;

    this.emitPromptResult(prompt.clientMessageId, { type: "turn", turnId });
    this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "started" });

    void (async () => {
      try {
        const ack = await this.runtimeSession.prompt(payload.text, payload.images);
        this.activePromptRequestId = ack.requestId ?? null;
        const correlatedResult = ack.requestId
          ? this.pendingPromptResults.get(ack.requestId)
          : undefined;
        if (ack.requestId) {
          this.pendingPromptResults.delete(ack.requestId);
        }
        const agentInvoked = correlatedResult ?? ack.agentInvoked;
        if (agentInvoked === false) {
          await this.completeNoTurnPrompt(turnId);
          return;
        }
        if (agentInvoked === undefined && shouldProbeForNoTurnPrompt) {
          await this.completePromptIfHandledWithoutTurn(turnId);
        }
      } catch (error) {
        if (this.activeTurnId !== turnId) {
          return;
        }
        this.resetTurnState();
        if (/\brequest was aborted\b|\babort(ed)?\b/i.test(toErrorMessage(error))) {
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
    const interruption: typeof this.interruptingTurn =
      this.activeTurnId || this.activeTurnStarted ? { turnId, error: null } : null;
    this.interruptingTurn = interruption;
    try {
      await this.runtimeSession.clearQueue();
      await this.runtimeSession.abort();
    } catch (error) {
      const terminalError = this.interruptingTurn === interruption ? interruption?.error : null;
      if (this.interruptingTurn === interruption) {
        this.interruptingTurn = null;
      }
      if (terminalError) {
        this.resetTurnState();
        this.emit({
          type: "session.turn",
          sessionId: this.sessionId,
          turnId: turnId ?? randomUUID(),
          state: "failed",
          error: { message: terminalError },
        });
      }
      throw error;
    }
    if (
      interruption &&
      this.interruptingTurn === interruption &&
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
    if (this.interruptingTurn === interruption) {
      this.interruptingTurn = null;
    }
  }

  respondToPermission(requestId: string, response: ProviderPermissionResponse): void {
    const request = this.pendingExtensionUiRequests.get(requestId);
    if (!request) {
      throw new Error(`No pending permission request with id '${requestId}'`);
    }
    this.pendingExtensionUiRequests.delete(requestId);

    if (isCombinedAskUserPermission(request) && response.behavior === "allow") {
      const combined = buildCombinedAskUserSelectionResponse(request, response);
      this.pendingCombinedAskUserResponse = combined.pendingResponse;
      this.runtimeSession.respondToExtensionUiRequest(requestId, combined.uiResponse);
    } else {
      this.runtimeSession.respondToExtensionUiRequest(
        requestId,
        buildExtensionUiResponse(request, response),
      );
    }
    this.emit({
      type: "session.permission_resolved",
      sessionId: this.sessionId,
      permissionId: requestId,
    });
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    if (changes.mode) {
      await this.applyPreset(changes.mode);
    }
    if (changes.model) {
      const parsedReference = parseModelReference(changes.model);
      if (!parsedReference?.provider) {
        throw new Error(`Pi model id must include a provider: ${changes.model}`);
      }
      const model = await this.runtimeSession.setModel(
        parsedReference.provider,
        parsedReference.id,
      );
      this.state = { ...this.state, model };
      this.config.model = modelToId(model) ?? this.config.model;
      this.upsertPiModel(model);
    }
    if (changes.thinkingOption !== undefined) {
      const level =
        normalizePiThinkingLevel(changes.thinkingOption) ?? DEFAULT_PI_THINKING_LEVEL;
      const clamped = this.clampToCurrentModel(level);
      await this.runtimeSession.setThinkingLevel(clamped);
      this.state = { ...this.state, thinkingLevel: clamped as PiSessionState["thinkingLevel"] };
      this.config.thinkingOption = clamped;
    }
    // Pi may clamp requested levels; always re-read the effective state.
    await this.refreshState();
  }

  /**
   * Activate a pi preset. Forwards the extension's slash command (tools +
   * instructions), then applies the preset's model and thinking level through
   * direct RPCs so the reported state is deterministic even if slash-command
   * handling is asynchronous. Emits config via refreshState() afterwards.
   */
  async applyPreset(name: string): Promise<void> {
    const preset = this.presets[name];
    if (!preset) {
      const available = Object.keys(this.presets).join(", ") || "(none defined)";
      throw new Error(`Unknown pi preset "${name}". Available: ${available}`);
    }
    await this.runtimeSession.prompt(`/preset ${name}`);
    if (preset.provider && preset.model) {
      const model = await this.runtimeSession.setModel(preset.provider, preset.model);
      this.state = { ...this.state, model };
      this.upsertPiModel(model);
    }
    if (preset.thinkingLevel) {
      const level = normalizePiThinkingLevel(preset.thinkingLevel);
      if (level) {
        await this.runtimeSession.setThinkingLevel(level);
        this.state = { ...this.state, thinkingLevel: level };
      }
    }
    this.currentMode = name;
    // Re-read effective state: pi may have clamped the thinking level for the
    // preset's model, and the slash command may have applied its own changes.
    this.state = await this.runtimeSession.getState();
    if (this.state.model) {
      this.upsertPiModel(this.state.model);
    }
  }

  /**
   * Re-read the active preset from pi's session entries (the preset extension
   * appends a preset-state custom entry on every turn while one is active).
   */
  async syncPresetFromEntries(): Promise<void> {
    if (Object.keys(this.presets).length === 0) {
      return;
    }
    try {
      const { entries } = await this.runtimeSession.getEntries();
      const active = readActivePresetName(entries);
      if (active !== this.currentMode) {
        this.currentMode = active;
        this.emitConfigState();
      }
    } catch {
      // Entry reading is best-effort.
    }
  }

  async revertConversation(token: unknown): Promise<void> {
    if (this.activeTurnId) {
      throw new Error("Cannot rewind the Pi conversation while a turn is active");
    }
    const messageId = typeof token === "string" ? token.trim() : "";
    if (!messageId) {
      throw new Error("Pi rewind requires a user message id revert token");
    }
    await this.refreshState().catch(() => undefined);
    await this.requestEntryCapture("rewind");
    if (!this.capturedUserEntriesById.has(messageId)) {
      throw new Error(`Pi rewind target ${messageId} was not found in captured tree entries`);
    }
    await this.runPiTreeExtensionCommand(messageId);
    this.activeToolCalls.clear();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.usagePoller.close();
    try {
      await this.runtimeSession.close();
    } finally {
      this.rejectAllExtensionResults(new Error("Pi session closed"));
      this.cleanup?.();
    }
  }

  private currentPiModel(): PiModel | null | undefined {
    const current = this.state.model;
    if (!current) {
      return null;
    }
    return (
      this.piModels.find(
        (model) => model.provider === current.provider && model.id === current.id,
      ) ?? current
    );
  }

  private upsertPiModel(model: PiModel): void {
    const index = this.piModels.findIndex(
      (candidate) => candidate.provider === model.provider && candidate.id === model.id,
    );
    if (index === -1) {
      this.piModels = [...this.piModels, model];
    } else {
      this.piModels = this.piModels.map((candidate, i) => (i === index ? model : candidate));
    }
  }

  private clampToCurrentModel(level: string): string {
    const current = this.currentPiModel();
    if (!current) {
      return level;
    }
    const supported = supportedThinkingLevels(current);
    if (supported.length === 0) {
      return level;
    }
    const requested = normalizePiThinkingLevel(level) ?? DEFAULT_PI_THINKING_LEVEL;
    return clampThinkingLevel(requested, supported) ?? level;
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
    this.usagePoller.stopTurn();
    this.activeTurnId = null;
    this.activeClientMessageId = null;
    this.activeAssistantMessageId = null;
    this.activeAssistantText = "";
    this.activeReasoningId = null;
    this.activeReasoningText = "";
    this.activeTurnStarted = false;
    this.pendingSettledMessages = null;
    this.pendingSteerSubmissions.length = 0;
    this.clearNoTurnBuffers();
  }

  private clearNoTurnBuffers(): void {
    this.activeNoTurnPromptText = null;
    this.activePromptRequestId = null;
    this.pendingNoTurnOutputs.splice(0, this.pendingNoTurnOutputs.length);
  }

  private async completeNoTurnPrompt(turnId: string): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (this.activeTurnId !== turnId || this.activeTurnStarted) {
      return;
    }
    this.emitBufferedNoTurnOutputs(turnId);
    this.completeTurn(turnId, []);
  }

  private async completePromptIfHandledWithoutTurn(turnId: string): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    let runtimeState: PiSessionState;
    try {
      runtimeState = await this.runtimeSession.getState();
    } catch (error) {
      if (this.activeTurnId === turnId && !this.activeTurnStarted) {
        throw error;
      }
      return;
    }
    this.state = runtimeState;

    if (this.activeTurnId !== turnId || this.activeTurnStarted || runtimeState.isStreaming) {
      return;
    }

    this.emitBufferedNoTurnOutputs(turnId);
    this.completeTurn(turnId, []);
  }

  private emitBufferedNoTurnOutputs(turnId: string): void {
    const promptText = this.activeNoTurnPromptText;
    const outputs = this.pendingNoTurnOutputs.filter((output) => output.turnId === turnId);
    const clientMessageId = this.activeClientMessageId;
    this.activeNoTurnPromptText = null;
    this.activePromptRequestId = null;
    this.pendingNoTurnOutputs.splice(0, this.pendingNoTurnOutputs.length);
    if (promptText) {
      this.emit({
        type: "timeline.item",
        sessionId: this.sessionId,
        item: {
          type: "user_message",
          id: clientMessageId ?? `user:${turnId}`,
          text: promptText,
          ...(clientMessageId ? { clientMessageId } : {}),
        },
      });
    }
    for (const output of outputs) {
      this.emit({
        type: "timeline.item",
        sessionId: this.sessionId,
        item: {
          type: "assistant_message",
          id: `command-output:${turnId}`,
          text: output.message,
        },
      });
    }
  }

  private bufferNoTurnOutput(message: string): void {
    if (!this.activeTurnId || this.activeTurnStarted) {
      return;
    }
    this.pendingNoTurnOutputs.push({ turnId: this.activeTurnId, message });
  }

  private parseSlashCommandInput(text: string): PiSlashCommandInvocation | null {
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

  private async clearPendingPermissionsForSteer(): Promise<void> {
    const requestIds = Array.from(this.pendingExtensionUiRequests.keys());
    for (const requestId of requestIds) {
      if (!this.pendingExtensionUiRequests.has(requestId)) continue;
      this.respondToPermission(requestId, {
        behavior: "deny",
        message: "The user answered with a message instead of approving. Their message follows.",
      });
    }
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

  private async requestEntryCapture(reason: string): Promise<void> {
    const requestId = randomUUID();
    const resultPromise = this.waitForExtensionResult(requestId);
    const payload = Buffer.from(JSON.stringify({ requestId, reason })).toString("base64url");
    await this.runtimeSession.prompt(`/${PASEO_PI_CAPTURE_EXTENSION_COMMAND} ${payload}`);
    await resultPromise;
  }

  private async runPiTreeExtensionCommand(targetId: string): Promise<unknown> {
    const requestId = randomUUID();
    const resultPromise = this.waitForExtensionResult(requestId);
    const payload = Buffer.from(JSON.stringify({ targetId, requestId })).toString("base64url");
    await this.runtimeSession.prompt(`/${PASEO_PI_TREE_EXTENSION_COMMAND} ${payload}`);
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
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingExtensionResults.delete(requestId);
    pending.resolve(result);
  }

  private rejectExtensionResult(requestId: string, error: Error): void {
    const pending = this.pendingExtensionResults.get(requestId);
    if (!pending) {
      return;
    }
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
    if (!payload) {
      return false;
    }
    const [entry] = parseCapturedEntries([payload.entry]);
    if (!entry) {
      return true;
    }
    const pendingSteer = this.takePendingSteerSubmission(entry.text);
    const clientMessageId = pendingSteer
      ? pendingSteer.clientMessageId
      : this.activeClientMessageId;
    this.emit({
      type: "timeline.item",
      sessionId: this.sessionId,
      item: {
        type: "user_message",
        id: entry.id,
        text: entry.text,
        messageId: entry.id,
        revertToken: entry.id,
        ...(clientMessageId ? { clientMessageId } : {}),
      },
    });
    return true;
  }

  private handleEntryCaptureMarker(message: string): boolean {
    const payload = parseExtensionMarkerPayload(message, PASEO_PI_ENTRY_CAPTURE_MARKER);
    if (!payload) {
      return false;
    }
    const entries = parseCapturedEntries(payload.entries);
    this.recordCapturedUserEntries(entries);
    if (typeof payload.requestId === "string") {
      this.resolveExtensionResult(payload.requestId, entries);
    }
    return true;
  }

  private handleCommandResultMarker(message: string): boolean {
    const payload = parseExtensionMarkerPayload(message, PASEO_PI_COMMAND_RESULT_MARKER);
    if (!payload) {
      return false;
    }
    if (typeof payload.requestId !== "string") {
      return true;
    }
    if (payload.ok === true) {
      this.resolveExtensionResult(payload.requestId, payload.result);
      return true;
    }
    const error = typeof payload.error === "string" ? payload.error : "Pi extension command failed";
    this.rejectExtensionResult(payload.requestId, new Error(error));
    return true;
  }

  private handleExtensionUiRequest(
    event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
  ): void {
    const message = optionalString(event.message);
    if (event.method === "notify" && message) {
      if (
        this.handleSubmittedUserEntryMarker(message) ||
        this.handleEntryCaptureMarker(message) ||
        this.handleCommandResultMarker(message)
      ) {
        return;
      }
      this.emit({
        type: "timeline.item",
        sessionId: this.sessionId,
        item: {
          type: "notification",
          id: `notification:${randomUUID()}`,
          level: toNotificationLevel(event.notifyType),
          message,
        },
      });
      return;
    }

    if (this.respondToCombinedAskUserFollowUp(event)) {
      return;
    }

    const shouldCombineOptionalComment =
      event.method === "select" &&
      this.activeAskUserDialog?.allowComment === true &&
      this.activeAskUserDialog.allowMultiple === false;
    const request = mapExtensionUiRequestToPermission(event, {
      combineOptionalComment: shouldCombineOptionalComment,
      allowFreeform: this.activeAskUserDialog?.allowFreeform,
    });
    if (!request) {
      return;
    }

    this.pendingExtensionUiRequests.set(request.id, request);
    this.emit({ type: "session.permission", sessionId: this.sessionId, request });
  }

  private respondToCombinedAskUserFollowUp(
    event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
  ): boolean {
    const pending = this.pendingCombinedAskUserResponse;
    if (!pending || event.method !== "input") {
      return false;
    }

    const placeholder = optionalString(event.placeholder);
    if (pending.freeform !== null && !isOptionalInputPlaceholder(placeholder)) {
      const freeform = pending.freeform;
      this.pendingCombinedAskUserResponse = { ...pending, freeform: null };
      this.runtimeSession.respondToExtensionUiRequest(event.id, { value: freeform });
      return true;
    }

    if (isOptionalInputPlaceholder(placeholder)) {
      this.pendingCombinedAskUserResponse = null;
      this.runtimeSession.respondToExtensionUiRequest(event.id, { value: pending.comment });
      return true;
    }

    return false;
  }

  private handleCommandOutput(textValue: unknown): void {
    if (!this.activeTurnId) {
      return;
    }
    const text = stripAnsi(optionalString(textValue) ?? "").trim();
    if (!text) {
      return;
    }
    if (!this.activeTurnStarted) {
      this.bufferNoTurnOutput(text);
      return;
    }
    this.emit({
      type: "timeline.item",
      sessionId: this.sessionId,
      item: {
        type: "assistant_message",
        id: `command-output:${this.activeTurnId}`,
        text,
      },
    });
  }

  private handleRuntimeEvent(event: PiRuntimeEvent): void {
    if (event.type === "extension_ui_request" && typeof event.id === "string") {
      this.handleExtensionUiRequest(
        event as Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
      );
      return;
    }
    if (event.type === "process_exit" && typeof event.error === "string") {
      this.handleProcessExit(event.error);
      return;
    }
    if (event.type === "command_output") {
      this.handleCommandOutput(event.text);
      return;
    }
    if (event.type === "prompt_result") {
      const requestId = optionalString(event.id);
      const agentInvoked =
        "agentInvoked" in event && typeof event.agentInvoked === "boolean"
          ? event.agentInvoked
          : undefined;
      if (requestId && agentInvoked !== undefined) {
        if (requestId === this.activePromptRequestId && agentInvoked === false && this.activeTurnId) {
          void this.completeNoTurnPrompt(this.activeTurnId);
        } else if (this.activePromptRequestId === null) {
          this.pendingPromptResults.set(requestId, agentInvoked);
        }
      }
      return;
    }
    if (isPiAgentSessionEvent(event)) {
      this.handleSessionEvent(event);
    }
  }

  private handleProcessExit(error: string): void {
    this.rejectAllExtensionResults(new Error(error));
    this.interruptingTurn = null;
    // Deliberate shutdown (session.close, connection close): the exit is
    // expected — never report it as a runtime failure.
    if (this.closed) {
      return;
    }
    if (!this.activeTurnId && !this.activeTurnStarted) {
      this.onRuntimeFailed({ message: error });
      return;
    }
    const turnId = this.activeTurnId ?? randomUUID();
    this.resetTurnState();
    this.emit({
      type: "session.turn",
      sessionId: this.sessionId,
      turnId,
      state: "failed",
      error: { message: error },
    });
    this.onRuntimeFailed({ message: error });
  }

  private handleSessionEvent(event: PiAgentSessionEvent): void {
    if (event.type === "agent_end" || event.type === "agent_settled") {
      this.handleTurnBoundaryEvent(event);
      return;
    }

    switch (event.type) {
      case "agent_start":
        this.activeTurnStarted = true;
        this.clearNoTurnBuffers();
        return;
      case "turn_start":
        this.activeTurnStarted = true;
        this.clearNoTurnBuffers();
        return;
      case "message_start":
        if (event.message.role === "assistant") {
          this.activeAssistantMessageId = event.message.responseId || randomUUID();
          this.activeAssistantText = "";
          this.activeReasoningId = `${this.activeAssistantMessageId}:reasoning`;
          this.activeReasoningText = "";
        }
        return;
      case "message_end":
        this.handleMessageEnd(event);
        return;
      case "message_update":
        this.handleMessageUpdate(event);
        return;
      case "tool_execution_start": {
        const toolCall = parseToolArgs(event.toolName, event.args);
        this.activeToolCalls.set(event.toolCallId, toolCall);
        this.activeAskUserDialog = readActiveAskUserDialog(event.toolName, event.args);
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
      default:
        return;
    }
  }

  private handleTurnBoundaryEvent(
    event: Extract<PiAgentSessionEvent, { type: "agent_end" | "agent_settled" }>,
  ): void {
    if (!this.activeTurnId && !this.activeTurnStarted) {
      return;
    }
    if (event.type === "agent_end") {
      // pi >= 0.85 always follows agent_end with agent_settled once retries
      // (willRetry) are exhausted; only settle the turn there.
      this.pendingSettledMessages = event.messages ?? [];
      return;
    }
    this.completeTurn(this.activeTurnId ?? undefined, this.pendingSettledMessages ?? []);
  }

  private handleToolExecutionEnd(
    event: Extract<PiAgentSessionEvent, { type: "tool_execution_end" }>,
  ): void {
    const toolCall =
      this.activeToolCalls.get(event.toolCallId) ?? parseToolArgs(event.toolName, null);
    this.activeToolCalls.delete(event.toolCallId);

    if (event.toolName === "ask_user") {
      this.activeAskUserDialog = null;
      this.pendingCombinedAskUserResponse = null;
    }

    const result = parseToolResult(event.result);
    const error = event.isError ? event.result : null;
    const status = event.isError ? "failed" : "completed";
    this.emitToolCallEvent(event.toolCallId, toolCall, status, result, error);

    const todos = extractTodoSnapshot(toolCall, result);
    if (todos && todos.length > 0) {
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

  private handleMessageUpdate(
    event: Extract<PiAgentSessionEvent, { type: "message_update" }>,
  ): void {
    if (event.message && event.message.role !== "assistant") {
      return;
    }
    if (event.assistantMessageEvent.type === "text_delta") {
      // Pi-compatible runtimes may emit updates without a preceding message_start.
      this.activeAssistantMessageId ??= event.message?.responseId || randomUUID();
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

  private handleMessageEnd(event: Extract<PiAgentSessionEvent, { type: "message_end" }>): void {
    if (event.message.role === "assistant") {
      this.activeAssistantMessageId = null;
      this.activeReasoningId = null;
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
      if (!this.activeTurnStarted) {
        this.completeTurn(this.activeTurnId ?? undefined, []);
      }
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

  private completeTurn(turnId: string | undefined, messages: PiAgentMessage[]): void {
    const errorMessage = latestPiErrorMessage(messages);
    if (
      this.interruptingTurn &&
      this.interruptingTurn.turnId === turnId &&
      (errorMessage || isPiAbortedTerminalResponse(messages))
    ) {
      this.interruptingTurn.error = errorMessage ?? "Pi turn failed";
      return;
    }
    this.interruptingTurn = null;
    const finalTurnId = turnId ?? randomUUID();
    this.activeTurnId = null;
    this.activeClientMessageId = null;
    this.activeAssistantMessageId = null;
    this.activeTurnStarted = false;
    this.pendingSettledMessages = null;
    this.pendingSteerSubmissions.length = 0;
    this.clearNoTurnBuffers();
    if (typeof errorMessage === "string" && errorMessage.length > 0) {
      this.usagePoller.stopTurn();
      this.emit({
        type: "session.turn",
        sessionId: this.sessionId,
        turnId: finalTurnId,
        state: "failed",
        error: { message: errorMessage },
      });
      void this.refreshAfterTurn(Promise.resolve());
      return;
    }
    const finalUsage = this.usagePoller.completeTurn(finalTurnId);
    this.emit({
      type: "session.turn",
      sessionId: this.sessionId,
      turnId: finalTurnId,
      state: "completed",
    });
    void this.refreshAfterTurn(finalUsage);
  }

  private async refreshAfterTurn(finalUsage: Promise<void>): Promise<void> {
    await Promise.all([this.refreshState().catch(() => undefined), finalUsage]);
    await this.syncPresetFromEntries();
  }
}
