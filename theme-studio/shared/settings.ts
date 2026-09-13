import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { BUILTIN_PRESETS, TAILWIND_PROMPT_EXAMPLE } from "./presets.js";
import type { ThemeAppearance, ThemeStudioTokens } from "./theme-types.js";

const hexRegex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const themeTokensSchema = z.object({
  background: z.string().regex(hexRegex),
  foreground: z.string().regex(hexRegex),
  raised: z.string().regex(hexRegex),
  control: z.string().regex(hexRegex),
  border: z.string().regex(hexRegex),
  ring: z.string().regex(hexRegex),
  mutedForeground: z.string().regex(hexRegex),
  accent: z.string().regex(hexRegex),
});

export const presetSchema = z.object({
  id: z.string(),
  name: z.string(),
  appearance: z.enum(["dark", "light"]),
  tokens: themeTokensSchema,
  rawInput: z.string().optional(),
});

export const themeStudioSettings = defineSettings({
  id: "theme-studio",
  scope: "host",
  version: 2,
  schema: z.object({
    rawInput: z.string().default(TAILWIND_PROMPT_EXAMPLE),
    appearance: z.enum(["dark", "light"]).default("dark"),
    tokens: themeTokensSchema.default(BUILTIN_PRESETS[0].tokens),
    activePresetId: z.string().default(BUILTIN_PRESETS[0].id),
    autoApply: z.boolean().default(true),
    savedPresets: z.array(presetSchema).default([]),
  }),
  migrate(values, fromVersion) {
    if (fromVersion >= 2 || typeof values !== "object" || values === null) return values;
    const legacy = values as { appearance?: ThemeAppearance; tokens?: ThemeStudioTokens; rawInput?: string };
    const matchingPreset = BUILTIN_PRESETS.find(
      (preset) =>
        preset.appearance === legacy.appearance &&
        JSON.stringify(preset.tokens) === JSON.stringify(legacy.tokens) &&
        (legacy.rawInput === undefined || preset.rawInput === legacy.rawInput),
    );
    return { ...legacy, activePresetId: matchingPreset?.id ?? "custom" };
  },
});

export type ThemeStudioSettings = z.infer<typeof themeStudioSettings.schema>;
