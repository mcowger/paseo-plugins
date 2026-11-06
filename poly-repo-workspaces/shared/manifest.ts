import { z } from "zod";

export const MANIFEST_VERSION = 2;

export const ConstituentStateSchema = z.enum(["pending", "created", "removed", "missing"]);

export type ConstituentState = z.infer<typeof ConstituentStateSchema>;

export const ManifestConstituentSchema = z.object({
  repoId: z.string().min(1),
  sourcePath: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  /**
   * Host workspace registered for this worktree. It inherits the virtual root's
   * project so the repos group under one sidebar section.
   */
  workspaceId: z.string().nullable(),
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
  importBranch: z.string().min(1).nullable().optional(),
  branch: z.string().min(1),
  rootPath: z.string().min(1),
  workspaceId: z.string().nullable(),
  /** Project the root workspace created; constituent workspaces join it. */
  projectId: z.string().nullable(),
  state: ManifestStateSchema,
  constituents: z.array(ManifestConstituentSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type VirtualWorkspaceManifest = z.infer<typeof ManifestSchema>;

/**
 * v1 manifests predate per-repo workspaces: no root project id, no workspace id
 * per constituent. A root written by that version stays readable so a rollforward
 * registers its repo rows instead of stranding the worktrees on disk.
 */
function upgradeLegacyManifest(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const record = input as Record<string, unknown>;
  if (record.version !== 1) return input;
  const constituents = Array.isArray(record.constituents)
    ? record.constituents.map((item) =>
        typeof item === "object" && item !== null
          ? { workspaceId: null, ...(item as Record<string, unknown>) }
          : item,
      )
    : record.constituents;
  return {
    ...record,
    version: MANIFEST_VERSION,
    projectId: typeof record.projectId === "string" ? record.projectId : null,
    constituents,
  };
}

export function normalizeManifest(input: unknown): VirtualWorkspaceManifest | null {
  const parsed = ManifestSchema.safeParse(upgradeLegacyManifest(input));
  if (!parsed.success) return null;
  return parsed.data;
}

export function isTerminalState(state: ManifestState): boolean {
  return state === "archived";
}
