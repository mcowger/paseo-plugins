import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderMode } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

import { isPiThinkingLevel } from "./thinking.js";
import { resolvePiAgentDir } from "./mcp-config.js";

const presetSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    thinkingLevel: z.string().optional(),
    tools: z.array(z.string()).optional(),
    instructions: z.string().optional(),
  })
  .passthrough();

const presetsConfigSchema = z.record(z.string(), presetSchema);

export type PiPreset = z.output<typeof presetSchema>;
export type PiPresetsConfig = Record<string, PiPreset>;

function readPresetsFile(path: string): PiPresetsConfig {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = presetsConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Load pi presets exactly like the preset.ts example extension: global
 * ~/.pi/agent/presets.json merged with <cwd>/.pi/presets.json, project winning.
 */
export function loadPiPresets(cwd: string, env?: Record<string, string>): PiPresetsConfig {
  const globalPresets = readPresetsFile(join(resolvePiAgentDir(env), "presets.json"));
  const projectPresets = readPresetsFile(join(cwd, ".pi", "presets.json"));
  return { ...globalPresets, ...projectPresets };
}

function capitalize(label: string): string {
  return label.length === 0 ? label : label.charAt(0).toUpperCase() + label.slice(1);
}

function describePreset(preset: PiPreset): string | undefined {
  const parts: string[] = [];
  if (preset.provider && preset.model) {
    parts.push(`${preset.provider}/${preset.model}`);
  } else if (preset.model) {
    parts.push(preset.model);
  }
  if (preset.thinkingLevel && isPiThinkingLevel(preset.thinkingLevel)) {
    parts.push(`thinking: ${preset.thinkingLevel}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function presetsToModes(presets: PiPresetsConfig): ProviderMode[] {
  return Object.entries(presets).map(([name, preset]) => ({
    id: name,
    label: capitalize(name),
    icon: "Bot",
    ...(describePreset(preset) ? { description: describePreset(preset) } : {}),
  }));
}

/**
 * Extract the active preset name from pi session entries: the latest custom
 * entry with customType "preset-state" (appended by the extension on every
 * turn_start while a preset is active).
 */
export function readActivePresetName(entries: unknown): string | null {
  if (!Array.isArray(entries)) {
    return null;
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (
      typeof entry === "object" &&
      entry !== null &&
      Reflect.get(entry, "type") === "custom" &&
      Reflect.get(entry, "customType") === "preset-state"
    ) {
      const data = Reflect.get(entry, "data");
      if (typeof data === "object" && data !== null) {
        const name = Reflect.get(data, "name");
        if (typeof name === "string" && name.trim().length > 0) {
          return name;
        }
      }
    }
  }
  return null;
}
