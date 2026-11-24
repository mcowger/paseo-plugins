import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** User-facing options for the turn-speed plugin. */
export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Smoothing window for the live tok/s number, in seconds. */
    liveWindowSec: z.union([z.literal(1), z.literal(2), z.literal(5)]).default(2),
    /** What the pill leads with, while running and after the turn. */
    numerator: z.enum(["live", "decode", "turn"]).default("live"),
    /** Keep pills visible for agents with no locally observed turn. */
    showIdlePills: z.boolean().default(false),
    /** Manual chars/token override for the live estimate; null means auto. */
    manualCharsPerToken: z.number().min(1).max(12).nullable().default(null),
    /** Token count rendering: 1.2k or 1 240. */
    tokenFormat: z.enum(["compact", "plain"]).default("compact"),
    /** How the provider reports cache reads relative to the prompt counter. */
    cacheCounting: z.enum(["auto", "inclusive", "separate"]).default("auto"),
    /** Usage steps implying a faster decode than this are misattributed
     * (late usage from a previous message) and get dropped from the turn. */
    maxPlausibleTokPerSec: z.number().int().min(50).max(100000).default(400),
  }),
});

export type Preferences = z.output<typeof preferences.schema>;

export const DEFAULT_PREFERENCES: Preferences = preferences.schema.parse({});

/** Machine-written document: per-model chars/token calibration. */
export const meterState = defineSettings({
  id: "meter-state",
  scope: "host",
  version: 1,
  schema: z.object({
    /** model id -> chars per output token, clamped to 2..8. */
    calibration: z.record(z.string(), z.number().min(1).max(12)).default({}),
  }),
});

export type MeterStateDoc = z.output<typeof meterState.schema>;

export const DEFAULT_METER_STATE: MeterStateDoc = meterState.schema.parse({});
