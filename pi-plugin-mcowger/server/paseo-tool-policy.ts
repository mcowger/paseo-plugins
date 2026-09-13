import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PASEO_HOME_ENV = "PASEO_HOME";
const PASEO_CONFIG_FILENAME = "config.json";
const PI_PROVIDER_ID = "pi";

export interface PaseoToolPolicy {
  enabled: boolean;
  disabledTools: ReadonlySet<string>;
}

function defaultPolicy(): PaseoToolPolicy {
  return { enabled: true, disabledTools: new Set() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPaseoConfigPath(): string {
  const paseoHome = process.env[PASEO_HOME_ENV]?.trim() || join(homedir(), ".paseo");
  return join(paseoHome, PASEO_CONFIG_FILENAME);
}

export function readPiPaseoToolPolicy(log?: (message: string) => void): PaseoToolPolicy {
  const configPath = getPaseoConfigPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.(
        `paseo: failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return defaultPolicy();
  }

  if (!isRecord(parsed)) return defaultPolicy();
  const agents = parsed.agents;
  if (!isRecord(agents) || !isRecord(agents.providers)) return defaultPolicy();
  const pi = agents.providers[PI_PROVIDER_ID];
  if (!isRecord(pi) || !isRecord(pi.paseoTools)) return defaultPolicy();

  const disabledTools = Array.isArray(pi.paseoTools.disabledTools)
    ? pi.paseoTools.disabledTools.filter((tool): tool is string => typeof tool === "string")
    : [];
  return {
    enabled: pi.paseoTools.enabled !== false,
    disabledTools: new Set(disabledTools),
  };
}

export function isPaseoToolAllowed(policy: PaseoToolPolicy, toolName: string): boolean {
  return policy.enabled && !policy.disabledTools.has(toolName);
}
