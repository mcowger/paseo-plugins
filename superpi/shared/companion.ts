import { z } from "zod";

export const companionPrefix = "superpi:v1:";
export const tierSchema = z.enum(["default", "fast", "flex", "ultrafast"]);
export const companionStateSchema = z.object({
  capabilities: z.array(z.string()),
  settings: z.object({ tier: tierSchema, longContext: z.boolean() }),
  contextWindow: z.number().positive().optional(),
  activeChildren: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
});
export type CompanionState = z.infer<typeof companionStateSchema>;
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
