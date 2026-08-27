import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin";
import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const reasoningDisplayModeSchema = z.enum(["collapsed", "expand_last", "expanded"]);
export type ReasoningDisplayMode = z.output<typeof reasoningDisplayModeSchema>;

export const DEFAULT_REASONING_DISPLAY_MODE: ReasoningDisplayMode = "expand_last";

export const reasoningSettingsSchema = z.object({
  mode: reasoningDisplayModeSchema,
});
export type ReasoningSettings = z.output<typeof reasoningSettingsSchema>;

export const getReasoningSettingsRpc = defineRpc({
  name: "reasoning-display.settings.get",
  input: z.object({}),
  output: reasoningSettingsSchema,
});

export const setReasoningSettingsRpc = defineRpc({
  name: "reasoning-display.settings.set",
  input: reasoningSettingsSchema,
  output: reasoningSettingsSchema,
});

export const reasoningItemDataSchema = z.object({
  text: z.string(),
});

export const REASONING_RENDERER_KIND = "reasoning-display";
export const REASONING_RENDERER_VERSION = 1;
export const reasoningSettingsQueryKey = ["reasoning-display", "settings"] as const;

export function formatThinkingText(text: string): string {
  if (!text || typeof text !== "string") return "";

  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(/(\*\*[^*\s\n](?:[^*\n]*?[^*\s\n])?\*\*)\s*(?=\*\*)/g, "$1\n\n");
    })
    .join("");
}

type ReasoningTransformer = PluginTimelineTransformerContribution<"reasoning">["transform"];

export const transformReasoning: ReasoningTransformer = ({ item }) => ({
  items: [
    {
      type: "plugin",
      kind: REASONING_RENDERER_KIND,
      version: REASONING_RENDERER_VERSION,
      data: { text: formatThinkingText(item.text) },
    },
  ],
});
