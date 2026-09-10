import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const paletteModeSchema = z.enum(["vivid", "soft", "high_contrast"]);
export type PaletteMode = z.output<typeof paletteModeSchema>;

export const activitySettings = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({
    palette: paletteModeSchema.default("vivid"),
  }),
});

export const DEFAULT_PALETTE_MODE: PaletteMode = "vivid";
