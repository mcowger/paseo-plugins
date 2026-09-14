import type { ProviderThinkingOption } from "@getpaseo/plugin/server/provider";

import type { PiModel, PiThinkingLevel } from "./rpc-types.js";

const DEFAULT_THINKING_LEVEL: PiThinkingLevel = "medium";

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
