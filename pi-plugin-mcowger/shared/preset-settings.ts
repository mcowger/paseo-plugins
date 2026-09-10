import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PI_PROVIDER_ID = "pi-plugin-mcowger";
export const PI_PRESET_SETTINGS_ID = "pi-presets";

const presetIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]*$/, "Use lowercase letters, numbers, and hyphens");
const nonEmptyString = z.string().trim().min(1);

export const piPresetSchema = z.object({
  id: presetIdSchema,
  name: nonEmptyString.max(80),
  model: nonEmptyString.max(240),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  tools: z.array(nonEmptyString.max(160)).max(128).optional(),
  appendSystemPrompt: nonEmptyString.max(20_000).optional(),
});

const piPresetsValuesSchema = z
  .object({
    presets: z.array(piPresetSchema).max(100).default([]),
  })
  .superRefine((values, context) => {
    const seen = new Set<string>();
    values.presets.forEach((preset, index) => {
      if (seen.has(preset.id)) {
        context.addIssue({
          code: "custom",
          path: ["presets", index, "id"],
          message: `Duplicate preset id: ${preset.id}`,
        });
      }
      seen.add(preset.id);
    });
  });

export const piPresetsSettings = defineSettings({
  id: PI_PRESET_SETTINGS_ID,
  scope: "host",
  version: 1,
  schema: piPresetsValuesSchema,
});

export const syncPiPresetsRpc = defineRpc({
  name: "pi-presets.sync",
  input: z.object({
    revision: z.string(),
    previousRevision: z.string().nullable(),
    values: piPresetsSettings.schema,
  }),
  output: z.object({ revision: z.string() }),
});

export type PiPresetDefinition = z.output<typeof piPresetSchema>;
export type PiPresetsSettings = z.output<typeof piPresetsSettings.schema>;
