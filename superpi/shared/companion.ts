import { z } from "zod";

export const companionPrefix = "superpi:v1:";
export const tierSchema = z.enum(["default", "fast", "flex", "ultrafast"]);
export const companionStateSchema = z.object({
  capabilities: z.array(z.string()),
  settings: z.object({ tier: tierSchema, longContext: z.boolean() }),
  contextWindow: z.number().positive().optional(),
  longContextTarget: z.number().int().positive().optional(),
  modelBaselineContextWindow: z.number().int().positive().optional(),
  activeChildren: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
});
export type CompanionState = z.infer<typeof companionStateSchema>;

export function contextSettingPresentation(state: CompanionState | undefined, modelContextWindow?: number): { label: string; description: string } {
  const enabled = state?.settings.longContext ?? false;
  const budget = modelContextWindow ?? state?.contextWindow;
  const target = state?.longContextTarget;
  const baseline = state?.modelBaselineContextWindow ?? modelContextWindow;
  const tokens = (value: number | undefined) => value === undefined ? "unknown" : `${value.toLocaleString("en-US")} tokens`;
  return {
    label: `Long context: ${enabled ? "On" : "Off"} (${tokens(budget)})`,
    description: `Current Pi budget: ${tokens(budget)}. Model baseline: ${tokens(baseline)}. Expansion target: ${tokens(target)}. This is a budget override, not discovered backend capacity.`,
  };
}
export const companionReplySchema = z.object({
  version: z.literal(1),
  sessionKey: z.string(),
  requestId: z.string(),
  operation: z.enum(["hello", "get-state", "configure", "rewind", "compact"]),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type CompanionOperation = z.infer<typeof companionReplySchema>["operation"];
