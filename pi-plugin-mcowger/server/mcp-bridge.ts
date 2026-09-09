import { Client, SSEClientTransport, StdioClientTransport, StreamableHTTPClientTransport } from "./pi-sdk.js";
import { defineTool } from "./pi-sdk.js";

import type { PiToolDefinition } from "../shared/pi-sdk-types.js";
import type { ProviderMcpServerConfig } from "@getpaseo/plugin/server/provider";

export interface McpBridgeHandle {
  tools: PiToolDefinition[];
  close(): Promise<void>;
}

function sanitizeNamePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

function toTransport(
  config: ProviderMcpServerConfig,
): StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env ? { ...config.env } : undefined,
    });
  }
  const url = new URL(config.url);
  if (config.type === "sse") {
    return new SSEClientTransport(url, {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
  }
  return new StreamableHTTPClientTransport(url, {
    requestInit: config.headers ? { headers: config.headers } : undefined,
  });
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const { $schema: _removed, additionalProperties: _removed2, ...rest } = schema as Record<
    string,
    unknown
  >;
  return rest;
}

/**
 * Connect Paseo-injected MCP servers directly and expose their tools as pi
 * custom tools named `mcp_<server>_<tool>`. Each session gets its own clients,
 * so concurrent sessions with different server sets stay isolated.
 */
export async function createMcpBridge(
  servers: Readonly<Record<string, ProviderMcpServerConfig>>,
  log: (message: string) => void,
): Promise<McpBridgeHandle> {
  const clients: Client[] = [];
  const tools: PiToolDefinition[] = [];

  const entries = Object.entries(servers);
  await Promise.all(
    entries.map(async ([serverName, config]) => {
      const client = new Client({ name: "pi-plugin-mcowger", version: "0.0.0" });
      try {
        await client.connect(toTransport(config));
      } catch (error) {
        log(
          `mcp: failed to connect to ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      clients.push(client);
      const listed = await client.listTools();
      for (const mcpTool of listed.tools) {
        const toolName = `mcp_${sanitizeNamePart(serverName)}_${sanitizeNamePart(mcpTool.name)}`;
        tools.push(
          defineTool({
            name: toolName,
            label: `${serverName}: ${mcpTool.title ?? mcpTool.name}`,
            description: mcpTool.description ?? `MCP tool ${mcpTool.name} from ${serverName}`,
            parameters: normalizeInputSchema(mcpTool.inputSchema) as never,
            execute: async (_toolCallId, params) => {
              const result = await client.callTool({
                name: mcpTool.name,
                arguments: (params ?? {}) as Record<string, unknown>,
              });
              const content = Array.isArray(result.content)
                ? result.content.flatMap((part) => {
                    if (part.type === "text") return [{ type: "text" as const, text: part.text }];
                    return [{ type: "text" as const, text: JSON.stringify(part) }];
                  })
                : [{ type: "text" as const, text: JSON.stringify(result) }];
              return {
                content,
                details: {
                  server: serverName,
                  tool: mcpTool.name,
                  mcpResult: result.structuredContent ?? null,
                } as unknown as Record<string, never>,
              };
            },
          }) as unknown as PiToolDefinition,
        );
      }
      log(`mcp: ${serverName} connected (${listed.tools.length} tools)`);
    }),
  );

  return {
    tools,
    async close() {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    },
  };
}
