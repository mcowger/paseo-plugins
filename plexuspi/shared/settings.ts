import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Which Pi model name PlexusPi shows in the Paseo model picker. */
export const modelNameStyleSchema = z.enum(["full", "short"]);
export type ModelNameStyle = z.infer<typeof modelNameStyleSchema>;

export const plexuspiSettings = defineSettings({
  id: "plexuspi",
  scope: "host",
  version: 1,
  schema: z.object({
    modelNameStyle: modelNameStyleSchema.default("full"),
  }),
});

export type PlexuspiSettingsValues = z.output<typeof plexuspiSettings.schema>;

/** Lenient read of the stored style; unknown values fall back to full names. */
export function resolveModelNameStyle(value: unknown): ModelNameStyle {
  const parsed = modelNameStyleSchema.safeParse(value);
  return parsed.success ? parsed.data : "full";
}
