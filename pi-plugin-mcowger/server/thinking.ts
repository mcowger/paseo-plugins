import type { ProviderModel, ProviderThinkingOption } from "@getpaseo/plugin/server/provider";

import { PI_THINKING_LEVELS, type PiModel, type PiThinkingLevel } from "../shared/rpc-types.js";

export const DEFAULT_PI_THINKING_LEVEL: PiThinkingLevel = "medium";

const PI_THINKING_OPTION_LABELS: Record<PiThinkingLevel, { label: string; description: string }> =
  {
    off: { label: "Off", description: "No extra reasoning" },
    minimal: { label: "Minimal", description: "Light reasoning" },
    low: { label: "Low", description: "Faster reasoning" },
    medium: { label: "Medium", description: "Balanced reasoning" },
    high: { label: "High", description: "Deeper reasoning" },
    xhigh: { label: "XHigh", description: "Very deep reasoning" },
    max: { label: "Max", description: "Extreme reasoning" },
  };

const EXTENDED_LEVELS: ReadonlySet<PiThinkingLevel> = new Set(["xhigh", "max"]);

export function isPiThinkingLevel(value: string | null | undefined): value is PiThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

export function normalizePiThinkingLevel(value: string | null | undefined): PiThinkingLevel | null {
  if (!value) return null;
  return isPiThinkingLevel(value) ? value : null;
}

/**
 * Levels a model supports, per pi's thinkingLevelMap semantics:
 * - no map at all -> every level is supported (models without explicit mapping);
 * - a level mapped to null -> disabled;
 * - extended levels (xhigh/max) require an explicit non-null mapping;
 * - base levels missing from the map fall back to pi's default API mapping (supported).
 */
export function supportedThinkingLevels(model: PiModel): PiThinkingLevel[] {
  if (model.reasoning !== true) {
    return [];
  }
  const map = model.thinkingLevelMap;
  if (!map) {
    return [...PI_THINKING_LEVELS];
  }
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) {
      return false;
    }
    if (EXTENDED_LEVELS.has(level)) {
      return mapped !== undefined;
    }
    return true;
  });
}

/**
 * Resolve pi's default for a requested level: clamp upward first, then fall back
 * to the highest remaining lower level (pi's own clamping order).
 */
export function clampThinkingLevel(
  requested: PiThinkingLevel,
  supported: readonly PiThinkingLevel[],
): PiThinkingLevel | null {
  if (supported.length === 0) {
    return null;
  }
  if (supported.includes(requested)) {
    return requested;
  }
  const requestedIndex = PI_THINKING_LEVELS.indexOf(requested);
  for (let i = requestedIndex + 1; i < PI_THINKING_LEVELS.length; i += 1) {
    const level = PI_THINKING_LEVELS[i];
    if (supported.includes(level)) {
      return level;
    }
  }
  for (let i = requestedIndex - 1; i >= 0; i -= 1) {
    const level = PI_THINKING_LEVELS[i];
    if (supported.includes(level)) {
      return level;
    }
  }
  return null;
}

export function thinkingOptionsForModel(model: PiModel): ProviderThinkingOption[] | undefined {
  const supported = supportedThinkingLevels(model);
  if (supported.length === 0) {
    return undefined;
  }
  const defaultLevel = clampThinkingLevel(DEFAULT_PI_THINKING_LEVEL, supported);
  return supported.map((level) => ({
    id: level,
    label: PI_THINKING_OPTION_LABELS[level].label,
    description: PI_THINKING_OPTION_LABELS[level].description,
    ...(level === defaultLevel ? { isDefault: true } : {}),
  }));
}

export function defaultThinkingOptionForModel(
  model: PiModel,
  preferredLevel?: string | null,
): string | undefined {
  const supported = supportedThinkingLevels(model);
  if (supported.length === 0) {
    return undefined;
  }
  // pi's own resolution order: per-model override wins over the global default,
  // both clamped to what the model actually supports.
  const requested = normalizePiThinkingLevel(preferredLevel) ?? DEFAULT_PI_THINKING_LEVEL;
  return clampThinkingLevel(requested, supported) ?? undefined;
}

export function normalizePiModelLabel(label: string): string {
  const normalizedLabel = label.trim().replace(/[_\s]+/g, " ");
  const vendorSeparatorIndex = normalizedLabel.indexOf(": ");
  if (vendorSeparatorIndex === -1) {
    return normalizedLabel;
  }
  return normalizedLabel.slice(vendorSeparatorIndex + 2).trim();
}

export interface PiModelReference {
  provider?: string;
  id: string;
}

export function parsePiModelReference(modelId: string | null): PiModelReference | null {
  if (!modelId) {
    return null;
  }
  if (modelId.includes("/")) {
    const [provider, ...rest] = modelId.split("/");
    const id = rest.join("/");
    if (provider && id) {
      return { provider, id };
    }
  }
  if (modelId.includes(":")) {
    const [provider, ...rest] = modelId.split(":");
    const id = rest.join(":");
    if (provider && id) {
      return { provider, id };
    }
  }
  return { id: modelId };
}

export function mapPiModel(model: PiModel, thinkingPreference?: string | null): ProviderModel {
  const fullId = `${model.provider}/${model.id}`;
  const rawLabel = `${model.provider}/${model.name ?? model.id}`;
  const segments = rawLabel.split("/").filter((segment) => segment.length > 0);
  const tail = segments.at(-1);
  const thinkingOptions = thinkingOptionsForModel(model);
  return {
    id: fullId,
    label: tail && rawLabel.includes("/") ? normalizePiModelLabel(tail) : rawLabel,
    description: fullId,
    metadata: {
      provider: model.provider,
      modelId: model.id,
    },
    ...(typeof model.contextWindow === "number"
      ? { contextWindowMaxTokens: model.contextWindow }
      : {}),
    ...(thinkingOptions ? { thinkingOptions } : {}),
    ...(thinkingOptions ? { defaultThinkingOptionId: defaultThinkingOptionForModel(model, thinkingPreference) } : {}),
  };
}
