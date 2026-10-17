import { z } from "zod";

export const MANIFEST_VERSION = 1;

export const ConstituentStateSchema = z.enum(["pending", "created", "removed", "missing"]);

export type ConstituentState = z.infer<typeof ConstituentStateSchema>;

export const ManifestConstituentSchema = z.object({
  repoId: z.string().min(1),
  sourcePath: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  state: ConstituentStateSchema,
});

export type ManifestConstituent = z.infer<typeof ManifestConstituentSchema>;

export const ManifestStateSchema = z.enum([
  "creating",
  "ready",
  "archiving",
  "teardown-blocked",
  "archived",
  "orphaned",
]);

export type ManifestState = z.infer<typeof ManifestStateSchema>;

export const ManifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  virtualId: z.string().min(1),
  uberProjectId: z.string().min(1),
  feature: z.string().min(1),
  branch: z.string().min(1),
  rootPath: z.string().min(1),
  workspaceId: z.string().nullable(),
  state: ManifestStateSchema,
  constituents: z.array(ManifestConstituentSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type VirtualWorkspaceManifest = z.infer<typeof ManifestSchema>;

export function normalizeManifest(input: unknown): VirtualWorkspaceManifest | null {
  const parsed = ManifestSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data;
}

export function isTerminalState(state: ManifestState): boolean {
  return state === "archived";
}
