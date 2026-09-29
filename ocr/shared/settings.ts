import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_NEW_AGENT_INSTRUCTIONS =
  "Review the selected OpenCodeReview findings below against the current repository. Verify each finding before changing code. Fix valid selected issues, keep changes focused, and run relevant tests. Summarize fixes and any findings you did not address. Do not commit unless asked.";

export const providerModelSchema = z
  .string()
  .trim()
  .min(1)
  // Provider is the first segment; model ids may nest further
  // (e.g. opencode/openrouter/glm-5.3-flash).
  .regex(/^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/, "Expected provider/model format");

export const preferencesSchema = z.object({
  newAgentInstructions: z.string().trim().min(1).default(DEFAULT_NEW_AGENT_INSTRUCTIONS),
  defaultProviderModel: providerModelSchema.optional(),
});

export type Preferences = z.output<typeof preferencesSchema>;

export const preferencesSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: preferencesSchema,
});

export const batchModeSchema = z.enum(["uncommitted", "branch"]);
export type BatchMode = z.output<typeof batchModeSchema>;

export const selectionBatchSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  createdAt: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
  worktreeRoot: z.string().min(1),
  sessionId: z.string().min(1),
  mode: batchModeSchema,
  baseRef: z.string().optional(),
  targetRef: z.string().optional(),
  findingCount: z.number().int().nonnegative(),
  severitySummary: z.string().default(""),
  findingIds: z.array(z.string().min(1)),
  attachmentText: z.string().min(1),
  fileUrl: z.string().min(1),
});

export type SelectionBatch = z.output<typeof selectionBatchSchema>;

export const MAX_SELECTION_BATCHES = 20;

export const selectionsSchema = z.object({
  batches: z.array(selectionBatchSchema).default([]),
});

export type Selections = z.output<typeof selectionsSchema>;

export const selectionsSettings = defineSettings({
  id: "selections",
  scope: "host",
  version: 1,
  schema: selectionsSchema,
});

export function retainRecentBatches(batches: SelectionBatch[]): SelectionBatch[] {
  const sorted = [...batches].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return sorted.slice(0, MAX_SELECTION_BATCHES);
}

export function mergeBatches(existing: SelectionBatch[], incoming: SelectionBatch): SelectionBatch[] {
  const withoutIncoming = existing.filter((batch) => batch.id !== incoming.id);
  return retainRecentBatches([incoming, ...withoutIncoming]);
}
