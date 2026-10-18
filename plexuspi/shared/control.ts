import { z } from "zod";

/** Prefix on every `ctx.ui.notify` message that carries a control reply. */
export const controlReplyPrefix = "plexuspi:v1:";
/** Prefix on unsolicited live-state notifications. */
export const controlStatePrefix = "plexuspi:state:v1:";

/** Pi slash command carrying base64url-encoded JSON requests. */
export const CONTROL_COMMAND_NAME = "plexuspi-control";

export const tierSchema = z.string().min(1).max(100);

/**
 * Live control state reported by `hello`, `get-state`, `configure`, `rewind`,
 * and `plexuspi:state:v1:` notifications. Mirrors `PlexuspiStateSchema` in the
 * plexus-pi extension; optional fields are omitted when they cannot be observed.
 */
export const controlStateSchema = z.object({
  capabilities: z.array(z.string()),
  settings: z.object({ tier: tierSchema, longContext: z.boolean() }),
  contextWindow: z.number().int().nonnegative().optional(),
  activeChildren: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
  origin: z.literal("root"),
  tiers: z.array(tierSchema),
  longContextTarget: z.number().int().nonnegative().optional(),
  longContextAvailable: z.boolean().optional(),
  shortContextBudgetTokens: z.number().int().positive().optional(),
  pricingThresholdInputTokens: z.number().int().positive().optional(),
  contextPolicyError: z.string().optional(),
  modelBaselineContextWindow: z.number().int().nonnegative().optional(),
  tierApplicable: z.boolean(),
  conflicts: z.array(
    z.object({
      owner: z.string().min(1),
      command: z.string().min(1),
      resolution: z.string().min(1),
    }),
  ),
  limitations: z.array(z.string()),
});
export type ControlState = z.infer<typeof controlStateSchema>;
export const controlStateUpdateSchema = z.object({
  version: z.literal(1),
  sessionKey: z.string(),
  state: controlStateSchema,
});

export const controlOperationSchema = z.enum([
  "hello",
  "get-state",
  "configure",
  "rewind",
  "reload",
]);
export type ControlOperation = z.infer<typeof controlOperationSchema>;

export const controlReplySchema = z.object({
  version: z.literal(1),
  sessionKey: z.string(),
  requestId: z.string(),
  operation: controlOperationSchema,
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

export function formatContextLength(budget: number | undefined): string {
  if (budget === undefined) return "Unknown";
  const roundedThousands = Math.round(budget / 1000);
  return roundedThousands >= 1000
    ? `${Math.round(budget / 1_000_000)}M`
    : budget >= 1000
      ? `${roundedThousands}K`
      : String(Math.round(budget));
}

export function contextSettingPresentation(
  state: ControlState | undefined,
  modelContextWindow?: number,
): { label: string; description: string } {
  const budget = modelContextWindow ?? state?.contextWindow;
  const target = state?.longContextTarget;
  const shortBudget = state?.shortContextBudgetTokens;
  const tokens = (value: number | undefined) =>
    value === undefined ? "unknown" : `${value.toLocaleString("en-US")} tokens`;
  return {
    label: formatContextLength(budget),
    description: `Current Pi budget: ${tokens(budget)}. Short budget: ${tokens(shortBudget)}. Maximum: ${tokens(target)}. Limits supplied by Plexus.${state?.pricingThresholdInputTokens !== undefined ? ` Input pricing threshold: ${tokens(state.pricingThresholdInputTokens)}.` : ""}`,
  };
}
