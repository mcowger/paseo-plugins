import { z } from "zod";
import { createPolicyConsumer } from "./policy-consumer.ts";

export const SERVICE_TIERS_REQUEST = "plexus:service-tiers:request:v1";
export const SERVICE_TIERS_SNAPSHOT = "plexus:service-tiers:snapshot:v1";
export const serviceTierPolicySchema = z.object({
  provider: z.string().min(1), modelId: z.string().min(1),
  serviceTiers: z.array(z.string().min(1).max(100)).min(1).max(64)
    .refine((values) => new Set(values).size === values.length),
}).strict();
export type ServiceTierPolicy = z.infer<typeof serviceTierPolicySchema>;
export const serviceTiersSnapshotSchema = z.object({
  version: z.literal(1), publisherId: z.string().uuid(), revision: z.number().int().positive().safe(),
  requestId: z.string().min(1).max(1024).optional(), status: z.enum(["ready", "loading", "unavailable"]),
  policies: z.array(serviceTierPolicySchema), fetchedAt: z.number().int().nonnegative().safe().optional(),
  cached: z.boolean().optional(), reason: z.string().max(500).optional(),
}).strict().superRefine((value, ctx) => {
  const keys = new Set<string>();
  for (const policy of value.policies) {
    const key = JSON.stringify([policy.provider, policy.modelId]);
    if (keys.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate tier policy" });
    keys.add(key);
  }
  if (value.status !== "ready" && value.policies.length) ctx.addIssue({ code: "custom", message: "Non-ready snapshot contains tiers" });
});

export function createServiceTiersConsumer(bus: Parameters<typeof createPolicyConsumer>[0], onChange: () => void) {
  return createPolicyConsumer<ServiceTierPolicy>(bus, SERVICE_TIERS_REQUEST, SERVICE_TIERS_SNAPSHOT, serviceTiersSnapshotSchema, onChange);
}
