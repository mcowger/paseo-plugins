import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const amount = z.number().finite().nullable();
const reset = z.string().nullable();
export const balanceSchema = z.object({
  id: z.string(),
  label: z.string(),
  used: amount,
  limit: amount,
  remaining: amount,
  usedPct: amount,
  resetsAt: reset,
  unit: z.enum(["usd", "credits"]).optional(),
});
export const windowSchema = z.object({
  id: z.string(),
  label: z.string(),
  shortLabel: z.string(),
  summary: z.boolean(),
  usedPct: amount,
  resetsAt: reset,
});
export const accountSchema = z.object({
  id: z.string(),
  label: z.string(),
  plan: z.string().nullable(),
  status: z.enum(["available", "unavailable", "error"]),
  message: z.string().nullable(),
  balances: z.array(balanceSchema),
  windows: z.array(windowSchema),
  updatedAt: reset,
  stale: z.boolean(),
});
export const usageRpc = defineRpc({
  name: "claude.usage.read",
  input: z.object({ refresh: z.boolean().default(false) }).strict(),
  output: z.object({ accounts: z.array(accountSchema) }),
});
export const codexUsageRpc = defineRpc({
  name: "codex.usage.read",
  input: z.object({ refresh: z.boolean().default(false) }).strict(),
  output: z.object({ accounts: z.array(accountSchema) }),
});
export type Balance = z.infer<typeof balanceSchema>;
export type Window = z.infer<typeof windowSchema>;
export type Account = z.infer<typeof accountSchema>;
