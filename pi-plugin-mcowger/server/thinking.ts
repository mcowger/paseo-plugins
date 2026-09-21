import type { ProviderModel, ProviderThinkingOption } from "@getpaseo/plugin/server/provider";

import type { PiModel, PiThinkingLevel } from "./rpc-types.js";

const DEFAULT_THINKING_LEVEL: PiThinkingLevel = "medium";

export function normalizePiModelLabel(label: string): string {
  const normalizedLabel = label.trim().replace(/[_\s]+/g, " ");
  const vendorSeparatorIndex = normalizedLabel.indexOf(": ");
  if (vendorSeparatorIndex === -1) {
    return normalizedLabel;
  }

  return normalizedLabel.slice(vendorSeparatorIndex + 2).trim();
}

function isPiThinkingLevel(value: string | null | undefined): value is PiThinkingLevel {
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

export function normalizePiThinkingOption(value: string | null | undefined): PiThinkingLevel | null {
  if (!value) {
    return null;
  }
  return isPiThinkingLevel(value) ? value : null;
}

/**
 * Central catalog mapping shared by the `catalog` RPC and live
 * `session.config` emission so the two cannot diverge. Mirrors upstream
 * `mapPiModel` + `transformPiModels` (`agent.ts` ~313, ~1198), adapted to
 * the plugin `ProviderModel` shape: the full native `provider/id` stays in
 * `description`, the display `label` is normalized, and thinking options
 * honor `thinkingLevelMap` (upstream advertises all levels; the plugin
 * deliberately filters null mappings — see `thinkingConfigForModel`).
 */
export function mapPiCatalogModel(model: PiModel): ProviderModel {
  const rawLabel = `${model.provider}/${model.name ?? model.id}`;
  const segments = rawLabel.split("/").filter((segment) => segment.length > 0);
  const lastSegment = segments.at(-1);
  return {
    id: `${model.provider}/${model.id}`,
    label: lastSegment ? normalizePiModelLabel(lastSegment) : rawLabel,
    description: `${model.provider}/${model.id}`,
    ...(model.contextWindow ? { contextWindowMaxTokens: model.contextWindow } : {}),
    ...(model.reasoning ? thinkingConfigForModel(model) : {}),
  };
}

const THINKING_OPTIONS: ReadonlyArray<{
  id: PiThinkingLevel;
  label: string;
  description: string;
}> = [
  { id: "off", label: "Off", description: "No extra reasoning" },
  { id: "minimal", label: "Minimal", description: "Light reasoning" },
  { id: "low", label: "Low", description: "Faster reasoning" },
  { id: "medium", label: "Medium", description: "Balanced reasoning" },
  { id: "high", label: "High", description: "Deeper reasoning" },
  { id: "xhigh", label: "XHigh", description: "Very deep reasoning" },
  { id: "max", label: "Max", description: "Extreme reasoning" },
];

export function thinkingConfigForModel(model: PiModel): {
  thinkingOptions: ProviderThinkingOption[];
  defaultThinkingOptionId: PiThinkingLevel | undefined;
} {
  if (!model.reasoning) return { thinkingOptions: [], defaultThinkingOptionId: undefined };

  const supported = THINKING_OPTIONS.filter((option) => {
    const mapped = model.thinkingLevelMap?.[option.id];
    if (mapped === null) return false;
    return option.id !== "xhigh" && option.id !== "max" || mapped !== undefined;
  });
  const defaultIndex = THINKING_OPTIONS.findIndex((option) => option.id === DEFAULT_THINKING_LEVEL);
  const defaultOption = supported.find((option) => THINKING_OPTIONS.indexOf(option) >= defaultIndex) ?? supported.at(-1);
  const defaultThinkingOptionId = defaultOption?.id;

  return {
    thinkingOptions: supported.map((option) => ({
      ...option,
      ...(option.id === defaultThinkingOptionId ? { isDefault: true } : {}),
    })),
    defaultThinkingOptionId,
  };
}
