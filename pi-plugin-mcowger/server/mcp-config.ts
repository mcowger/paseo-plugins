import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ProviderMcpServerConfig } from "@getpaseo/plugin/server/provider";

export interface PiMcpConfigFile {
  path: string;
  cleanup(): void;
}

export function createPiMcpConfig(
  servers: Readonly<Record<string, ProviderMcpServerConfig>>,
  env: Readonly<Record<string, string>>,
): PiMcpConfigFile | null {
  if (Object.keys(servers).length === 0) return null;
  const globalConfig = readPiGlobalMcpConfig(env);
  const configuredServers = isRecord(globalConfig.mcpServers)
    ? globalConfig.mcpServers
    : isRecord(globalConfig["mcp-servers"])
      ? globalConfig["mcp-servers"]
      : {};
  const mcpServers = {
    ...configuredServers,
    ...Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, toPiMcpServer(server)])),
  };
  const directory = mkdtempSync(join(tmpdir(), "paseo-pi-mcp-"));
  const path = join(directory, "mcp.json");
  try {
    const mergedConfig: Record<string, unknown> = { ...globalConfig, mcpServers };
    delete mergedConfig["mcp-servers"];
    writeFileSync(path, `${JSON.stringify(mergedConfig, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function readPiGlobalMcpConfig(env: Readonly<Record<string, string>>): Record<string, unknown> {
  const configured = env.PI_CODING_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured ? resolvePiDirectory(configured) : join(homedir(), ".pi", "agent");
  const configPath = join(agentDir, "mcp.json");
  if (!existsSync(configPath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse Pi MCP config: ${configPath}`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`Pi MCP config must contain a JSON object: ${configPath}`);
  return parsed;
}

function resolvePiDirectory(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPiMcpServer(server: ProviderMcpServerConfig): Record<string, unknown> {
  if (server.type === "stdio") return { command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}) };
  return { url: server.url, ...(server.headers ? { headers: server.headers } : {}), auth: false, oauth: false };
}
