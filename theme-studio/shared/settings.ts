import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { BUILTIN_PRESETS, TAILWIND_PROMPT_EXAMPLE } from "./presets.js";

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
  version: 1,
  schema: z.object({
    rawInput: z.string().default(TAILWIND_PROMPT_EXAMPLE),
    appearance: z.enum(["dark", "light"]).default("dark"),
    tokens: themeTokensSchema.default(BUILTIN_PRESETS[0].tokens),
    autoApply: z.boolean().default(true),
    savedPresets: z.array(presetSchema).default([]),
  }),
});

export type ThemeStudioSettings = z.infer<typeof themeStudioSettings.schema>;
