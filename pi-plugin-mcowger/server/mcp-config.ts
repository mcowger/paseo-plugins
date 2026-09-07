import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import type { ProviderMcpServerConfig } from "@getpaseo/plugin/server/provider";

export interface PiTempFile {
  path: string;
  cleanup: () => void;
}

interface PiMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: false;
  oauth?: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolvePiAgentDir(env: Record<string, string> | undefined): string {
  const configured = env?.PI_CODING_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) {
    return join(homedir(), ".pi", "agent");
  }
  if (configured === "~") {
    return homedir();
  }
  if (configured.startsWith("~/")) {
    return resolvePath(homedir(), configured.slice(2));
  }
  return resolvePath(configured);
}

function readPiGlobalMcpConfig(env: Record<string, string> | undefined): Record<string, unknown> {
  const globalConfigPath = join(resolvePiAgentDir(env), "mcp.json");
  if (!existsSync(globalConfigPath)) {
    return {};
  }

  let globalConfig: unknown;
  try {
    globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse Pi MCP config: ${globalConfigPath}`, { cause: error });
    }
    throw error;
  }
  if (!isRecord(globalConfig)) {
    throw new Error(`Pi MCP config must contain a JSON object: ${globalConfigPath}`);
  }
  return globalConfig;
}

function toPiMcpConfig(config: ProviderMcpServerConfig): PiMcpServerConfig {
  if (config.type === "stdio") {
    return {
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
    };
  }

  return {
    url: config.url,
    ...(config.headers ? { headers: config.headers } : {}),
    auth: false,
    oauth: false,
  };
}

/**
 * Merge Paseo-provided MCP servers into the user's global pi MCP config and
 * write the result to a temp file passed to pi via --mcp-config.
 */
export function createPiMcpConfigFile(
  servers: Readonly<Record<string, ProviderMcpServerConfig>>,
  options?: { piGlobalConfigEnv?: Record<string, string> },
): PiTempFile {
  const globalConfig = options?.piGlobalConfigEnv
    ? readPiGlobalMcpConfig(options.piGlobalConfigEnv)
    : {};
  let configuredServers: Record<string, unknown> = {};
  if (isRecord(globalConfig.mcpServers)) {
    configuredServers = globalConfig.mcpServers;
  } else if (isRecord(globalConfig["mcp-servers"])) {
    configuredServers = globalConfig["mcp-servers"];
  }
  const mcpServers: Record<string, unknown> = { ...configuredServers };
  for (const [name, serverConfig] of Object.entries(servers)) {
    mcpServers[name] = toPiMcpConfig(serverConfig);
  }

  const dir = mkdtempSync(join(tmpdir(), "paseo-pi-mcp-"));
  const filePath = join(dir, "mcp.json");
  const mergedConfig: Record<string, unknown> = { ...globalConfig, mcpServers };
  delete mergedConfig["mcp-servers"];
  writeFileSync(filePath, `${JSON.stringify(mergedConfig, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    path: filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
