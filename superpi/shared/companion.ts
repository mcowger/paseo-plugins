import { z } from "zod";

export const companionPrefix = "superpi:v1:";
export const companionStatePrefix = "superpi:state:v1:";
export const tierSchema = z.string().min(1).max(100);
export const companionStateSchema = z.object({
  capabilities: z.array(z.string()),
  settings: z.object({ tier: tierSchema, longContext: z.boolean() }),
  tiers: z.array(tierSchema).optional(),
  contextWindow: z.number().positive().optional(),
  longContextTarget: z.number().int().positive().optional(),
  modelBaselineContextWindow: z.number().int().positive().optional(),
  longContextAvailable: z.boolean().optional(),
  shortContextBudgetTokens: z.number().int().positive().optional(),
  pricingThresholdInputTokens: z.number().int().positive().optional(),
  contextPolicyError: z.string().optional(),
  activeChildren: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
});
export type CompanionState = z.infer<typeof companionStateSchema>;
export const companionStateUpdateSchema = z.object({ version: z.literal(1), sessionKey: z.string(), state: companionStateSchema });

export function formatContextLength(budget: number | undefined): string {
  if (budget === undefined) return "Unknown";
  const roundedThousands = Math.round(budget / 1000);
  return roundedThousands >= 1000 ? `${Math.round(budget / 1_000_000)}M`
    : budget >= 1000 ? `${roundedThousands}K` : String(Math.round(budget));
}

export function contextSettingPresentation(state: CompanionState | undefined, modelContextWindow?: number): { label: string; description: string } {
  const budget = modelContextWindow ?? state?.contextWindow;
  const target = state?.longContextTarget;
  const shortBudget = state?.shortContextBudgetTokens;
  const tokens = (value: number | undefined) => value === undefined ? "unknown" : `${value.toLocaleString("en-US")} tokens`;
  return {
    label: formatContextLength(budget),
    description: `Current Pi budget: ${tokens(budget)}. Short budget: ${tokens(shortBudget)}. Maximum: ${tokens(target)}. Limits supplied by Plexus.${state?.pricingThresholdInputTokens !== undefined ? ` Input pricing threshold: ${tokens(state.pricingThresholdInputTokens)}.` : ""}`,
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
