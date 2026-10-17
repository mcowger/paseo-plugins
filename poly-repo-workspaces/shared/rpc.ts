import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { UberProjectSchema } from "./config";
import { ManifestConstituentSchema, ManifestStateSchema } from "./manifest";

export const MISSING_WORKTREE_ERROR = "worktree missing";
export const REMOVED_WORKTREE_ERROR = "worktree removed";

export function isMissingWorktreeError(error: string | null): boolean {
  return error === MISSING_WORKTREE_ERROR || error === REMOVED_WORKTREE_ERROR;
}

export const VirtualWorkspaceSummarySchema = z.object({
  virtualId: z.string().min(1),
  uberProjectId: z.string().min(1),
  uberProjectName: z.string(),
  feature: z.string().min(1),
  branch: z.string().min(1),
  rootPath: z.string().min(1),
  workspaceId: z.string().nullable(),
  state: ManifestStateSchema,
  rootExists: z.boolean(),
  constituents: z.array(ManifestConstituentSchema),
  dirtyRepos: z.number().int().nonnegative(),
  aheadRepos: z.number().int().nonnegative(),
});

export type VirtualWorkspaceSummary = z.infer<typeof VirtualWorkspaceSummarySchema>;

export const PreflightIssueSchema = z.object({
  repoId: z.string(),
  code: z.enum([
    "source-missing",
    "source-not-git",
    "branch-exists",
    "branch-checked-out",
    "base-unresolvable",
    "target-exists",
  ]),
  message: z.string(),
});

export type PreflightIssue = z.infer<typeof PreflightIssueSchema>;

export const RepoStatusSchema = z.object({
  repoId: z.string(),
  worktreePath: z.string(),
  branch: z.string(),
  dirty: z.boolean(),
  dirtyFileCount: z.number().int().nonnegative(),
  diffStat: z.string().nullable(),
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  upstreamRef: z.string().nullable(),
  error: z.string().nullable(),
});

export type RepoStatus = z.infer<typeof RepoStatusSchema>;

export const getSettingsSnapshot = defineRpc({
  name: "polyrepo.settings.get",
  input: z.object({}),
  output: z.object({
    virtualRootBase: z.string().nullable(),
    uberProjects: z.array(UberProjectSchema),
  }),
});

export const listUberProjects = defineRpc({
  name: "polyrepo.uber-projects.list",
  input: z.object({}),
  output: z.object({ uberProjects: z.array(UberProjectSchema) }),
});

export const listVirtualWorkspaces = defineRpc({
  name: "polyrepo.virtual-workspaces.list",
  input: z.object({}),
  output: z.object({
    virtualWorkspaces: z.array(VirtualWorkspaceSummarySchema),
  }),
});

export const createVirtualWorkspace = defineRpc({
  name: "polyrepo.virtual-workspaces.create",
  input: z.object({
    uberProjectId: z.string().min(1),
    feature: z.string().min(1).max(128),
    baseBranchOverrides: z.record(z.string(), z.string().min(1)).optional(),
    createTerminals: z.boolean().optional(),
    resume: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    virtualId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    error: z.string().nullable(),
    preflight: z.array(PreflightIssueSchema),
  }),
});

export const archiveVirtualWorkspace = defineRpc({
  name: "polyrepo.virtual-workspaces.archive",
  input: z.object({
    virtualId: z.string().min(1),
    forceRepoIds: z.array(z.string().min(1)).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    blocked: z.array(RepoStatusSchema),
  }),
});

export const getRepoStatuses = defineRpc({
  name: "polyrepo.virtual-workspaces.statuses",
  input: z.object({ virtualId: z.string().min(1) }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    statuses: z.array(RepoStatusSchema),
  }),
});

export const regenerateRepomap = defineRpc({
  name: "polyrepo.virtual-workspaces.regenerate-repomap",
  input: z.object({ virtualId: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const ReconcileReportSchema = z.object({
  adopted: z.array(z.string().min(1)),
  finishedTeardown: z.array(z.string().min(1)),
  relinked: z.array(z.string().min(1)),
  workspaceCleared: z.array(z.string().min(1)),
  orphaned: z.array(z.string().min(1)),
  invalid: z.array(z.string().min(1)),
});

export type ReconcileReport = z.infer<typeof ReconcileReportSchema>;

export function emptyReconcileReport(): ReconcileReport {
  return {
    adopted: [],
    finishedTeardown: [],
    relinked: [],
    workspaceCleared: [],
    orphaned: [],
    invalid: [],
  };
}

export const reconcileVirtualWorkspaces = defineRpc({
  name: "polyrepo.virtual-workspaces.reconcile",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    report: ReconcileReportSchema,
  }),
});

export const forgetVirtualWorkspace = defineRpc({
  name: "polyrepo.virtual-workspaces.forget",
  input: z.object({ virtualId: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const cleanupVirtualWorkspace = defineRpc({
  name: "polyrepo.virtual-workspaces.cleanup",
  input: z.object({ virtualId: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const repairConstituent = defineRpc({
  name: "polyrepo.virtual-workspaces.repair-constituent",
  input: z.object({ virtualId: z.string().min(1), repoId: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});
