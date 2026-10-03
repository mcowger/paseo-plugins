import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ProviderConfigChanges,
  ProviderConfigState,
  ProviderEvent,
  ProviderError,
  ProviderModel,
  ProviderPermissionResponse,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderSetting,
  ProviderThinkingOption,
  ProviderCommand,
} from "@getpaseo/plugin/server/provider";
import {
  companionPrefix,
  companionStateSchema,
  contextSettingPresentation,
  tierSchema,
  type CompanionState,
} from "../shared/companion.js";
import {
  parseSubpiChildEnvelope,
  type SubpiChildEnvelope,
} from "../shared/subagents.js";
import { buildPiPrompt } from "./attachments.js";
import { createDialogBridge, type DialogBridge, type DialogRegistry } from "./dialogs.js";
import {
  buildActiveUserTokenMap,
  findActiveBranchUserEntry,
  parseNativeEntries,
  readPiTranscriptMessages,
  readPiTranscriptSnapshot,
  resolveRewindToken,
  type NativeSessionEntry,
  type RewindToken,
} from "./native-history.js";
import { createCompanionChannel } from "./companion-channel.js";
import { PiRpcTimeoutError, PiRpcTransportError, createPiRpc, type PiRecord, type PiRpc, type PiRpcOptions } from "./pi-rpc.js";
import { SessionStore } from "./persistence.js";
import { createSubagentObserver, type SubagentObserver } from "./subagents.js";
import { createTimeline, type Timeline, type TimelineContext } from "./timeline.js";

type Tier = CompanionState["settings"]["tier"];

/**
 * Stage 1 root session ownership.
 *
 * One `SuperpiSession` owns exactly one Pi `--mode rpc` process plus its durable
 * `SessionStore`. It launches Pi with normal resources and the explicit
 * companion extension, performs the companion handshake, publishes catalog
 * configuration, restores history from the streamed native transcript (with a
 * lifetime-RPC fallback only for ephemeral sessions), and folds Pi records into
 * Paseo provider events through the pure timeline.
 */

export const SUPERPI_SESSION_CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "session.persistence",
  "session.configure",
  "session.subsession",
  "session.revert.conversation",
  "permission",
] as const;

const DEFAULT_PI_THINKING_LEVEL = "medium";

const PI_THINKING_OPTIONS: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
}> = [
  { id: "off", label: "Off", description: "No extra reasoning" },
  { id: "minimal", label: "Minimal", description: "Light reasoning" },
  { id: "low", label: "Low", description: "Faster reasoning" },
  { id: "medium", label: "Medium", description: "Balanced reasoning" },
  { id: "high", label: "High", description: "Deeper reasoning" },
  { id: "xhigh", label: "XHigh", description: "Very deep reasoning" },
  { id: "max", label: "Max", description: "Extreme reasoning" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function modelKey(model: unknown): string | undefined {
  if (!isRecord(model)) return undefined;
  const provider = asString(model.provider);
  const id = asString(model.id);
  return provider && id ? `${provider}/${id}` : undefined;
}

function resolvePiThinkingOptions(
  model: Record<string, unknown>,
): Pick<ProviderModel, "thinkingOptions" | "defaultThinkingOptionId"> {
  if (model.reasoning !== true) return {};
  const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : undefined;
  const supported = PI_THINKING_OPTIONS.filter((option) => {
    const mapped = map?.[option.id];
    if (mapped === null) return false;
    if (option.id === "xhigh" || option.id === "max") return mapped !== undefined;
    return true;
  });
  const defaultIndex = PI_THINKING_OPTIONS.findIndex(
    (option) => option.id === DEFAULT_PI_THINKING_LEVEL,
  );
  const higherDefault = supported.find(
    (option) => PI_THINKING_OPTIONS.indexOf(option) >= defaultIndex,
  );
  const defaultOption = higherDefault ?? supported.at(-1);
  const defaultThinkingOptionId = defaultOption?.id ?? "off";
  return {
    thinkingOptions: supported.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      ...(option.id === defaultThinkingOptionId ? { isDefault: true } : {}),
    })),
    defaultThinkingOptionId,
  };
}

export function mapPiModels(
  models: readonly unknown[],
  defaultModelId?: string,
): ProviderModel[] {
  const mapped: ProviderModel[] = [];
  for (const raw of models) {
    if (!isRecord(raw)) continue;
    const provider = asString(raw.provider);
    const id = asString(raw.id);
    if (!provider || !id) continue;
    const fullId = `${provider}/${id}`;
    const name = asString(raw.name) ?? id;
    const contextWindow = typeof raw.contextWindow === "number" ? raw.contextWindow : undefined;
    const { thinkingOptions, defaultThinkingOptionId } = resolvePiThinkingOptions(raw);
    mapped.push({
      id: fullId,
      label: name,
      description: fullId,
      isSelectable: true,
      metadata: { provider, modelId: id },
      ...(contextWindow !== undefined ? { contextWindowMaxTokens: contextWindow } : {}),
      ...(thinkingOptions ? { thinkingOptions } : {}),
      ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
      ...(fullId === defaultModelId ? { isDefault: true } : {}),
    });
  }
  return mapped;
}

export function mapPiThinkingLevels(levels: readonly string[]): ProviderThinkingOption[] {
  return levels.map((id) => {
    const option = PI_THINKING_OPTIONS.find((entry) => entry.id === id);
    return {
      id,
      label: option?.label ?? id,
      description: option?.description ?? "",
    };
  });
}

const PI_RPC_COMMANDS: readonly ProviderCommand[] = [
  { name: "compact", description: "Manually compact the session context", argumentHint: "[instructions]" },
  { name: "autocompact", description: "Toggle automatic context compaction", argumentHint: "[on|off|toggle]" },
  { name: "model", description: "Set model (or use the composer picker)", argumentHint: "<provider/model>" },
  { name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
  { name: "name", description: "Set Pi session display name", argumentHint: "<name>" },
  { name: "session", description: "Show Pi session info and stats" },
];

const PI_TUI_COMMANDS = new Set([
  "settings", "tree", "scoped-models", "export", "import", "share", "bug", "copy",
  "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "resume", "reload", "quit",
]);

export function mapPiCommands(commands: readonly unknown[]): ProviderCommand[] {
  const mapped: ProviderCommand[] = [];
  for (const raw of commands) {
    if (!isRecord(raw)) continue;
    const name = asString(raw.name);
    if (!name) continue;
    if (name === "superpi-control") continue;
    mapped.push({ name, description: asString(raw.description) ?? "" });
  }
  const names = new Set(mapped.map((command) => command.name));
  return [...PI_RPC_COMMANDS.filter((command) => !names.has(command.name)), ...mapped];
}

function parsePiState(data: unknown): {
  sessionId?: string;
  sessionFile?: string;
  model?: unknown;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
} {
  if (!isRecord(data)) return {};
  return {
    sessionId: asString(data.sessionId),
    sessionFile: asString(data.sessionFile),
    model: data.model,
    thinkingLevel: asString(data.thinkingLevel),
    ...(typeof data.isStreaming === "boolean" ? { isStreaming: data.isStreaming } : {}),
    ...(typeof data.isCompacting === "boolean" ? { isCompacting: data.isCompacting } : {}),
  };
}

/** True when the Pi model definition accepts image input. */
export function piModelSupportsImages(model: unknown): boolean {
  if (!isRecord(model)) return false;
  const input = model.input;
  return Array.isArray(input) && input.includes("image");
}

const rewindResultSchema = z.object({
  cancelled: z.boolean(),
  targetEntryId: z.string().min(1),
  leafId: z.string().optional(),
  settings: z.object({ tier: tierSchema, longContext: z.boolean() }),
  activeChildren: z.number().int().nonnegative(),
});

function extractArray(data: unknown, key: string): unknown[] {
  if (!isRecord(data)) return [];
  const value = data[key];
  return Array.isArray(value) ? value : [];
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof Error) return { message: error.message };
  return { message: String(error) };
}

const TIER_LABELS: Record<Tier, string> = {  default: "Default",
  fast: "Fast",
  flex: "Flex",
  ultrafast: "Ultrafast",
};

function buildCompanionSettings(state: CompanionState | undefined, modelContextWindow?: number): ProviderSetting[] {
  const tier = state?.settings.tier ?? "default";
  const longContext = state?.settings.longContext ?? false;
  const context = contextSettingPresentation(state, modelContextWindow);
  return [
    {
      type: "select",
      id: "tier",
      label: "Service tier",
      description: "Companion tier applied to the next provider request",
      value: tier,
      options: tierSchema.options.map((value) => ({ label: TIER_LABELS[value], value })),
    },
    {
      type: "toggle",
      id: "longContext",
      label: context.label,
      description: context.description,
      value: longContext,
    },
  ];
}

function parseModelId(fullId: string): { provider: string; modelId: string } {
  const index = fullId.indexOf("/");
  if (index <= 0 || index === fullId.length - 1) {
    throw new Error(`Invalid Superpi model id: ${fullId}`);
  }
  return { provider: fullId.slice(0, index), modelId: fullId.slice(index + 1) };
}

/**
 * Translate submitted session settings into companion `configure` data.
 *
 * Only the two published companion controls are supported: `tier` and
 * `longContext`. Unknown keys are rejected rather than silently dropped, so a
 * host that asks for an unsupported setting still sees an honest failure.
 */
export function parseCompanionSettings(
  settings: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(settings)) {
    if (key === "tier") {
      const parsed = tierSchema.safeParse(settings.tier);
      if (!parsed.success) throw new Error(`Invalid Superpi tier: ${String(settings.tier)}`);
      data.tier = parsed.data;
    } else if (key === "longContext") {
      if (typeof settings.longContext !== "boolean") {
        throw new Error("Superpi longContext setting must be a boolean");
      }
      data.longContext = settings.longContext;
    } else {
      throw new Error(`Superpi does not support the ${key} setting`);
    }
  }
  return data;
}

export interface BuildLaunchArgsInput {
  config: ProviderSessionConfig;
  companionPath: string;
  sessionDirectory: string;
  transcript?: string;
}

/**
 * Launch Pi with normal resources, the explicit companion extension, and an
 * owned native session directory. A recorded transcript restores the saved
 * session; otherwise Pi creates a new one inside `sessionDirectory`.
 */
export function buildLaunchArgs(input: BuildLaunchArgsInput): string[] {
  const { config, companionPath, sessionDirectory, transcript } = input;
  const args = config.persist === false ? ["--mode", "rpc", "--no-session"] : ["--mode", "rpc", "--session-dir", sessionDirectory];
  if (config.persist !== false && transcript) args.push("--session", transcript);
  if (config.model) args.push("--model", config.model);
  if (config.thinkingOption) args.push("--thinking", config.thinkingOption);
  if (config.systemPrompt) args.push("--append-system-prompt", config.systemPrompt);
  args.push("--extension", companionPath, "--superpi-companion-root");
  return args;
}

export interface SuperpiSessionOptions {
  sessionId: string;
  config: ProviderSessionConfig;
  persistence?: ProviderPersistence;
  history: "replay" | "skip";
  stateDirectory: string;
  command: string;
  companionPath: string;
  /** Capabilities negotiated with the host; defaults to the supported session set. */
  capabilities?: readonly string[];
  /** Aggregated plugin dialog registry; the session registers its bridge while open. */
  dialogRegistry?: DialogRegistry;
  emit: (event: ProviderEvent) => void;
  createPiRpc?: (options: PiRpcOptions) => Promise<PiRpc>;
}

interface Admission {
  clientMessageId: string;
  turnId: string;
}

/** Active-branch history plus the rewind-token index derived from it. */
interface ActiveHistory {
  entries: NativeSessionEntry[];
  leafId: string | null;
  tokens: Map<string, RewindToken>;
  messages?: unknown[];
}

/**
 * The dialog helper's `cancelAll` settles every pending native dialog with a
 * cancel response without closing the bridge. Call it through a widened view so
 * session code degrades safely if the helper is unavailable.
 */
type CancelableDialogBridge = DialogBridge & { cancelAll?: () => Promise<void> };

export class SuperpiSession {
  private state: "opening" | "ready" | "closing" | "closed" | "failed" = "opening";
  private rpc: PiRpc | null = null;
  private store: SessionStore | null = null;
  private companion: ReturnType<typeof createCompanionChannel> | null = null;
  private companionState: CompanionState | undefined;
  private readonly capabilities: readonly string[];
  private readonly timeline: Timeline;
  private removeRecord: (() => void) | null = null;
  private removeExit: (() => void) | null = null;
  private closePromise: Promise<void> | null = null;
  private failureEmitted = false;
  private sessionKey = "";
  private readonly generation = randomUUID();
  private dialogBridge: DialogBridge | null = null;
  private unregisterDialog: (() => void) | null = null;
  private childObserver: SubagentObserver | null = null;
  private childObserverReady = false;
  private readonly childRecordBuffer: SubpiChildEnvelope[] = [];
  private childIngest: Promise<void> = Promise.resolve();
  private modelSupportsImages = false;
  private userRevertTokens = new Map<string, RewindToken>();
  private revertInFlight = false;
  private revertTokensUnavailable = false;
  private compactionInFlight = false;
  private notificationCounter = 0;
  private extensionCommands = new Set<string>();

  private activeTurnId: string | undefined;
  private readonly terminalizedTurns = new Set<string>();
  private readonly settledBeforeAdmission = new Set<string>();
  private readonly pendingResults = new Map<string, Admission>();
  private readonly userQueue: Admission[] = [];
  private boundUser: Admission | undefined;
  private turnCounter = 0;
  private cancelIntent = false;
  private pendingStopReason: "error" | "aborted" | undefined;
  private settlePromise: Promise<void> | null = null;
  private operationBarrier: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SuperpiSessionOptions) {
    this.capabilities = options.capabilities ?? SUPERPI_SESSION_CAPABILITIES;
    this.timeline = createTimeline({
      sessionId: options.sessionId,
      emit: (event) => this.emit(event),
    });
  }

  private emit(event: ProviderEvent): void {
    if (event.type === "timeline.item" && event.item.type === "user_message") {
      const token = this.userRevertTokens.get(event.item.id);
      if (token) {
        this.options.emit({ ...event, item: { ...event.item, revertToken: token } });
        return;
      }
    }
    this.options.emit(event);
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  get currentState(): "opening" | "ready" | "closing" | "closed" | "failed" {
    return this.state;
  }

  async open(requestId: string): Promise<void> {
    if (this.state !== "opening") throw new Error("Superpi session has already been opened");
    try {
      this.validateConfig(this.options.config);
      const persistent = this.options.config.persist !== false;
      let store: SessionStore | null = null;
      let transcript: string | undefined;
      if (persistent) {
        store = await SessionStore.open(
          this.options.stateDirectory,
          this.options.config.cwd,
          this.options.persistence,
        );
        this.store = store;
        transcript = await store.transcript();
      }
      const sessionKey = randomUUID();
      this.sessionKey = sessionKey;
      const createRpc = this.options.createPiRpc ?? createPiRpc;
      const rpc = await createRpc({
        command: this.options.command,
        args: buildLaunchArgs({
          config: this.options.config,
          companionPath: this.options.companionPath,
          sessionDirectory: store?.sessionDirectory ?? "",
          transcript,
        }),
        cwd: this.options.config.cwd,
        env: { ...this.options.config.env, SUPERPI_SESSION_KEY: sessionKey },
      });
      this.rpc = rpc;
      this.removeRecord = rpc.onRecord((record) => this.handleRecord(record));
      this.removeExit = rpc.onExit((error) => this.handleExit(error));
      // Register the dialog bridge before the first `get_state`/handshake request:
      // Pi can emit blocking startup dialogs before readiness, and the root
      // dialog registry must be able to answer them during open.
      this.dialogBridge = createDialogBridge({
        sessionId: this.sessionId,
        rpc,
        emit: (event) => this.emit(event),
        generation: this.generation,
      });
      this.unregisterDialog = this.options.dialogRegistry?.register(this.sessionId, this.dialogBridge) ?? null;

      const state = parsePiState(await rpc.request({ type: "get_state" }));
      this.modelSupportsImages = piModelSupportsImages(state.model);
      if (store) {
        await store.recordNative(state.sessionId ?? this.options.sessionId, state.sessionFile);
      }
      const priorInterrupted = store?.data.interrupted ?? false;

      const companion = createCompanionChannel(rpc, sessionKey);
      this.companion = companion;
      await companion.verify();
      const hello = companionStateSchema.parse(await companion.request("hello"));
      this.companionState = hello;

      // Composer selections are explicit host input. Apply them after the
      // companion has restored any saved branch settings so explicit values
      // override the restored state, then publish the committed config.
      const explicitSettings = parseCompanionSettings(this.options.config.settings ?? {});
      if (Object.keys(explicitSettings).length > 0) {
        const reply = await companion.request("configure", explicitSettings);
        this.companionState = companionStateSchema.parse(reply);
      }

      const config = await this.readConfigState();
      const nativeCommands = extractArray(await rpc.request({ type: "get_commands" }), "commands");
      const commands = mapPiCommands(nativeCommands);
      this.extensionCommands = new Set(nativeCommands.flatMap((command) => isRecord(command) && asString(command.name) && command.name !== "superpi-control" ? [String(command.name)] : []));

      this.emit({
        type: "session.opened",
        sessionId: this.sessionId,
        capabilities: this.capabilities,
        restoration: "core",
        ...(store ? { persistence: store.persistence } : {}),
        ...(this.options.config.title ? { title: this.options.config.title } : {}),
        cwd: this.options.config.cwd,
      });
      if (priorInterrupted) {
        this.emit({
          type: "session.notice",
          sessionId: this.sessionId,
          notice: {
            id: "interrupted-run",
            severity: "warning",
            title: "Previous run was interrupted",
            description: "The last turn did not confirm a terminal record; it was not replayed automatically.",
          },
        });
      }
      this.emit({ type: "session.config", sessionId: this.sessionId, config });
      this.emit({ type: "session.commands", sessionId: this.sessionId, commands });
      // Journaled child observation is scoped to the owned store directory. It
      // restores before ready and buffers any live records that raced startup.
      if (store) {
        await this.startChildObserver(store.directory);
      }
      if (this.options.history === "replay") {
        await this.replayHistory();
      }
      if (store) {
        this.emit({ type: "session.persistence", sessionId: this.sessionId, persistence: store.persistence });
      }
      this.state = "ready";
      this.emit({ type: "session.ready", requestId, sessionId: this.sessionId });
    } catch (error) {
      this.state = "failed";
      this.emit({ type: "request.failed", requestId, error: toProviderError(error) });
      await this.cleanup();
    }
  }

  private async readConfigState(): Promise<ProviderConfigState> {
    if (!this.rpc) throw new Error("Superpi session transport is not available");
    const state = parsePiState(await this.rpc.request({ type: "get_state" }));
    this.modelSupportsImages = piModelSupportsImages(state.model);
    const models = mapPiModels(
      extractArray(await this.rpc.request({ type: "get_available_models" }), "models"),
      modelKey(state.model),
    );
    const thinkingOptions = mapPiThinkingLevels(
      extractArray(
        await this.rpc.request({ type: "get_available_thinking_levels" }),
        "levels",
      ).filter((level): level is string => typeof level === "string"),
    );
    return {
      ...(modelKey(state.model) ? { model: modelKey(state.model) } : {}),
      ...(state.thinkingLevel ? { thinkingOption: state.thinkingLevel } : {}),
      models,
      modes: [],
      thinkingOptions,
      settings: buildCompanionSettings(this.companionState, isRecord(state.model) && typeof state.model.contextWindow === "number" ? state.model.contextWindow : undefined),
    };
  }

  private validateConfig(config: ProviderSessionConfig): void {
    if (config.mode) throw new Error("Superpi does not support Pi modes");
    if (config.toolPolicy && config.toolPolicy.preapproved.length > 0) {
      throw new Error(
        "Superpi does not translate Pi tool-policy preapprovals yet; refusing to broaden access silently",
      );
    }
    const mcpNames = Object.keys(config.mcpServers ?? {});
    if (mcpNames.length > 0) {
      throw new Error(
        `Superpi does not bridge MCP servers yet (requested: ${mcpNames.join(", ")}); refusing to ignore the request`,
      );
    }
    // Known companion settings (tier, long context) are validated here and
    // applied during open. Unknown keys are still refused rather than dropped.
    parseCompanionSettings(config.settings ?? {});
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.state !== "ready" || !this.rpc) {
      throw new Error("Superpi session is not ready for prompts");
    }
    if (this.revertInFlight) {
      throw new Error("Superpi conversation rewind is in progress");
    }
    if (this.compactionInFlight) {
      throw new Error("Superpi session is compacting");
    }
    if (prompt.delivery === "steer") {
      throw new Error("Superpi does not support steering yet");
    }
    const text = prompt.input.type === "message" && prompt.input.content.every((part) => part.type === "text")
      ? prompt.input.content.map((part) => part.type === "text" ? part.text : "").join("\n").trim()
      : undefined;
    const typedCommand = text ? /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text) : null;
    const command = prompt.input.type === "command" ? prompt.input : typedCommand ? { name: typedCommand[1]!, arguments: typedCommand[2] ?? "" } : undefined;
    if (command && !this.extensionCommands.has(command.name)) {
      if (command.name === "compact") {
        await this.runCompactCommand(prompt, command.arguments);
        return;
      }
      if (PI_RPC_COMMANDS.some((entry) => entry.name === command.name) || PI_TUI_COMMANDS.has(command.name) || command.name === "superpi-control") {
        await this.runNativeCommand(prompt, command.name, command.arguments);
        return;
      }
    }
    const rpc = this.rpc;
    // Admit synchronously, before any await (prompt building, manifest write),
    // so an exclusive rewind observes this prompt and cannot navigate between
    // validation and the native write.
    const turnId = `${this.sessionId}:turn:${++this.turnCounter}`;
    const admission: Admission = { clientMessageId: prompt.clientMessageId, turnId };
    this.pendingStopReason = undefined;
    this.pendingResults.set(prompt.clientMessageId, admission);
    this.userQueue.push(admission);
    try {
      const built = await buildPiPrompt(prompt, this.modelSupportsImages);
      const commandName = /^\/([^\s]+)(?:\s|$)/.exec(built.message)?.[1];
      const admissionTimeout = commandName && this.extensionCommands.has(commandName) ? 0 : undefined;
      const result = await this.enqueueOperation(async () => {
        if (this.store) {
          await this.store.save({ interrupted: true });
        }
        return rpc.request({
          type: "prompt",
          message: built.message,
          ...(built.images ? { images: built.images } : {}),
        }, admissionTimeout);
      });
      await this.handleDisposition(prompt.clientMessageId, result);
    } catch (error) {
      if (this.pendingResults.delete(prompt.clientMessageId)) {
        this.dropQueuedUser(prompt.clientMessageId);
        if (this.boundUser?.clientMessageId === prompt.clientMessageId) this.boundUser = undefined;
        this.emit({
          type: "session.prompt_result",
          sessionId: this.sessionId,
          clientMessageId: prompt.clientMessageId,
          result: { type: "failed", error: toProviderError(error) },
        });
      }
      if (error instanceof PiRpcTimeoutError || error instanceof PiRpcTransportError) {
        this.invalidateRuntime(error);
      }
      throw error;
    }
  }

  private async runCompactCommand(prompt: ProviderPrompt, args: string): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) throw new Error("Superpi session is not ready for prompts");
    if (this.compactionInFlight) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "failed", error: { message: "Superpi compaction is already in progress" } },
      });
      return;
    }
    // Hold the guard before any await and release it only when Pi actually
    // answers; compaction can run far longer than a normal command timeout.
    this.compactionInFlight = true;
    try {
      const state = await rpc.request({ type: "get_state" });
      if (isRecord(state) && (state.isStreaming === true || state.isCompacting === true)) {
        this.emit({
          type: "session.prompt_result",
          sessionId: this.sessionId,
          clientMessageId: prompt.clientMessageId,
          result: { type: "failed", error: { message: "Cannot compact while the session is busy" } },
        });
        return;
      }
      await rpc.request({ type: "compact", ...(args ? { customInstructions: args } : {}) }, 0);
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "completed" },
      });
    } catch (error) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "failed", error: toProviderError(error) },
      });
    } finally {
      this.compactionInFlight = false;
    }
  }

  private async runNativeCommand(prompt: ProviderPrompt, name: string, args: string): Promise<void> {
    try {
      await this.enqueueOperation(async () => {
        const rpc = this.rpc;
        if (!rpc) throw new Error("Superpi session transport is not available");
        switch (name) {
          case "autocompact": {
            const value = args.trim() || "toggle";
            if (!["on", "off", "toggle"].includes(value)) throw new Error("Use /autocompact [on|off|toggle].");
            const state = await rpc.request({ type: "get_state" });
            if (value === "toggle" && (!isRecord(state) || typeof state.autoCompactionEnabled !== "boolean")) throw new Error("Pi did not report its automatic compaction state; use on or off.");
            const enabled = value === "on" || (value === "toggle" && isRecord(state) && state.autoCompactionEnabled === false);
            await rpc.request({ type: "set_auto_compaction", enabled });
            const applied = await rpc.request({ type: "get_state" });
            if (!isRecord(applied) || typeof applied.autoCompactionEnabled !== "boolean") throw new Error("Pi did not confirm its automatic compaction state.");
            this.commandNotice(`Automatic compaction: ${applied.autoCompactionEnabled ? "on" : "off"}. This updates Pi's global compaction preference; project overrides may take precedence.`);
            break;
          }
          case "model": {
            if (!args.trim()) throw new Error("Use /model <provider/model>, or choose a model in the composer.");
            await this.applyConfiguration({ model: args.trim() });
            break;
          }
          case "thinking": {
            if (!PI_THINKING_OPTIONS.some((option) => option.id === args.trim())) throw new Error("Use /thinking <off|minimal|low|medium|high|xhigh|max>.");
            await this.applyConfiguration({ thinkingOption: args.trim() });
            break;
          }
          case "name":
            if (!args.trim()) throw new Error("Use /name <name>.");
            await rpc.request({ type: "set_session_name", name: args.trim() });
            this.commandNotice(`Pi session name: ${args.trim()}.`);
            break;
          case "session":
            this.commandNotice(JSON.stringify(await rpc.request({ type: "get_session_stats" })) ?? "Pi returned no session statistics.");
            break;
          default:
            throw new Error(`/${name} requires Pi's terminal UI and isn't available through Superpi. Use the Paseo controls or resume Pi in a terminal.`);
        }
      });
      this.emit({ type: "session.prompt_result", sessionId: this.sessionId, clientMessageId: prompt.clientMessageId, result: { type: "completed" } });
    } catch (error) {
      this.emit({ type: "session.prompt_result", sessionId: this.sessionId, clientMessageId: prompt.clientMessageId, result: { type: "failed", error: toProviderError(error) } });
    }
  }

  private commandNotice(message: string): void {
    this.emit({ type: "timeline.item", sessionId: this.sessionId, item: { type: "notification", id: `${this.sessionId}:command:${++this.notificationCounter}`, level: "info", message } });
  }

  async configure(requestId: string, changes: ProviderConfigChanges): Promise<void> {
    if (this.state !== "ready" || !this.rpc) {
      this.emit({
        type: "request.failed",
        requestId,
        error: { message: "Superpi session is not ready for configuration" },
      });
      return;
    }
    try {
      await this.enqueueOperation(() => this.applyConfiguration(changes));
      this.emit({ type: "request.completed", requestId });
    } catch (error) {
      this.emit({ type: "request.failed", requestId, error: toProviderError(error) });
    }
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationBarrier.then(operation, operation);
    this.operationBarrier = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async applyConfiguration(changes: ProviderConfigChanges): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) throw new Error("Superpi session transport is not available");
    const settings = changes.settings;
    if (settings) {
      const data = parseCompanionSettings(settings);
      if (Object.keys(data).length > 0) {
        if (!this.companion) throw new Error("Superpi companion channel is not available");
        const reply = await this.companion.request("configure", data);
        this.companionState = companionStateSchema.parse(reply);
      }
    }
    if (changes.model !== undefined) {
      if (changes.model === null) {
        throw new Error("Superpi cannot restore the Pi default model; choose an explicit model");
      }
      const parsed = parseModelId(changes.model);
      await rpc.request({ type: "set_model", provider: parsed.provider, modelId: parsed.modelId });
      if (this.companion) {
        try { this.companionState = companionStateSchema.parse(await this.companion.request("get-state")); }
        catch (error) {
          if (this.companionState) this.companionState = { capabilities: this.companionState.capabilities, settings: this.companionState.settings };
          this.emit({ type: "session.config", sessionId: this.sessionId, config: await this.readConfigState() });
          throw error;
        }
      }
    }
    if (changes.thinkingOption !== undefined) {
      await rpc.request({ type: "set_thinking_level", level: changes.thinkingOption ?? "off" });
    }
    const config = await this.readConfigState();
    this.emit({ type: "session.config", sessionId: this.sessionId, config });
  }

  private async handleDisposition(clientMessageId: string, result: unknown): Promise<void> {
    const admission = this.pendingResults.get(clientMessageId);
    if (!admission) return;
    this.pendingResults.delete(clientMessageId);
    const disposition = isRecord(result) ? asString(result.disposition) : undefined;
    switch (disposition) {
      case "started":
        this.activeTurnId = admission.turnId;
        this.emit({
          type: "session.prompt_result",
          sessionId: this.sessionId,
          clientMessageId,
          result: { type: "turn", turnId: admission.turnId },
        });
        this.emit({
          type: "session.turn",
          sessionId: this.sessionId,
          turnId: admission.turnId,
          state: "started",
        });
        // Pi may settle a fast run before its admission response is read.
        if (this.settledBeforeAdmission.delete(clientMessageId)) {
          await this.finalizeActiveTurn();
        }
        return;
      case "queued":
        this.emit({
          type: "session.prompt_result",
          sessionId: this.sessionId,
          clientMessageId,
          result: { type: "steer", turnId: this.activeTurnId ?? admission.turnId },
        });
        return;
      case "handled": {
        this.dropQueuedUser(clientMessageId);
        if (this.store && !this.activeTurnId && this.pendingResults.size === 0 && this.rpc) {
          const state = parsePiState(await this.rpc.request({ type: "get_state" }));
          if (!state.isStreaming && !state.isCompacting) await this.store.save({ interrupted: false });
        }
        this.emit({
          type: "session.prompt_result",
          sessionId: this.sessionId,
          clientMessageId,
          result: { type: "completed" },
        });
        return;
      }
      default:
        this.dropQueuedUser(clientMessageId);
        this.emit({
          type: "session.prompt_result",
          sessionId: this.sessionId,
          clientMessageId,
          result: {
            type: "failed",
            error: { message: `Unsupported Pi prompt disposition: ${String(disposition)}` },
          },
        });
    }
  }

  private dropQueuedUser(clientMessageId: string): void {
    const index = this.userQueue.findIndex((entry) => entry.clientMessageId === clientMessageId);
    if (index >= 0) this.userQueue.splice(index, 1);
  }

  private handleRecord(record: PiRecord): void {
    if (this.state === "closed" || this.state === "failed") return;
    if (record.type === "extension_ui_request") {
      this.handleExtensionUi(record);
      return;
    }
    const userRole = isUserMessageRecord(record);
    if (userRole) {
      if (!this.boundUser) this.boundUser = this.userQueue.shift();
      const context: TimelineContext = this.boundUser
        ? { clientMessageId: this.boundUser.clientMessageId, turnId: this.boundUser.turnId }
        : this.activeTurnId
          ? { turnId: this.activeTurnId }
          : {};
      this.timeline.accept(record, context);
    } else {
      this.timeline.accept(record, this.activeTurnId ? { turnId: this.activeTurnId } : {});
    }
    if (record.type === "message_end") {
      const message = record.message;
      if (isRecord(message)) {
        const stopReason = asString(message.stopReason);
        if (stopReason === "error") this.pendingStopReason = "error";
        else if (stopReason === "aborted") this.pendingStopReason = "aborted";
        else if (stopReason) this.pendingStopReason = undefined;
      }
    }
    if (record.type === "agent_settled") {
      const settled = this.boundUser;
      this.boundUser = undefined;
      if (this.activeTurnId) {
        void this.finalizeActiveTurn();
      } else if (settled && this.pendingResults.has(settled.clientMessageId)) {
        // The settlement raced ahead of the prompt admission response.
        this.settledBeforeAdmission.add(settled.clientMessageId);
      }
    }
  }

  /**
   * Route one `extension_ui_request` record.
   *
   * Companion replies are owned by the companion channel and are deliberately
   * not rendered as raw notification noise. Owned-subagent envelopes are
   * matched to this exact session key and handed to the observer. Blocking
   * dialogs go to the dialog bridge. Everything else that is an ordinary
   * notification is published as a standard notification timeline item.
   */
  private handleExtensionUi(record: PiRecord): void {
    const method = asString(record.method);
    if (method === "notify" && typeof record.message === "string") {
      const message = record.message;
      if (message.startsWith(companionPrefix)) return;
      const envelope = parseSubpiChildEnvelope(message);
      if (envelope) {
        if (envelope.sessionKey === this.sessionKey) this.acceptChildRecord(envelope);
        return;
      }
      this.emitNotification(record, message);
      return;
    }
    this.dialogBridge?.accept(record);
  }

  private emitNotification(record: PiRecord, message: string): void {
    const level =
      record.level === "warning" || record.level === "error" ? record.level : "info";
    this.emit({
      type: "timeline.item",
      sessionId: this.sessionId,
      item: {
        id: `notification:${++this.notificationCounter}`,
        type: "notification",
        level,
        message,
      },
    });
  }

  private acceptChildRecord(envelope: SubpiChildEnvelope): void {
    if (!this.childObserverReady) {
      this.childRecordBuffer.push(envelope);
      return;
    }
    void this.enqueueChildRecord(envelope.record);
  }

  /**
   * Serialize observer ingestion so startup/burst records are journaled in
   * order and never dropped. A receiver error is reported, not swallowed.
   */
  private enqueueChildRecord(record: unknown): Promise<void> {
    const run = this.childIngest.then(
      () => this.childObserver?.accept(record),
      () => this.childObserver?.accept(record),
    );
    const settled = run.then(
      () => undefined,
      (error: unknown) => {
        this.reportChildFailure(error);
      },
    );
    this.childIngest = settled;
    return settled;
  }

  private reportChildFailure(error: unknown): void {
    this.emit({
      type: "session.notice",
      sessionId: this.sessionId,
      notice: {
        id: "child-observer-error",
        severity: "warning",
        title: "Child session record could not be recorded",
        description: error instanceof Error ? error.message : String(error),
      },
    });
  }

  private async startChildObserver(directory: string): Promise<void> {
    try {
      this.childObserver = await createSubagentObserver({
        rootSessionId: this.sessionId,
        sessionKey: this.sessionKey,
        rootCwd: this.options.config.cwd,
        directory,
        emit: (event) => this.emit(event),
        restore: true,
      });
    } catch (error) {
      this.reportChildFailure(error);
      this.childObserverReady = true;
      this.childRecordBuffer.length = 0;
      return;
    }
    this.childObserverReady = true;
    const buffered = this.childRecordBuffer.splice(0);
    for (const envelope of buffered) {
      void this.enqueueChildRecord(envelope.record);
    }
  }

  private handleExit(error: Error): void {
    if (this.state === "closed" || this.state === "failed") return;
    this.invalidateRuntime(error);
  }

  private invalidateRuntime(error: Error): void {
    if (this.state === "closed" || this.state === "failed" || this.state === "closing") return;
    this.state = "failed";
    if (!this.failureEmitted) {
      this.failureEmitted = true;
      this.emit({
        type: "session.runtime_failed",
        sessionId: this.sessionId,
        error: toProviderError(error),
      });
    }
    void this.cleanup(error).catch(() => undefined);
  }

  private resolveTerminalState(): "completed" | "failed" | "canceled" {
    if (this.cancelIntent) return "canceled";
    if (this.pendingStopReason === "aborted") return "canceled";
    if (this.pendingStopReason === "error") return "failed";
    return "completed";
  }

  private finalizeActiveTurn(): Promise<void> {
    if (this.settlePromise) return this.settlePromise;
    if (!this.activeTurnId) return Promise.resolve();
    const promise = this.runFinalizeTurn();
    this.settlePromise = promise;
    void promise.finally(() => {
      if (this.settlePromise === promise) this.settlePromise = null;
    });
    return promise;
  }

  private async runFinalizeTurn(): Promise<void> {
    let persistenceError: ProviderError | undefined;
    try {
      await this.refreshNativeState();
      await this.refreshRevertTokens();
    } catch (error) {
      persistenceError = toProviderError(error);
    }
    const state = this.resolveTerminalState();
    const turnId = this.activeTurnId;
    this.pendingStopReason = undefined;
    this.endTurn(state, state === "failed" ? { message: "The model turn failed" } : undefined);
    if (persistenceError && turnId) {
      this.emit({
        type: "session.notice",
        sessionId: this.sessionId,
        notice: {
          id: `persistence-unconfirmed-${turnId}`,
          severity: "warning",
          title: "Session state was not confirmed",
          description: persistenceError.message,
        },
      });
    }
  }

  private async refreshNativeState(): Promise<void> {
    if (!this.rpc || !this.store) return;
    if (this.state === "closed" || this.state === "failed") return;
    const data = await this.rpc.request({ type: "get_state" });
    const state = parsePiState(data);
    this.modelSupportsImages = piModelSupportsImages(state.model);
    await this.store.recordNative(state.sessionId ?? this.options.sessionId, state.sessionFile);
    await this.store.save({ interrupted: false });
    this.emit({
      type: "session.persistence",
      sessionId: this.sessionId,
      persistence: this.store.persistence,
    });
  }

  /**
   * Refresh active-branch rewind tokens. Prefers the owned native transcript so
   * a large session never forces a lifetime `get_entries` frame. Failure
   * degrades rewind availability instead of failing the turn; it is reported
   * once so the limitation is visible rather than silent.
   */
  private async refreshRevertTokens(): Promise<void> {
    await this.loadRevertTokens();
    this.republishUserRevertTokens();
  }

  /** Refresh the token map without re-emitting existing rows. */
  private async loadRevertTokens(): Promise<void> {
    const rpc = this.rpc;
    const store = this.store;
    if (!rpc || !store) return;
    if (this.state === "closed" || this.state === "failed") return;
    try {
      const history = await this.readActiveHistory();
      this.userRevertTokens = history.tokens;
    } catch (error) {
      this.reportRewindUnavailable(error);
    }
  }

  /**
   * Active-branch history for the owned session. The authorized transcript file
   * is streamed when it exists (v2+ format); Pi's lifetime `get_entries` /
   * `get_messages` RPCs are a fallback only for ephemeral sessions, files with
   * no recognizable header, and legacy v1 transcripts.
   */
  private async readActiveHistory(options: { messages?: boolean } = {}): Promise<ActiveHistory> {
    const store = this.store;
    if (store) {
      const file = await store.transcript();
      if (file) {
        const snapshot = await readPiTranscriptSnapshot(file);
        if (snapshot.hasHeader && snapshot.version !== undefined && snapshot.version >= 2) {
          return {
            entries: snapshot.entries,
            leafId: snapshot.leafId ?? null,
            tokens: buildActiveUserTokenMap(snapshot.entries, snapshot.leafId, store.data.id),
            ...(options.messages
              ? { messages: await readPiTranscriptMessages(file, snapshot.activeEntries) }
              : {}),
          };
        }
      }
    }
    const rpc = this.rpc;
    if (!rpc) throw new Error("Superpi session transport is not available");
    const data = await rpc.request({ type: "get_entries" });
    const entries = parseNativeEntries(isRecord(data) ? data.entries : undefined);
    const leafId = isRecord(data) && typeof data.leafId === "string" ? data.leafId : null;
    const owner = store?.data.id ?? this.options.sessionId;
    return {
      entries,
      leafId,
      tokens: buildActiveUserTokenMap(entries, leafId, owner),
      ...(options.messages
        ? { messages: extractArray(await rpc.request({ type: "get_messages" }), "messages") }
        : {}),
    };
  }

  /**
   * Replay the active branch into the projector, preferring the streamed native
   * transcript. Falls back to `get_messages` only when no authorized transcript
   * is available.
   */
  private async replayHistory(): Promise<void> {
    try {
      const history = await this.readActiveHistory({ messages: true });
      this.userRevertTokens = history.tokens;
      this.timeline.replay(history.messages ?? []);
      return;
    } catch (error) {
      this.reportRewindUnavailable(error);
    }
    await this.refreshRevertTokens();
    const rpc = this.rpc;
    if (!rpc) throw new Error("Superpi session transport is not available");
    this.timeline.replay(extractArray(await rpc.request({ type: "get_messages" }), "messages"));
  }

  private reportRewindUnavailable(error: unknown): void {
    if (this.revertTokensUnavailable) return;
    this.revertTokensUnavailable = true;
    this.emit({
      type: "session.notice",
      sessionId: this.sessionId,
      notice: {
        id: "rewind-unavailable",
        severity: "warning",
        title: "Conversation rewind is unavailable",
        description: `Pi did not return its session tree: ${error instanceof Error ? error.message : String(error)}`,
      },
    });
  }

  /** Purge queued admissions that a successful `clear_queue` discarded. */
  private purgeQueuedAdmissions(): void {
    const activeTurnId = this.activeTurnId;
    if (activeTurnId === undefined) {
      this.userQueue.length = 0;
    } else {
      for (let index = this.userQueue.length - 1; index >= 0; index -= 1) {
        if (this.userQueue[index]?.turnId !== activeTurnId) this.userQueue.splice(index, 1);
      }
    }
    if (this.boundUser && this.boundUser.turnId !== activeTurnId) this.boundUser = undefined;
  }

  /** Ask the dialog helper to cancel pending native dialogs without closing it. */
  private async cancelPendingDialogs(): Promise<void> {
    const bridge = this.dialogBridge as CancelableDialogBridge | null;
    if (!bridge) return;
    try {
      await bridge.cancelAll?.();
    } catch (error) {
      this.emit({
        type: "session.notice",
        sessionId: this.sessionId,
        notice: {
          id: "dialog-cancel-error",
          severity: "warning",
          title: "Pending dialogs could not be cancelled",
          description: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /** Re-emit active user rows so the host sees the same item ids with tokens. */
  private republishUserRevertTokens(): void {
    if (this.userRevertTokens.size === 0) return;
    for (const item of this.timeline.items()) {
      if (item.type !== "user_message") continue;
      if (!this.userRevertTokens.has(item.id)) continue;
      this.emit({ type: "timeline.item", sessionId: this.sessionId, item });
    }
  }

  private endTurn(state: "completed" | "failed" | "canceled", error?: ProviderError): void {
    const turnId = this.activeTurnId;
    if (!turnId) return;
    this.activeTurnId = undefined;
    if (this.terminalizedTurns.has(turnId)) return;
    this.terminalizedTurns.add(turnId);
    this.emit({
      type: "session.turn",
      sessionId: this.sessionId,
      turnId,
      state,
      ...(error ? { error } : {}),
    });
  }

  async interrupt(requestId: string): Promise<void> {
    if (this.revertInFlight) {
      this.emit({
        type: "request.failed",
        requestId,
        error: { message: "Superpi conversation rewind is in progress" },
      });
      return;
    }
    if (!this.rpc || this.state === "closed" || this.state === "failed") {
      this.emit({
        type: "request.failed",
        requestId,
        error: { message: "Superpi session is not running" },
      });
      return;
    }
    // Cancel intent must be recorded before the abort round-trip; Pi may emit
    // agent_settled while the abort response is still in flight.
    this.cancelIntent = true;
    const rpc = this.rpc;
    try {
      // A blocking editor/input command runs with a zero admission timeout; the
      // bridge must release it before `clear_queue`/`abort` so Stop is not held
      // open waiting for a dialog the user no longer has.
      await this.cancelPendingDialogs();
      await rpc.request({ type: "clear_queue" });
      this.purgeQueuedAdmissions();
      await rpc.request({ type: "abort" });
      await this.finalizeActiveTurn();
      this.cancelIntent = false;
      this.emit({ type: "request.completed", requestId });
    } catch (error) {
      this.cancelIntent = false;
      this.emit({
        type: "request.failed",
        requestId,
        error: toProviderError(error),
      });
    }
  }

  async respondPermission(
    permissionId: string,
    response: ProviderPermissionResponse,
  ): Promise<void> {
    await this.dialogBridge?.respond(permissionId, response);
  }

  /**
   * Conversation rewind. Mirrors the OMP sequence: validate the token against
   * the owned session, confirm idle/active-branch target, clear native queued
   * input with feedback, ask the companion to navigate, verify the resulting
   * identity/configuration, then reset the projector and replay the active
   * branch. A failure after navigation is treated as indeterminate and closes
   * the session honestly rather than pretending the old branch is still active.
   *
   * Paseo 0.11's provider adapter is append-only, so the host's live timeline
   * cannot be pruned in place. This method does not emit an invented
   * `timeline.reset` event; its own active-branch projection (used on reopen) is
   * correct, and abandoned history stays only on disk.
   */
  async revert(
    requestId: string,
    token: unknown,
    scope: "conversation" | "files" | "both",
  ): Promise<void> {
    if (scope !== "conversation") {
      this.emit({
        type: "request.failed",
        requestId,
        error: { message: "Superpi supports conversation rewind only" },
      });
      return;
    }
    if (this.state !== "ready" || !this.rpc || !this.store) {
      this.emit({
        type: "request.failed",
        requestId,
        error: { message: "Superpi session is not ready for rewinding" },
      });
      return;
    }
    if (
      this.revertInFlight ||
      this.activeTurnId ||
      this.settlePromise ||
      this.cancelIntent ||
      this.compactionInFlight ||
      this.pendingResults.size > 0 ||
      (this.dialogBridge?.list().length ?? 0) > 0
    ) {
      this.emit({
        type: "request.failed",
        requestId,
        error: { message: "Superpi session is busy; wait for the active turn before rewinding" },
      });
      return;
    }
    const activeChildren = this.childObserver?.activeCount() ?? 0;
    if (activeChildren > 0) {
      this.emit({
        type: "request.failed",
        requestId,
        error: {
          message: `Cannot rewind while ${activeChildren} owned child session(s) are active`,
        },
      });
      return;
    }
    // Exclusive barrier: reject new prompts for the whole operation and
    // serialize against configuration through the shared operation barrier.
    this.revertInFlight = true;
    try {
      await this.enqueueOperation(() => this.performRevert(requestId, token));
    } finally {
      this.revertInFlight = false;
    }
  }

  private async performRevert(requestId: string, token: unknown): Promise<void> {
    const rpc = this.rpc;
    const store = this.store;
    const companion = this.companion;
    if (!rpc || !store || !companion) {
      this.emit({
        type: "request.failed",
        requestId,
        error: { message: "Superpi session is not ready for rewinding" },
      });
      return;
    }
    const entryId = resolveRewindToken(token, store.data.id);
    if (!entryId) {
      this.emit({
        type: "request.failed",
        requestId,
        error: {
          message: "Superpi rewind token is stale or belongs to another session; refresh and try again",
        },
      });
      return;
    }
    const before = parsePiState(await rpc.request({ type: "get_state" }));
    if (before.isStreaming || before.isCompacting) {
      this.emit({
        type: "request.failed",
        requestId,
        error: { message: "Cannot rewind while Pi is streaming or compacting" },
      });
      return;
    }
    let active: ActiveHistory;
    try {
      active = await this.readActiveHistory();
    } catch (error) {
      this.emit({ type: "request.failed", requestId, error: toProviderError(error) });
      return;
    }
    if (!findActiveBranchUserEntry(active.entries, active.leafId, entryId)) {
      this.emit({
        type: "request.failed",
        requestId,
        error: { message: "Superpi rewind target is not a user message on the active branch" },
      });
      return;
    }
    let cleared: unknown;
    try {
      cleared = await rpc.request({ type: "clear_queue" });
    } catch (error) {
      this.emit({
        type: "request.failed", requestId,
        error: { message: `Cannot rewind because old queued input could not be cleared: ${toProviderError(error).message}` },
      });
      return;
    }
    this.purgeQueuedAdmissions();
    const clearedCount = queueCount(cleared);
    if (clearedCount > 0) {
      this.emit({
        type: "session.notice",
        sessionId: this.sessionId,
        notice: {
          id: "rewind-queue-cleared",
          severity: "info",
          title: "Queued input cleared",
          description: `${clearedCount} queued item(s) were discarded and are not replayed onto the rewound branch.`,
        },
      });
    }
    // From here native branch state may mutate. A failure that cannot prove
    // navigation did not happen is reported as indeterminate.
    let result: z.infer<typeof rewindResultSchema>;
    try {
      result = rewindResultSchema.parse(
        await companion.request("rewind", { targetEntryId: entryId }),
      );
    } catch (error) {
      if (isRewindOutcomeUncertain(error)) {
        await this.failIndeterminateRewind(requestId, error);
      } else {
        this.emit({
          type: "request.failed",
          requestId,
          error: toProviderError(error),
        });
      }
      return;
    }
    if (result.cancelled) {
      this.emit({
        type: "request.failed",
        requestId,
        error: {
          message:
            "Superpi rewind was cancelled before navigation completed; any cleared queued input was not restored",
        },
      });
      return;
    }
    try {
      await this.confirmRewind(before, result.settings);
    } catch (error) {
      await this.failIndeterminateRewind(requestId, error);
      return;
    }
    this.emit({ type: "request.completed", requestId });
  }

  private async confirmRewind(
    before: ReturnType<typeof parsePiState>,
    settings: { tier: Tier; longContext: boolean },
  ): Promise<void> {
    const rpc = this.rpc;
    const store = this.store;
    if (!rpc || !store) throw new Error("Superpi session transport is not available");
    const state = parsePiState(await rpc.request({ type: "get_state" }));
    if (state.isStreaming || state.isCompacting) {
      throw new Error("Pi reported a busy session after rewind");
    }
    if (
      (before.sessionId ?? this.options.sessionId) !==
      (state.sessionId ?? this.options.sessionId)
    ) {
      throw new Error("Pi changed session identity while rewinding the conversation");
    }
    if (modelKey(before.model) !== modelKey(state.model)) {
      throw new Error("Pi changed model while rewinding the conversation");
    }
    this.modelSupportsImages = piModelSupportsImages(state.model);
    // The companion restored branch-local settings during navigation. Reflect
    // those committed values instead of any pre-rewind defaults.
    this.companionState = companionStateSchema.parse({
      capabilities: this.companionState?.capabilities ?? [],
      settings,
    });
    if (this.companion) this.companionState = companionStateSchema.parse(await this.companion.request("get-state"));
    this.timeline.reset();
    const history = await this.readActiveHistory({ messages: true });
    this.userRevertTokens = history.tokens;
    this.timeline.replay(history.messages ?? []);
    await store.save({ interrupted: false });
    const config = await this.readConfigState();
    this.emit({ type: "session.config", sessionId: this.sessionId, config });
    this.emit({
      type: "session.persistence",
      sessionId: this.sessionId,
      persistence: store.persistence,
    });
  }

  private async failIndeterminateRewind(requestId: string, error: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    const failure = new Error(
      `Superpi conversation rewind left native state indeterminate: ${detail}`,
    );
    this.emit({ type: "request.failed", requestId, error: { message: failure.message } });
    this.invalidateRuntime(failure);
  }

  close(): Promise<void> {
    return this.cleanup();
  }

  private failPendingPrompts(error: Error): void {
    if (this.pendingResults.size === 0) return;
    const providerError = toProviderError(error);
    for (const admission of this.pendingResults.values()) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId: admission.clientMessageId,
        result: { type: "failed", error: providerError },
      });
    }
    this.pendingResults.clear();
  }

  private async drainChildObserver(reason?: string): Promise<void> {
    // Drain every queued accept before settling, so a burst record is not
    // dropped and terminal child outcomes are published before root cleanup.
    await this.childIngest.catch(() => undefined);
    const observer = this.childObserver;
    this.childObserver = null;
    this.childObserverReady = false;
    if (!observer) return;
    try {
      await observer.close(reason);
    } catch (error) {
      this.reportChildFailure(error);
    }
  }

  private cleanup(failure?: Error): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (this.state === "closed") return;
      const failed = failure !== undefined || this.state === "failed";
      this.state = "closing";
      this.endTurn(failed ? "failed" : "canceled", failed ? toProviderError(failure ?? new Error("Superpi session failed")) : undefined);
      this.failPendingPrompts(
        failure ?? new Error("Superpi session closed before the prompt settled"),
      );
      this.boundUser = undefined;
      this.userQueue.length = 0;
      this.settledBeforeAdmission.clear();
      this.pendingStopReason = undefined;
      this.cancelIntent = false;
      this.unregisterDialog?.();
      this.unregisterDialog = null;
      const bridge = this.dialogBridge;
      this.dialogBridge = null;
      if (bridge) await bridge.close().catch((error: unknown) => this.reportChildFailure(error));
      await this.drainChildObserver(
        failed
          ? "The root session failed while this child run was still active; the run was not resumed."
          : undefined,
      );
      this.companion?.close();
      this.companion = null;
      let cleanupError: Error | null = null;
      try {
        // Keep record/exit listeners attached while closing so final Pi records
        // are drained rather than dropped.
        await this.rpc?.close();
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error));
      }
      this.removeRecord?.();
      this.removeExit?.();
      this.removeRecord = null;
      this.removeExit = null;
      this.rpc = null;
      try {
        await this.store?.release();
      } catch (error) {
        cleanupError ??= error instanceof Error ? error : new Error(String(error));
      }
      this.store = null;
      this.state = "closed";
      this.emit({
        type: "session.closed",
        sessionId: this.sessionId,
        ...(cleanupError ? { error: { message: cleanupError.message } } : {}),
      });
      if (cleanupError) {
        throw cleanupError;
      }
    })();
    return this.closePromise;
  }
}

export function createSuperpiSession(options: SuperpiSessionOptions): SuperpiSession {
  return new SuperpiSession(options);
}

function isUserMessageRecord(record: PiRecord): boolean {
  if (record.type !== "message_start" && record.type !== "message_end") return false;
  const message = record.message;
  return isRecord(message) && message.role === "user";
}

/** Count queued native input reported by Pi's `clear_queue` response. */
function queueCount(value: unknown): number {
  if (!isRecord(value)) return 0;
  const steering = Array.isArray(value.steering) ? value.steering.length : 0;
  const followUp = Array.isArray(value.followUp) ? value.followUp.length : 0;
  return steering + followUp;
}

/**
 * A companion rewind rejection is only treated as an indeterminate committed
 * failure when the transport itself failed or the companion reply could have
 * been lost. A plain validation rejection (`ok: false`) means navigation did
 * not run and can be reported without tearing the session down.
 */
function isRewindOutcomeUncertain(error: unknown): boolean {
  if (error instanceof PiRpcTimeoutError || error instanceof PiRpcTransportError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("uncertain") || message.includes("timed out");
}
