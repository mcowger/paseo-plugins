import type { ProviderMode } from "@getpaseo/plugin/server/provider";

import type { PiPresetDefinition } from "../shared/preset-settings.js";
import { isPiThinkingLevel } from "./thinking.js";

export type PiPreset = PiPresetDefinition;
export type PiPresetsConfig = Record<string, PiPreset>;

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function capitalize(label: string): string {
  return label.length === 0 ? label : label.charAt(0).toUpperCase() + label.slice(1);
}

function describePreset(preset: PiPreset): string | undefined {
  const parts: string[] = [];
  if (preset.model) {
    parts.push(preset.model);
  }
  if (preset.thinkingLevel && isPiThinkingLevel(preset.thinkingLevel)) {
    parts.push(`thinking: ${preset.thinkingLevel}`);
  }
  if (preset.tools !== undefined) {
    parts.push(`tools: ${preset.tools.length > 0 ? preset.tools.join(", ") : "none"}`);
  }
  if (preset.appendSystemPrompt) {
    parts.push(`prompt: ${truncate(preset.appendSystemPrompt.replace(/\s+/g, " "), 32)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function presetsToModes(
  presets: PiPresetsConfig,
  activePresetName?: string | null,
  activePresetModified = false,
): ProviderMode[] {
  return Object.entries(presets).map(([id, preset]) => {
    const isModified = id === activePresetName && activePresetModified;
    const label = preset.name || capitalize(id);
    return {
      id,
      label: isModified ? `${label} (modified)` : label,
      icon: "Bot",
      ...(describePreset(preset) ? { description: describePreset(preset) } : {}),
    };
  });
}

/**
 * Extract the active preset name from pi session entries: the latest custom
 * entry with customType "preset-state" (appended by the provider on every
 * preset change while a preset is active).
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
