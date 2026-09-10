/**
 * Local structural types for the pi SDK. We never `import type` from
 * "@earendil-works/pi-coding-agent" or its siblings: Paseo's plugin compiler
 * walks type-only imports into third-party declaration files (e.g. the
 * Anthropic SDK's .d.mts fallback chains) and fails on unresolvable entries.
 * Value imports resolve to runtime JS only, so every needed type is derived
 * here from value-imported classes and derived signatures.
 */
import type {
  PiAgentMessage,
  PiAgentSessionEvent,
  PiImageContent,
  PiModel,
  PiSessionStats,
  PiThinkingLevel,
} from "../shared/rpc-types.js";

// Reused pi shapes — the SDK event/message formats are the same ones the RPC
// mode serialized (the RPC mode is a thin wrapper over these SDK events).
export type {
  PiAgentMessage,
  PiAgentSessionEvent,
  PiImageContent,
  PiModel,
  PiSessionStats,
  PiThinkingLevel,
};

/** Subset of pi's ModelRuntime used by the provider. */
export interface PiModelRuntimeLike {
  getModel(provider: string, id: string): unknown;
  getAvailable(): Promise<readonly unknown[]>;
}

/** Subset of pi's SessionManager used by the provider. */
export interface PiSessionManagerLike {
  getEntries(): unknown[];
  getBranch(fromId?: string): unknown[];
  getLeafId(): string | null;
  getEntry(id: string): unknown;
  branch(branchFromId: string): void;
  resetLeaf(): void;
  appendCustomEntry(customType: string, data?: unknown): string;
}

/** Subset of pi's AgentSession used by the session adapter. */
export interface PiAgentSessionLike {
  readonly agent: { state: { systemPrompt: string } };
  readonly sessionManager: unknown;
  readonly modelRuntime: {
    getModel(provider: string, id: string): unknown;
    getAvailable(): Promise<readonly unknown[]>;
  };
  readonly sessionFile: string | undefined;
  readonly model: { provider: string; id: string } | undefined;
  readonly thinkingLevel: string;
  readonly messages: readonly unknown[];
  subscribe(listener: (event: unknown) => void): () => void;
  bindExtensions(bindings: { uiContext?: unknown; mode?: string }): Promise<void>;
  prompt(text: string, options?: Record<string, unknown>): Promise<void>;
  steer(text: string, images?: unknown[]): Promise<void>;
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<unknown>;
  setModel(model: unknown, options?: Record<string, unknown>): Promise<void>;
  setThinkingLevel(level: string, options?: Record<string, unknown>): void;
  setAutoCompactionEnabled(enabled: boolean): void;
  readonly autoCompactionEnabled: boolean;
  setAutoRetryEnabled(enabled: boolean): void;
  readonly autoRetryEnabled: boolean;
  setActiveToolsByName(toolNames: string[]): void;
  getAllTools?(): ReadonlyArray<{ name: string }>;
  getActiveToolNames?(): string[];
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<unknown>;
  getSessionStats(): {
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    cost: number;
    contextUsage?: { tokens: number | null; contextWindow: number };
  };
  dispose(): void;
}

/** Minimal pi tool definition shape (pi accepts plain JSON-schema parameters). */
export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

/**
 * Structural stand-in for pi's ExtensionUIContext. Only the dialog/notify
 * surface is meaningful headlessly; the rest is stubbed. Kept structural so
 * no type-only import of pi's package is ever needed.
 */
export type PiHeadlessUiContext = Record<string, unknown>;

/** Minimal prompt template shape from the resource loader. */
export interface PiPromptTemplateLike {
  name: string;
  description?: string;
}

/** Subset of pi's DefaultResourceLoader used by the provider. */
export interface PiResourceLoaderLike {
  reload(): Promise<void>;
  getExtensions(): {
    errors: ReadonlyArray<{ path?: string; error: unknown }>;
    extensions: ReadonlyArray<{
      tools: ReadonlyMap<string, unknown>;
      commands: ReadonlyMap<string, { name: string; description?: string }>;
    }>;
  };
  getPrompts(): { prompts: PiPromptTemplateLike[]; diagnostics: ReadonlyArray<PiResourceDiagnostic> };
  getSkills(): { diagnostics: ReadonlyArray<PiResourceDiagnostic> };
  getThemes(): { diagnostics: ReadonlyArray<PiResourceDiagnostic> };
}

export interface PiResourceDiagnostic {
  type?: string;
  message: string;
  path?: string;
}

/** Result of createAgentSession for our purposes. */
export interface PiCreateAgentSessionResultLike {
  session: PiAgentSessionLike;
  modelFallbackMessage?: string;
}

/** Static surface of pi's SessionManager used by the provider. */
export interface PiSessionManagerStatics {
  create(cwd?: string): PiSessionManagerLike;
  open(path: string): PiSessionManagerLike;
  inMemory(cwd?: string): PiSessionManagerLike;
}
