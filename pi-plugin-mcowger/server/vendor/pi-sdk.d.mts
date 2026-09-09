import type {
  PiCreateAgentSessionResultLike,
  PiModel,
  PiModelRuntimeLike,
  PiResourceLoaderLike,
  PiSessionManagerStatics,
  PiToolDefinition,
} from "../../shared/pi-sdk-types.js";

export declare const ModelRuntime: {
  create(options?: Record<string, unknown>): Promise<PiModelRuntimeLike>;
};

export declare const SessionManager: PiSessionManagerStatics;

export declare const DefaultResourceLoader: {
  new (options: {
    cwd: string;
    agentDir: string;
    appendSystemPromptOverride?: (base: string[]) => string[];
  }): PiResourceLoaderLike;
};

export declare function createAgentSession(options?: {
  cwd?: string;
  agentDir?: string;
  modelRuntime?: PiModelRuntimeLike;
  model?: unknown;
  thinkingLevel?: string;
  tools?: string[];
  customTools?: PiToolDefinition[];
  resourceLoader?: PiResourceLoaderLike;
  sessionManager?: unknown;
}): Promise<PiCreateAgentSessionResultLike>;

export declare function getAgentDir(): string;

export declare function defineTool(definition: PiToolDefinition): PiToolDefinition;

export declare class Client {
  constructor(info: { name: string; version: string });
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{
    tools: Array<{
      name: string;
      title?: string;
      description?: string;
      inputSchema?: unknown;
    }>;
  }>;
  callTool(request: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{ content?: unknown; structuredContent?: unknown }>;
}

export declare class StdioClientTransport {
  constructor(options: { command: string; args?: string[]; env?: Record<string, string> });
}

export declare class SSEClientTransport {
  constructor(url: URL, options?: { requestInit?: { headers?: Record<string, string> } });
}

export declare class StreamableHTTPClientTransport {
  constructor(url: URL, options?: { requestInit?: { headers?: Record<string, string> } });
}
