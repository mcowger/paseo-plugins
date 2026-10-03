import { z } from "zod";
import { createPolicyConsumer } from "./policy-consumer.ts";

export const CONTEXT_POLICY_REQUEST = "plexus:context-policy:request:v1";
export const CONTEXT_POLICY_SNAPSHOT = "plexus:context-policy:snapshot:v1";
const tokens = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const contextPolicySchema = z.object({
  provider: z.string().min(1), modelId: z.string().min(1),
  maxContextTokens: tokens, shortContextBudgetTokens: tokens,
  pricingThresholdInputTokens: tokens.optional(),
}).refine((value) => value.shortContextBudgetTokens <= value.maxContextTokens);
export type ContextPolicy = z.infer<typeof contextPolicySchema>;
export const contextPolicySnapshotSchema = z.object({
  version: z.literal(1), publisherId: z.string().uuid(), revision: tokens,
  requestId: z.string().min(1).optional(),
  status: z.enum(["ready", "loading", "unavailable"]),
  policies: z.array(contextPolicySchema),
  fetchedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  cached: z.boolean().optional(), reason: z.string().optional(),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const policy of value.policies) {
    const key = JSON.stringify([policy.provider, policy.modelId]);
    if (ids.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate model policy" });
    ids.add(key);
  }
  if (value.status !== "ready" && value.policies.length) ctx.addIssue({ code: "custom", message: "Non-ready snapshot contains policies" });
});
export function createContextPolicyConsumer(bus: Parameters<typeof createPolicyConsumer>[0], onChange: () => void) {
  return createPolicyConsumer<ContextPolicy>(bus, CONTEXT_POLICY_REQUEST, CONTEXT_POLICY_SNAPSHOT, contextPolicySnapshotSchema, onChange);
}
