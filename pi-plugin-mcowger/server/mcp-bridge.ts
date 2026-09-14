import { Client, SSEClientTransport, StdioClientTransport, StreamableHTTPClientTransport } from "./pi-sdk.js";
import { defineTool } from "./pi-sdk.js";

import type { PiToolDefinition } from "../shared/pi-sdk-types.js";
import type { ProviderMcpServerConfig } from "@getpaseo/plugin/server/provider";

import { filterPaseoToolNames, filterPaseoToolNamesForProfile } from "./tool-policy.js";
import type { PaseoHostToolPolicy } from "../shared/tool-policy.js";

const PASEO_MCP_PATHNAME = "/mcp/agents";

export type McpBridgeToolSource = "paseo" | "external";

export interface McpBridgeToolMetadata {
  piToolName: string;
  mcpToolName: string;
  serverName: string;
  source: McpBridgeToolSource;
}

export interface McpBridgeHandle {
  tools: PiToolDefinition[];
  toolMetadata: ReadonlyMap<string, McpBridgeToolMetadata>;
  paseoToolCount: number;
  visiblePaseoToolCount: number;
  paseoToolNames: string[];
  visiblePaseoToolNames: string[];
  getToolMetadata(piToolName: string): McpBridgeToolMetadata | undefined;
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

function isPaseoMcpServer(config: ProviderMcpServerConfig): boolean {
  if (config.type !== "http" && config.type !== "sse") return false;
  try {
    return new URL(config.url).pathname.replace(/\/+$/, "") === PASEO_MCP_PATHNAME;
  } catch {
    return false;
  }
}

/**
 * Connect Paseo-injected MCP servers directly and expose their tools as pi
 * custom tools named `mcp_<server>_<tool>`. Each session gets its own clients,
 * so concurrent sessions with different server sets stay isolated.
 */
export async function createMcpBridge(
  servers: Readonly<Record<string, ProviderMcpServerConfig>>,
  paseoToolPolicy: PaseoHostToolPolicy,
  log: (message: string) => void,
  allowedPaseoToolNames?: readonly string[],
): Promise<McpBridgeHandle> {
  const clients: Client[] = [];
  const closedClients = new Set<Client>();
  const closeClient = async (client: Client): Promise<void> => {
    if (closedClients.has(client)) return;
    closedClients.add(client);
    await client.close().catch(() => undefined);
  };
  const tools: PiToolDefinition[] = [];
  const toolMetadata = new Map<string, McpBridgeToolMetadata>();
  const claimedToolNames = new Set<string>();
  const collidingToolNames = new Set<string>();
  const paseoToolNames: string[] = [];
  const visiblePaseoToolNames: string[] = [];
  let paseoToolCount = 0;
  let visiblePaseoToolCount = 0;

  const entries = Object.entries(servers);
  try {
    const results = await Promise.allSettled(
      entries.map(async ([serverName, config]) => {
      const isPaseoServer = isPaseoMcpServer(config);
      const client = new Client({ name: "pi-plugin-mcowger", version: "0.0.0" });
      try {
        await client.connect(toTransport(config));
      } catch (error) {
        log(
          `mcp: failed to connect to ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await closeClient(client);
        return;
      }
      clients.push(client);
      let listed;
      try {
        listed = await client.listTools();
      } catch (error) {
        log(
          `mcp: failed to list tools from ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await closeClient(client);
        return;
      }
      const visibleTools = isPaseoServer
        ? listed.tools.filter((tool) => allowedPaseoToolNames
          ? filterPaseoToolNamesForProfile([tool.name], allowedPaseoToolNames).length > 0
          : filterPaseoToolNames([tool.name], paseoToolPolicy).length > 0)
        : listed.tools;
      if (isPaseoServer) {
        paseoToolCount += listed.tools.length;
        visiblePaseoToolCount += visibleTools.length;
      }
      const serverTools: PiToolDefinition[] = [];
      for (const mcpTool of listed.tools) {
        const toolName = `mcp_${sanitizeNamePart(serverName)}_${sanitizeNamePart(mcpTool.name)}`;
        if (isPaseoServer) paseoToolNames.push(toolName);
        if (!visibleTools.includes(mcpTool)) continue;
        if (claimedToolNames.has(toolName)) {
          collidingToolNames.add(toolName);
          toolMetadata.delete(toolName);
          log(`mcp: skipped colliding tool name ${toolName}`);
          continue;
        }
        claimedToolNames.add(toolName);
        if (isPaseoServer) visiblePaseoToolNames.push(toolName);
        toolMetadata.set(toolName, {
          piToolName: toolName,
          mcpToolName: mcpTool.name,
          serverName,
          source: isPaseoServer ? "paseo" : "external",
        });
        const definedTool = defineTool({
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
          }) as unknown as PiToolDefinition;
        serverTools.push(definedTool);
      }
      log(
        isPaseoServer
          ? `mcp: ${serverName} connected (${visibleTools.length}/${listed.tools.length} tools after Paseo host policy)`
          : `mcp: ${serverName} connected (${visibleTools.length} tools)`,
      );
      return serverTools;
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      if (result.value) tools.push(...result.value.filter((tool) => !collidingToolNames.has(tool.name)));
    }
  } catch (error) {
    await Promise.all(clients.map((client) => closeClient(client)));
    throw error;
  }

  return {
    tools,
    toolMetadata,
    paseoToolCount,
    visiblePaseoToolCount,
    paseoToolNames,
    visiblePaseoToolNames,
    getToolMetadata(piToolName) {
      return toolMetadata.get(piToolName);
    },

    async close() {
      await Promise.all(clients.map((client) => closeClient(client)));
    },
  };
}
