import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const runtimeSettingIdSchema = z.enum(["autoCompaction", "autoRetry", "fastMode", "longContext"]);

export const piRuntimeSettingSchema = z.object({
  id: runtimeSettingIdSchema,
  label: z.string().min(1),
  description: z.string().min(1),
  value: z.boolean(),
}).strict();

export const getPiRuntimeSettingsRpc = defineRpc({
  name: "pi-runtime-settings.get",
  input: z.object({ agentId: z.string().trim().min(1).max(160) }).strict(),
  output: z.object({ settings: z.array(piRuntimeSettingSchema).max(16) }).strict(),
});

export const updatePiRuntimeSettingRpc = defineRpc({
  name: "pi-runtime-settings.update",
  input: z.object({
    agentId: z.string().trim().min(1).max(160),
    id: runtimeSettingIdSchema,
    value: z.boolean(),
  }).strict(),
  output: z.object({ settings: z.array(piRuntimeSettingSchema).max(16) }).strict(),
});

export type PiRuntimeSetting = z.output<typeof piRuntimeSettingSchema>;
export type PiRuntimeSettingId = z.output<typeof runtimeSettingIdSchema>;
