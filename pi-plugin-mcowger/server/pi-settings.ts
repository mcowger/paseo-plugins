import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolvePiAgentDir } from "./presets.js";

export interface PiUserSettings {
  enabledModels?: string[];
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  modelThinkingLevels?: Record<string, string>;
}

function readSettingsFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
}

/**
 * Read pi's settings the way pi merges them: global ~/.pi/agent/settings.json
 * plus project <cwd>/.pi/settings.json, project winning per key.
 */
export function readPiUserSettings(
  cwd: string | undefined,
  env?: Record<string, string>,
): PiUserSettings {
  const globalSettings = readSettingsFile(join(resolvePiAgentDir(env), "settings.json"));
  const projectSettings = cwd ? readSettingsFile(join(cwd, ".pi", "settings.json")) : {};
  const merged = { ...globalSettings, ...projectSettings };

  return {
    enabledModels: stringArray(merged.enabledModels),
    defaultProvider:
      typeof merged.defaultProvider === "string" ? merged.defaultProvider : undefined,
    defaultModel: typeof merged.defaultModel === "string" ? merged.defaultModel : undefined,
    defaultThinkingLevel:
      typeof merged.defaultThinkingLevel === "string"
        ? merged.defaultThinkingLevel
        : undefined,
    modelThinkingLevels: stringRecord(merged.modelThinkingLevels),
  };
}

/** pi `--models`-style pattern matching: exact provider/id, or "*" wildcards. */
export function modelMatchesPatterns(fullId: string, patterns: readonly string[]): boolean {
  for (const raw of patterns) {
    // Strip an optional :thinking suffix (e.g. "anthropic/*:high").
    const pattern = raw.replace(/:[a-z]+$/i, (suffix) =>
      /:(off|minimal|low|medium|high|xhigh|max)$/i.test(suffix) ? "" : suffix,
    );
    if (pattern.includes("*")) {
      const regex = new RegExp(
        `^${pattern.split("*").map(escapeRegex).join(".*")}$`,
        "i",
      );
      if (regex.test(fullId)) {
        return true;
      }
      continue;
    }
    if (pattern.toLowerCase() === fullId.toLowerCase()) {
      return true;
    }
  }
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
