import { type RepoConfig, type UberProject, validateFeatureName } from "../shared/config";
import { normalizeManifest, type VirtualWorkspaceManifest } from "../shared/manifest";
import {
  renderBranchName,
  renderConstituentDirName,
  renderRootDirName,
  resolveRootBase,
} from "../shared/names";
import {
  buildRepomap,
  type RepomapRepo,
  renderAgentsTemplate,
  truncateFragment,
} from "../shared/repomap";
import type {
  PreflightIssue,
  ReconcileReport,
  RepoStatus,
  VirtualWorkspaceSummary,
} from "../shared/rpc";
import {
  emptyReconcileReport,
  isMissingWorktreeError,
  MISSING_WORKTREE_ERROR,
  REMOVED_WORKTREE_ERROR,
} from "../shared/rpc";
import {
  aheadBehind,
  currentBranch,
  diffShortStat,
  isGitRepo,
  listAvailableBranches,
  listWorktreeBranches,
  localBranchExists,
  remoteBranchExists,
  resolveBaseBranch,
  statusPorcelain,
  upstreamRef,
} from "./git";
import { isInside, isSameOrInside, joinSegments, normalizeAbsolute } from "./paths";
import {
  type FsPort,
  type GitPort,
  type HostWorkspaceRef,
  isGitFailure,
  type WorkspacesPort,
} from "./ports";
import {
  emptyIndex,
  type IndexEntry,
  loadIndex,
  readManifest,
  saveIndex,
  type WorkspaceIndex,
  writeManifest,
} from "./store";

export interface SettingsSnapshot {
  virtualRootBase?: string;
  uberProjects: UberProject[];
}

export interface ServiceDeps {
  fs: FsPort;
  git: GitPort;
  init: { run(script: string, cwd: string): Promise<void> };
  workspaces: WorkspacesPort;
  settings: { snapshot(): Promise<SettingsSnapshot> };
  paseoHome: string;
  now(): string;
  withIndexLock(): Promise<() => void>;
}

export interface ReconcileDeps {
  fs: FsPort;
  git: GitPort;
  settings: { snapshot(): Promise<SettingsSnapshot> };
  paseoHome: string;
  now(): string;
  withIndexLock(): Promise<() => void>;
}

export interface CreateInput {
  uberProjectId: string;
  feature: string;
  baseBranchOverrides?: Record<string, string>;
  importBranch?: string;
  importDefaults?: boolean;
  createTerminals?: boolean;
  resume?: boolean;
}

export interface CreateResult {
  ok: boolean;
  virtualId: string | null;
  workspaceId: string | null;
  error: string | null;
  preflight: PreflightIssue[];
}

export interface ArchiveResult {
  ok: boolean;
  error: string | null;
  blocked: RepoStatus[];
}

const FRAGMENT_CHARS = 4000;

/**
 * Workspace titles read as `<feature> / <row>` so every row of one virtual
 * workspace carries the feature it belongs to, and the root is named rather than
 * looking like another repo. Sidebar order is a persisted per-user list, so these
 * titles never decide position.
 */
function rootWorkspaceTitle(feature: string): string {
  return `${feature} / Root`;
}

function repoWorkspaceTitle(feature: string, repoId: string): string {
  return `${feature} / ${repoId}`;
}

/** The root title older versions wrote, kept only to recognize it. */
function legacyRootWorkspaceTitle(uberProjectName: string, feature: string): string {
  return `${uberProjectName} / ${feature}`;
}

function gitMessage(error: unknown): string {
  if (isGitFailure(error)) {
    const detail = error.stderr.trim() || error.stdout.trim() || error.message;
    return detail.slice(0, 500);
  }
  return error instanceof Error ? error.message : "unknown error";
}

export function sanitizeVirtualId(uberProjectId: string, feature: string): string {
  const raw = `${uberProjectId}--${feature}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const trimmed = raw.replace(/^-+|-+$/g, "").slice(0, 120);
  return trimmed.length > 0 ? trimmed : "virtual";
}

async function updateIndex(
  deps: ReconcileDeps,
  mutate: (index: WorkspaceIndex) => void,
): Promise<WorkspaceIndex> {
  const release = await deps.withIndexLock();
  try {
    const index = await loadIndex(deps.fs, deps.paseoHome);
    mutate(index);
    await saveIndex(deps.fs, deps.paseoHome, index);
    return index;
  } finally {
    release();
  }
}

async function getWorktreesBaseRoot(deps: ServiceDeps): Promise<string> {
  const fallback = joinSegments(deps.paseoHome, "worktrees");
  try {
    const raw = await deps.fs.readFile(joinSegments(deps.paseoHome, "config.json"));
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    const worktrees = (parsed as { worktrees?: unknown }).worktrees;
    if (!worktrees || typeof worktrees !== "object") return fallback;
    const root = (worktrees as { root?: unknown }).root;
    if (typeof root !== "string" || root.length === 0) return fallback;
    return normalizeAbsolute(
      root.startsWith("/") || root.startsWith("~") ? root : joinSegments(deps.paseoHome, root),
    );
  } catch {
    return fallback;
  }
}

function lookupUberProjectName(snapshot: SettingsSnapshot, uberProjectId: string): string {
  return snapshot.uberProjects.find((p) => p.id === uberProjectId)?.displayName ?? uberProjectId;
}

async function resolveDefaultBranch(
  deps: ServiceDeps,
  sourcePath: string,
  configured?: string,
): Promise<string | null> {
  if (configured) return configured;
  try {
    const head = await deps.git.run(["symbolic-ref", "refs/remotes/origin/HEAD"], sourcePath);
    const match = /^refs\/remotes\/origin\/(.+)$/.exec(head.stdout.trim());
    if (match?.[1]) return match[1];
  } catch {
    // Try the remote's advertised symbolic HEAD below.
  }
  try {
    const remote = await deps.git.run(["remote", "get-url", "origin"], sourcePath);
    const url = remote.stdout.trim();
    const allowed =
      /^https:\/\/github\.com\/[^/\s:?#]+\/[^/\s?#]+(?:\.git)?\/?$/.test(url) ||
      /^git@github\.com:[^/\s:?#]+\/[^/\s?#]+(?:\.git)?$/.test(url) ||
      /^ssh:\/\/git@github\.com\/[^/\s:?#]+\/[^/\s?#]+(?:\.git)?\/?$/.test(url);
    if (!allowed) return null;
    const result = await deps.git.run(["ls-remote", "--symref", "origin", "HEAD"], sourcePath);
    const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m.exec(result.stdout);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function discoverImportBranches(
  deps: ServiceDeps,
  uberProjectId: string,
): Promise<{
  branches: string[];
  error: string | null;
  defaults: Array<{ repoId: string; branch: string }>;
  defaultError: string | null;
}> {
  const project = (await deps.settings.snapshot()).uberProjects.find(
    (item) => item.id === uberProjectId,
  );
  if (!project)
    return {
      branches: [],
      error: `unknown uber-project: ${uberProjectId}`,
      defaults: [],
      defaultError: `unknown uber-project: ${uberProjectId}`,
    };
  if (project.repos.length === 0)
    return {
      branches: [],
      error: "uber-project has no repositories",
      defaults: [],
      defaultError: "uber-project has no repositories",
    };
  let common: Set<string> | null = null;
  const defaults: Array<{ repoId: string; branch: string }> = [];
  let error: string | null = null;
  let defaultError: string | null = null;
  for (const repo of project.repos) {
    const source = normalizeAbsolute(repo.sourcePath);
    if (!(await deps.fs.isDirectory(source)) || !(await isGitRepo(deps.git, source))) {
      error ??= `source is not a git repo: ${repo.id}`;
      defaultError ??= `source is not a git repo: ${repo.id}`;
      continue;
    }
    try {
      const branches = new Set(await listAvailableBranches(deps.git, source));
      if (common === null) common = branches;
      else for (const branch of common) if (!branches.has(branch)) common.delete(branch);
    } catch (cause) {
      error ??= `branch discovery failed: ${gitMessage(cause)}`;
    }
    try {
      const branch = await resolveDefaultBranch(deps, source, repo.baseBranch);
      if (
        !branch ||
        (!(await localBranchExists(deps.git, source, branch)) &&
          !(await remoteBranchExists(deps.git, source, branch)))
      ) {
        defaultError ??= `cannot resolve available default branch for ${repo.id}; configure a base branch for this repo`;
      } else defaults.push({ repoId: repo.id, branch });
    } catch (cause) {
      defaultError ??= `default branch discovery failed: ${gitMessage(cause)}`;
    }
  }
  return { branches: [...(common ?? [])].sort(), error, defaults, defaultError };
}

export async function listVirtualWorkspaces(deps: ServiceDeps): Promise<VirtualWorkspaceSummary[]> {
  const [snapshot, index] = await Promise.all([
    deps.settings.snapshot(),
    loadIndex(deps.fs, deps.paseoHome),
  ]);
  const summaries: VirtualWorkspaceSummary[] = [];
  for (const [virtualId, entry] of Object.entries(index.virtual)) {
    const isDir = await deps.fs.isDirectory(entry.rootPath);
    const manifest = isDir ? await readManifest(deps.fs, entry.rootPath) : null;
    if (!manifest) {
      summaries.push({
        virtualId,
        uberProjectId: entry.uberProjectId,
        uberProjectName: lookupUberProjectName(snapshot, entry.uberProjectId),
        feature: entry.feature,
        branch: entry.branch,
        rootPath: entry.rootPath,
        workspaceId: entry.workspaceId,
        state: "orphaned",
        rootExists: isDir,
        constituents: [],
        dirtyRepos: 0,
        aheadRepos: 0,
      });
      continue;
    }
    summaries.push({
      virtualId,
      uberProjectId: manifest.uberProjectId,
      uberProjectName: lookupUberProjectName(snapshot, manifest.uberProjectId),
      feature: manifest.feature,
      branch: manifest.branch,
      rootPath: manifest.rootPath,
      workspaceId: manifest.workspaceId,
      state: manifest.state,
      rootExists: true,
      constituents: manifest.constituents,
      dirtyRepos: 0,
      aheadRepos: 0,
    });
    const listed = await collectStatuses(deps, manifest);
    const summary = summaries[summaries.length - 1];
    if (summary) {
      summary.dirtyRepos = listed.filter((status) => status.dirty).length;
      summary.aheadRepos = listed.filter((status) => (status.ahead ?? 0) > 0).length;
    }
  }
  summaries.sort((a, b) => a.rootPath.localeCompare(b.rootPath));
  return summaries;
}

interface PlannedConstituent {
  repo: RepoConfig;
  sourcePath: string;
  worktreePath: string;
  dirName: string;
  baseBranch: string;
}

function failure(
  error: string,
  extra?: Partial<CreateResult> & { preflight?: PreflightIssue[] },
): CreateResult {
  return {
    ok: false,
    virtualId: extra?.virtualId ?? null,
    workspaceId: null,
    error,
    preflight: extra?.preflight ?? [],
  };
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/**
 * The project the virtual root workspace landed in. Constituent workspaces join
 * it, which is what makes the host render one sidebar section holding every
 * repo. Read from the host rather than derived locally: only the host owns
 * project identity.
 */
async function lookupRootProjectId(
  deps: ServiceDeps,
  manifest: VirtualWorkspaceManifest,
): Promise<string | null> {
  if (!manifest.workspaceId) return null;
  try {
    const listed = await deps.workspaces.listWorkspaces();
    return listed.find((entry) => entry.id === manifest.workspaceId)?.projectId ?? null;
  } catch {
    return null;
  }
}

/**
 * Registers one directory workspace per created constituent worktree. Each one
 * is a real checkout with the host's full git surface (changes, branch, PR);
 * only the grouping is virtual.
 *
 * Best-effort by design: the worktrees and manifest are the durable state, so a
 * failed registration leaves the id null and the reconcile RPC retries it.
 * Without a project id the workspace is skipped rather than registered into a
 * fresh project, which would scatter the repos across the sidebar.
 */
async function registerConstituentWorkspaces(
  deps: ServiceDeps,
  manifest: VirtualWorkspaceManifest,
): Promise<void> {
  const projectId = manifest.projectId ?? (await lookupRootProjectId(deps, manifest));
  if (!projectId) return;
  // A worktree the host already has a workspace for is adopted, never duplicated:
  // two workspaces on one directory would show up as two rows for one repo.
  const existing = new Map<string, HostWorkspaceRef>();
  try {
    for (const entry of await deps.workspaces.listWorkspaces()) {
      existing.set(normalizeAbsolute(entry.cwd), entry);
    }
  } catch {
    // Registration below still works; reconcile adopts anything left behind.
  }
  let changed = false;
  if (manifest.projectId !== projectId) {
    manifest.projectId = projectId;
    changed = true;
  }
  for (const constituent of manifest.constituents) {
    if (constituent.state !== "created" || constituent.workspaceId) continue;
    const adopted = existing.get(normalizeAbsolute(constituent.worktreePath));
    if (adopted) {
      constituent.workspaceId = adopted.id;
      changed = true;
      continue;
    }
    if (!(await deps.fs.isDirectory(constituent.worktreePath))) continue;
    try {
      const created = await deps.workspaces.createDirectoryWorkspace({
        path: constituent.worktreePath,
        title: repoWorkspaceTitle(manifest.feature, constituent.repoId),
        projectId,
      });
      constituent.workspaceId = created.workspaceId;
      changed = true;
    } catch {
      // Reconcile retries; creation must not fail over a sidebar row.
    }
  }
  if (changed) {
    manifest.updatedAt = deps.now();
    await writeManifest(deps.fs, manifest);
  }
}

/**
 * Archives the per-repo workspaces before their worktrees go away, so no host
 * row outlives the directory it points at. A workspace the host already dropped
 * counts as archived.
 */
async function archiveConstituentWorkspaces(
  deps: ServiceDeps,
  manifest: VirtualWorkspaceManifest,
  force = false,
): Promise<{ error: string | null }> {
  let changed = false;
  for (const constituent of manifest.constituents) {
    const workspaceId = constituent.workspaceId;
    if (!workspaceId) continue;
    try {
      await deps.workspaces.archiveWorkspace(workspaceId);
    } catch (error) {
      if (force) continue;
      if (!isMissingWorkspace(error)) {
        const message = error instanceof Error ? error.message : "unknown error";
        if (changed) {
          manifest.updatedAt = deps.now();
          await writeManifest(deps.fs, manifest);
        }
        return { error: `repo workspace archive failed: ${message}` };
      }
    }
    constituent.workspaceId = null;
    changed = true;
  }
  if (changed) {
    manifest.updatedAt = deps.now();
    await writeManifest(deps.fs, manifest);
  }
  return { error: null };
}

// Project deletion also removes its workspace history. Only delete a project
// whose creation we observed, whose root still matches, and which has no active rows.
async function removeOwnedProject(
  deps: ServiceDeps,
  manifest: VirtualWorkspaceManifest,
): Promise<string | null> {
  if (!manifest.projectOwned || !manifest.projectId) return null;
  try {
    const project = (await deps.workspaces.listProjects()).find(
      (item) => item.id === manifest.projectId,
    );
    if (!project) return null;
    if (normalizeAbsolute(project.rootPath) !== normalizeAbsolute(manifest.rootPath)) return null;
    const workspaces = await deps.workspaces.listWorkspaces();
    if (workspaces.some((item) => item.projectId === project.id)) return null;
    await deps.workspaces.deleteProject(project.id, deps.paseoHome);
    return null;
  } catch (error) {
    return `project cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}

export async function createVirtualWorkspace(
  deps: ServiceDeps,
  input: CreateInput,
): Promise<CreateResult> {
  const snapshot = await deps.settings.snapshot();
  const project = snapshot.uberProjects.find((p) => p.id === input.uberProjectId);
  if (!project) return failure(`unknown uber-project: ${input.uberProjectId}`);

  const featureError = validateFeatureName(input.feature);
  if (featureError) return failure(`invalid feature name: ${featureError}`);

  const generatedBranch = renderBranchName(project.branchTemplate, {
    uberProjectId: project.id,
    feature: input.feature,
  });
  const virtualId = sanitizeVirtualId(project.id, input.feature);
  const existingEntry = (await loadIndex(deps.fs, deps.paseoHome)).virtual[virtualId];
  const existingManifest = existingEntry
    ? await readManifest(deps.fs, existingEntry.rootPath)
    : null;
  if (input.importDefaults && input.importBranch) {
    return failure("choose either default branches or a common branch");
  }
  if (
    input.resume &&
    existingManifest &&
    !existingManifest.importDefaults &&
    input.importBranch !== undefined &&
    input.importBranch !== (existingManifest.importBranch ?? undefined)
  ) {
    return failure("cannot change the branch selection while resuming");
  }
  const resumeDefaults = input.resume && existingManifest?.importDefaults === true;
  if (
    input.resume &&
    existingManifest &&
    input.importDefaults !== undefined &&
    input.importDefaults !== (existingManifest.importDefaults === true)
  ) {
    return failure("cannot change the branch selection while resuming");
  }
  if (input.resume && existingManifest?.importDefaults && input.importBranch !== undefined) {
    return failure("cannot change the branch selection while resuming");
  }
  const importDefaults = input.importDefaults ?? resumeDefaults;
  const importBranch = importDefaults
    ? "default"
    : (input.importBranch ??
      (input.resume ? (existingManifest?.importBranch ?? undefined) : undefined));
  const branch = importDefaults
    ? "default"
    : (importBranch ??
      (input.resume ? (existingManifest?.branch ?? generatedBranch) : generatedBranch));
  const rootBase = resolveRootBase({
    perProject: project.virtualRootBase,
    hostSetting: snapshot.virtualRootBase,
    paseoHome: deps.paseoHome,
  });
  const rootDirName = renderRootDirName(project.rootDirTemplate, {
    uberProjectId: project.id,
    feature: input.feature,
    branch,
  });
  const rootPath = normalizeAbsolute(joinSegments(rootBase, rootDirName));
  if (!isSameOrInside(rootBase, rootPath)) {
    return failure("virtual root path escapes its configured root");
  }

  const worktreesRoot = await getWorktreesBaseRoot(deps);
  if (isSameOrInside(worktreesRoot, rootPath)) {
    return failure(
      `virtual root must not live under the Paseo worktrees root (${worktreesRoot}); ` +
        `change virtualRootBase to a path outside it`,
    );
  }
  for (const repo of project.repos) {
    const sourcePath = normalizeAbsolute(repo.sourcePath);
    if (isSameOrInside(sourcePath, rootPath) || isSameOrInside(rootPath, sourcePath)) {
      return failure(`virtual root overlaps repo source: ${repo.id}`);
    }
  }

  const existingIndex = await loadIndex(deps.fs, deps.paseoHome);
  const indexed = existingIndex.virtual[virtualId];
  if (indexed && normalizeAbsolute(indexed.rootPath) !== rootPath) {
    return failure(
      `virtual workspace id collision: ${virtualId} already manages ${indexed.rootPath}`,
    );
  }

  let manifest = await readManifest(deps.fs, rootPath);
  if (manifest && !input.resume) {
    return failure(`virtual workspace already exists at ${rootPath}; archive it first`);
  }
  if (
    manifest &&
    (manifest.virtualId !== virtualId ||
      manifest.uberProjectId !== project.id ||
      manifest.feature !== input.feature)
  ) {
    return failure(
      `workspace at ${rootPath} belongs to a different feature name; cannot resume it`,
    );
  }
  if (manifest && manifest.state !== "creating") {
    return failure(`only a workspace stuck in creating can be resumed (state: ${manifest.state})`);
  }
  if (!manifest) {
    if (await deps.fs.isDirectory(rootPath)) {
      const entries = (await deps.fs.readdir(rootPath)) ?? [];
      if (entries.length > 0) {
        return failure(`directory exists and is not a managed virtual workspace: ${rootPath}`);
      }
    }
  }

  const templateRaw = await deps.fs.readFile(normalizeAbsolute(project.agentsTemplatePath));
  if (templateRaw === null) {
    return failure(`agents template not found: ${project.agentsTemplatePath}`);
  }

  const planned: PlannedConstituent[] = project.repos.map((repo) => {
    const dirName = renderConstituentDirName(repo.dirTemplate, {
      uberProjectId: project.id,
      feature: input.feature,
      branch,
      repoId: repo.id,
    });
    return {
      repo,
      sourcePath: normalizeAbsolute(repo.sourcePath),
      worktreePath: normalizeAbsolute(joinSegments(rootPath, dirName)),
      dirName,
      baseBranch: "",
    };
  });
  for (const item of planned) {
    if (!isSameOrInside(rootPath, item.worktreePath)) {
      return failure(`worktree path escapes virtual root for ${item.repo.id}`);
    }
    for (const repo of project.repos) {
      const source = normalizeAbsolute(repo.sourcePath);
      if (isSameOrInside(source, item.worktreePath) || isSameOrInside(item.worktreePath, source)) {
        return failure(`worktree path overlaps repo source: ${item.repo.id}`);
      }
    }
  }

  const timestamp = deps.now();
  if (!manifest) {
    manifest = {
      version: 2,
      virtualId,
      uberProjectId: project.id,
      feature: input.feature,
      branch,
      rootPath,
      importBranch: importBranch ?? null,
      importDefaults,
      importDefaultBranches: {},
      workspaceId: null,
      projectId: null,
      state: "creating",
      constituents: planned.map((p) => ({
        repoId: p.repo.id,
        sourcePath: p.sourcePath,
        worktreePath: p.worktreePath,
        branch,
        baseBranch: "",
        workspaceId: null,
        state: "pending" as const,
        initState: p.repo.initScript?.trim() ? ("pending" as const) : undefined,
      })),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }
  const active: VirtualWorkspaceManifest = manifest;

  const preflight: PreflightIssue[] = [];
  for (const item of planned) {
    const constituent = active.constituents.find((c) => c.repoId === item.repo.id);
    if (constituent?.state === "created") continue;
    if (!(await deps.fs.isDirectory(item.sourcePath))) {
      preflight.push({
        repoId: item.repo.id,
        code: "source-missing",
        message: `source is not a directory: ${item.sourcePath}`,
      });
      continue;
    }
    if (!(await isGitRepo(deps.git, item.sourcePath))) {
      preflight.push({
        repoId: item.repo.id,
        code: "source-not-git",
        message: `source is not a git repo: ${item.sourcePath}`,
      });
      continue;
    }
    const base = importDefaults
      ? (active.importDefaultBranches?.[item.repo.id] ??
        (await resolveDefaultBranch(deps, item.sourcePath, item.repo.baseBranch)))
      : await resolveBaseBranch(
          deps.git,
          item.sourcePath,
          input.baseBranchOverrides?.[item.repo.id] ?? item.repo.baseBranch,
        );
    const validBase =
      base &&
      ((await localBranchExists(deps.git, item.sourcePath, base)) ||
        (await remoteBranchExists(deps.git, item.sourcePath, base)));
    if ((importDefaults && (!base || !validBase)) || (!base && !importBranch)) {
      preflight.push({
        repoId: item.repo.id,
        code: "base-unresolvable",
        message: `cannot resolve available default branch for ${item.repo.id}`,
      });
      continue;
    }
    item.baseBranch = base ?? importBranch ?? "";
    if (constituent) constituent.baseBranch = item.baseBranch;
    if (constituent && importDefaults) constituent.branch = item.baseBranch;
    if (importDefaults) {
      active.importDefaultBranches ??= {};
      active.importDefaultBranches[item.repo.id] = item.baseBranch;
    }
    const checkedOut = await listWorktreeBranches(deps.git, item.sourcePath);
    if (!importDefaults && checkedOut.includes(branch)) {
      preflight.push({
        repoId: item.repo.id,
        code: "branch-checked-out",
        message: `branch ${branch} is already checked out in ${item.repo.id}`,
      });
      continue;
    }
    const targetBranch = importDefaults ? item.baseBranch : branch;
    const localExists = await localBranchExists(deps.git, item.sourcePath, targetBranch);
    const remoteExists = importDefaults
      ? await remoteBranchExists(deps.git, item.sourcePath, targetBranch)
      : importBranch
        ? await remoteBranchExists(deps.git, item.sourcePath, importBranch)
        : false;
    if ((importDefaults || importBranch) && !localExists && !remoteExists) {
      preflight.push({
        repoId: item.repo.id,
        code: "branch-unavailable",
        message: `branch ${targetBranch} is not available locally or on origin in ${item.repo.id}`,
      });
      continue;
    }
    if (!importDefaults && !importBranch && localExists) {
      preflight.push({
        repoId: item.repo.id,
        code: "branch-exists",
        message: `branch ${branch} already exists in ${item.repo.id}`,
      });
      continue;
    }
    if (await deps.fs.exists(item.worktreePath)) {
      preflight.push({
        repoId: item.repo.id,
        code: "target-exists",
        message: `target path already exists: ${item.worktreePath}`,
      });
    }
  }

  active.updatedAt = deps.now();
  await deps.fs.mkdirp(rootPath);
  await writeManifest(deps.fs, active);
  await updateIndex(deps, (index) => {
    index.virtual[virtualId] = {
      rootPath,
      workspaceId: active.workspaceId,
      uberProjectId: project.id,
      feature: input.feature,
      branch,
      updatedAt: deps.now(),
    };
  });

  if (preflight.length > 0) {
    return { ok: false, virtualId, workspaceId: null, error: null, preflight };
  }

  for (const item of planned) {
    const constituent = active.constituents.find((c) => c.repoId === item.repo.id);
    if (!constituent || constituent.state === "created") continue;
    try {
      if (importDefaults) {
        const checkedOut = (await listWorktreeBranches(deps.git, item.sourcePath)).includes(
          item.baseBranch,
        );
        const local = await localBranchExists(deps.git, item.sourcePath, item.baseBranch);
        const ref = local ? item.baseBranch : `origin/${item.baseBranch}`;
        const args = checkedOut
          ? ["worktree", "add", "--detach", item.worktreePath, ref]
          : local
            ? ["worktree", "add", item.worktreePath, item.baseBranch]
            : ["worktree", "add", "--track", "-b", item.baseBranch, item.worktreePath, ref];
        await deps.git.run(args, item.sourcePath);
      } else if (importBranch) {
        const localImportExists = await localBranchExists(deps.git, item.sourcePath, importBranch);
        if (localImportExists)
          await deps.git.run(["worktree", "add", item.worktreePath, importBranch], item.sourcePath);
        else
          await deps.git.run(
            [
              "worktree",
              "add",
              "--track",
              "-b",
              importBranch,
              item.worktreePath,
              `origin/${importBranch}`,
            ],
            item.sourcePath,
          );
      } else {
        await deps.git.run(
          ["worktree", "add", "-b", branch, item.worktreePath, item.baseBranch],
          item.sourcePath,
        );
      }
    } catch (error) {
      active.updatedAt = deps.now();
      await writeManifest(deps.fs, active);
      return {
        ok: false,
        virtualId,
        workspaceId: null,
        error: `git worktree add failed for ${item.repo.id}: ${gitMessage(error)}`,
        preflight: [],
      };
    }
    constituent.state = "created";
    active.updatedAt = deps.now();
    await writeManifest(deps.fs, active);
  }

  for (const item of planned) {
    const constituent = active.constituents.find((c) => c.repoId === item.repo.id);
    if (constituent?.initState !== "pending") continue;
    try {
      if (item.repo.initScript?.trim())
        await deps.init.run(item.repo.initScript, item.worktreePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return {
        ok: false,
        virtualId,
        workspaceId: null,
        error: `init script failed for ${item.repo.id}: ${message}. Resume creation to retry.`,
        preflight: [],
      };
    }
    constituent.initState = "complete";
    active.updatedAt = deps.now();
    await writeManifest(deps.fs, active);
  }

  const agentsPath = joinSegments(rootPath, "AGENTS.md");
  if ((await deps.fs.readFile(agentsPath)) === null) {
    const rendered = renderAgentsTemplate(templateRaw, {
      uberProjectName: project.displayName,
      feature: input.feature,
      branch,
      repos: planned.map((p) => ({ repoId: p.repo.id, dirName: p.dirName })),
    });
    await deps.fs.writeFileAtomic(agentsPath, rendered);
  }

  try {
    const repomap = await buildRepomapContent(deps, active, project.displayName);
    await deps.fs.writeFileAtomic(joinSegments(rootPath, "REPOMAP.md"), repomap);
  } catch {
    // REPOMAP is a convenience file; a failure here must not fail creation.
  }

  if (!active.workspaceId) {
    let previousProjectIds: Set<string> | null = null;
    try {
      previousProjectIds = new Set((await deps.workspaces.listProjects()).map((item) => item.id));
    } catch {
      // Without a prior snapshot ownership cannot be established.
    }
    try {
      const created = await deps.workspaces.createDirectoryWorkspace({
        path: rootPath,
        title: rootWorkspaceTitle(input.feature),
      });
      active.workspaceId = created.workspaceId;
      active.projectId = created.projectId;
      active.projectOwned = Boolean(
        created.projectId && previousProjectIds && !previousProjectIds.has(created.projectId),
      );
      active.updatedAt = deps.now();
      await writeManifest(deps.fs, active);
    } catch (error) {
      active.updatedAt = deps.now();
      await writeManifest(deps.fs, active);
      const message = error instanceof Error ? error.message : "unknown error";
      return {
        ok: false,
        virtualId,
        workspaceId: null,
        error: `workspace registration failed: ${message}`,
        preflight: [],
      };
    }
  }

  await registerConstituentWorkspaces(deps, active);

  active.state = "ready";
  active.updatedAt = deps.now();
  await writeManifest(deps.fs, active);
  const workspaceId = active.workspaceId;
  await updateIndex(deps, (index) => {
    const entry = index.virtual[virtualId];
    if (entry) {
      entry.workspaceId = workspaceId;
      entry.updatedAt = deps.now();
    }
  });

  if (input.createTerminals && workspaceId) {
    await deps.workspaces
      .createTerminal(workspaceId, { cwd: rootPath, name: "root" })
      .catch(() => {});
    for (const item of planned) {
      await deps.workspaces
        .createTerminal(workspaceId, {
          cwd: item.worktreePath,
          name: item.repo.id,
        })
        .catch(() => {});
    }
  }

  return { ok: true, virtualId, workspaceId, error: null, preflight: [] };
}

async function readFragment(deps: ServiceDeps, worktreePath: string): Promise<string | null> {
  for (const name of ["REPOMAP.md", "README.md"]) {
    const content = await deps.fs.readFile(joinSegments(worktreePath, name));
    if (content !== null && content.trim().length > 0) {
      return truncateFragment(content.slice(0, FRAGMENT_CHARS));
    }
  }
  return null;
}

async function buildRepomapContent(
  deps: ServiceDeps,
  manifest: VirtualWorkspaceManifest,
  uberProjectName: string,
): Promise<string> {
  const repos: RepomapRepo[] = [];
  for (const constituent of manifest.constituents) {
    const entries = (await deps.fs.readdir(constituent.worktreePath)) ?? [];
    const fragment =
      constituent.state === "created" ? await readFragment(deps, constituent.worktreePath) : null;
    const dirName = constituent.worktreePath.slice(manifest.rootPath.length + 1);
    repos.push({
      repoId: constituent.repoId,
      sourcePath: constituent.sourcePath,
      worktreePath: constituent.worktreePath,
      dirName,
      branch: constituent.branch,
      baseBranch: constituent.baseBranch,
      topLevelEntries: entries.filter((e) => e !== ".git").sort(),
      fragment,
    });
  }
  return buildRepomap({
    uberProjectName,
    feature: manifest.feature,
    branch: manifest.branch,
    generatedAt: deps.now(),
    repos,
  });
}

export async function collectStatuses(
  deps: ReconcileDeps,
  manifest: VirtualWorkspaceManifest,
): Promise<RepoStatus[]> {
  const statuses: RepoStatus[] = [];
  for (const constituent of manifest.constituents) {
    if (!(await deps.fs.isDirectory(constituent.worktreePath))) {
      statuses.push({
        repoId: constituent.repoId,
        worktreePath: constituent.worktreePath,
        branch: constituent.branch,
        dirty: false,
        dirtyFileCount: 0,
        diffStat: null,
        ahead: null,
        behind: null,
        upstreamRef: null,
        error: constituent.state === "removed" ? REMOVED_WORKTREE_ERROR : MISSING_WORKTREE_ERROR,
      });
      continue;
    }
    try {
      const current = await currentBranch(deps.git, constituent.worktreePath);
      const branch = current ?? constituent.branch;
      const files = await statusPorcelain(deps.git, constituent.worktreePath);
      const upstream = await upstreamRef(deps.git, constituent.worktreePath);
      const defaultDetached = manifest.importDefaults === true && current === null;
      const counts = upstream ? await aheadBehind(deps.git, constituent.worktreePath) : null;
      const defaultAhead = defaultDetached
        ? Number(
            (
              await deps.git.run(
                ["rev-list", "--count", `${constituent.baseBranch}..HEAD`],
                constituent.worktreePath,
              )
            ).stdout.trim(),
          )
        : null;
      const diffStat =
        files.length > 0 ? await diffShortStat(deps.git, constituent.worktreePath) : null;
      statuses.push({
        repoId: constituent.repoId,
        worktreePath: constituent.worktreePath,
        branch,
        dirty: files.length > 0,
        dirtyFileCount: files.length,
        diffStat,
        ahead: defaultAhead ?? counts?.ahead ?? null,
        behind: counts?.behind ?? null,
        upstreamRef: upstream,
        error: null,
      });
    } catch (error) {
      statuses.push({
        repoId: constituent.repoId,
        worktreePath: constituent.worktreePath,
        branch: constituent.branch,
        dirty: false,
        dirtyFileCount: 0,
        diffStat: null,
        ahead: null,
        behind: null,
        upstreamRef: null,
        error: gitMessage(error),
      });
    }
  }
  return statuses;
}

export async function getRepoStatuses(
  deps: ServiceDeps,
  virtualId: string,
): Promise<{ ok: boolean; error: string | null; statuses: RepoStatus[] }> {
  const index = await loadIndex(deps.fs, deps.paseoHome);
  const entry = index.virtual[virtualId];
  if (!entry)
    return {
      ok: false,
      error: `unknown virtual workspace: ${virtualId}`,
      statuses: [],
    };
  const manifest = await readManifest(deps.fs, entry.rootPath);
  if (!manifest)
    return {
      ok: false,
      error: `manifest missing at ${entry.rootPath}`,
      statuses: [],
    };
  return {
    ok: true,
    error: null,
    statuses: await collectStatuses(deps, manifest),
  };
}

export async function regenerateRepomap(
  deps: ServiceDeps,
  virtualId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const index = await loadIndex(deps.fs, deps.paseoHome);
  const entry = index.virtual[virtualId];
  if (!entry) return { ok: false, error: `unknown virtual workspace: ${virtualId}` };
  const manifest = await readManifest(deps.fs, entry.rootPath);
  if (!manifest) return { ok: false, error: `manifest missing at ${entry.rootPath}` };
  const snapshot = await deps.settings.snapshot();
  const repomap = await buildRepomapContent(
    deps,
    manifest,
    lookupUberProjectName(snapshot, manifest.uberProjectId),
  );
  await deps.fs.writeFileAtomic(joinSegments(manifest.rootPath, "REPOMAP.md"), repomap);
  return { ok: true, error: null };
}

function isMissingWorkspace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /not found|unknown workspace|no such workspace/i.test(message);
}

async function finalizeRemoval(
  deps: ReconcileDeps,
  manifest: VirtualWorkspaceManifest,
): Promise<void> {
  await deps.fs.removeRecursive(manifest.rootPath);
  await updateIndex(deps, (index: WorkspaceIndex) => {
    delete index.virtual[manifest.virtualId];
  });
}

export interface TeardownResult {
  blocked: RepoStatus[];
}

export async function teardownConstituents(
  deps: ReconcileDeps,
  manifest: VirtualWorkspaceManifest,
  forceRepoIds: Set<string>,
  forceCleanup = false,
): Promise<TeardownResult> {
  const statuses = await collectStatuses(deps, manifest);
  const blocked: RepoStatus[] = [];
  const sources = new Set<string>();

  for (const constituent of manifest.constituents) {
    if (constituent.state !== "created") continue;
    const status = statuses.find((s) => s.repoId === constituent.repoId);
    if (!status) continue;
    sources.add(constituent.sourcePath);
    const missing = isMissingWorktreeError(status.error);
    const forced = forceRepoIds.has(constituent.repoId);
    const needsBlock =
      !missing && (status.error !== null || status.dirty || (status.ahead ?? 0) > 0);
    if (needsBlock && !forced) {
      blocked.push(status);
      continue;
    }
    try {
      if (!missing) {
        const args = forced
          ? ["worktree", "remove", "--force", constituent.worktreePath]
          : ["worktree", "remove", constituent.worktreePath];
        try {
          await deps.git.run(args, constituent.sourcePath);
        } catch (error) {
          if (!forceCleanup) throw error;
          const canonicalRoot = await deps.fs.realpath(manifest.rootPath);
          const canonicalWorktree = await deps.fs.realpath(constituent.worktreePath);
          const canonicalSources = await Promise.all(
            manifest.constituents.map((item) => deps.fs.realpath(item.sourcePath)),
          );
          if (
            !isInside(manifest.rootPath, constituent.worktreePath) ||
            !isInside(canonicalRoot, canonicalWorktree) ||
            canonicalSources.some(
              (source) =>
                isSameOrInside(source, canonicalWorktree) ||
                isSameOrInside(canonicalWorktree, source),
            )
          ) {
            throw new Error(`Refusing to remove unsafe worktree path: ${constituent.worktreePath}`);
          }
          await deps.fs.removeRecursive(constituent.worktreePath);
        }
      }
      if (forceCleanup || missing) {
        await deps.git.run(["worktree", "prune", "--expire", "now"], constituent.sourcePath);
        const listing = await deps.git.run(
          ["worktree", "list", "--porcelain", "-z"],
          constituent.sourcePath,
        );
        const stillRegistered = listing.stdout
          .split("\0")
          .some((record) => record === `worktree ${normalizeAbsolute(constituent.worktreePath)}`);
        if (stillRegistered) {
          throw new Error(`Git still lists worktree ${constituent.worktreePath} after pruning`);
        }
      }
      constituent.state = "removed";
    } catch (error) {
      blocked.push({ ...status, error: gitMessage(error) });
    }
  }

  for (const source of sources) {
    try {
      await deps.git.run(["worktree", "prune"], source);
    } catch {
      // Pruning is best-effort; git prunes lazily anyway.
    }
  }

  manifest.updatedAt = deps.now();
  await writeManifest(deps.fs, manifest);
  return { blocked };
}

export async function archiveVirtualWorkspace(
  deps: ServiceDeps,
  input: { virtualId: string; forceRepoIds?: string[]; force?: boolean },
): Promise<ArchiveResult> {
  const index = await loadIndex(deps.fs, deps.paseoHome);
  const entry = index.virtual[input.virtualId];
  if (!entry)
    return {
      ok: false,
      error: `unknown virtual workspace: ${input.virtualId}`,
      blocked: [],
    };
  const manifest = await readManifest(deps.fs, entry.rootPath);
  if (!manifest) {
    await updateIndex(deps, (next) => {
      delete next.virtual[input.virtualId];
    });
    return {
      ok: false,
      error: `manifest missing at ${entry.rootPath}; dropped from index`,
      blocked: [],
    };
  }
  const current = normalizeManifest(manifest);
  if (!current)
    return {
      ok: false,
      error: `manifest at ${entry.rootPath} is invalid`,
      blocked: [],
    };
  if (current.state === "archived") return { ok: true, error: null, blocked: [] };

  const forced = new Set(input.forceRepoIds ?? []);
  if (input.force) {
    for (const constituent of current.constituents) forced.add(constituent.repoId);
  }
  const statuses = await collectStatuses(deps, current);
  const blocked = statuses.filter((status) => {
    if (isMissingWorktreeError(status.error)) return false;
    if (forced.has(status.repoId)) return false;
    return status.error !== null || status.dirty || (status.ahead ?? 0) > 0;
  });
  if (blocked.length > 0) {
    return { ok: false, error: null, blocked };
  }

  current.state = "archiving";
  current.updatedAt = deps.now();
  await writeManifest(deps.fs, current);

  const repoArchive = await archiveConstituentWorkspaces(deps, current, input.force);
  if (repoArchive.error) {
    return { ok: false, error: repoArchive.error, blocked: [] };
  }

  if (current.workspaceId) {
    try {
      await deps.workspaces.archiveWorkspace(current.workspaceId);
    } catch (error) {
      if (!input.force && !isMissingWorkspace(error)) {
        const message = error instanceof Error ? error.message : "unknown error";
        return {
          ok: false,
          error: `workspace archive failed: ${message}`,
          blocked: [],
        };
      }
    }
  }

  const teardown = await teardownConstituents(deps, current, forced, input.force);
  if (teardown.blocked.length > 0) {
    current.state = "teardown-blocked";
    current.updatedAt = deps.now();
    await writeManifest(deps.fs, current);
    return { ok: false, error: null, blocked: teardown.blocked };
  }
  const projectError = await removeOwnedProject(deps, current);
  if (projectError) return { ok: false, error: projectError, blocked: [] };

  current.state = "archived";
  try {
    await finalizeRemoval(deps, current);
  } catch (error) {
    return {
      ok: false,
      error: `virtual root cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`,
      blocked: [],
    };
  }
  return { ok: true, error: null, blocked: [] };
}

export async function handleWorkspaceArchived(
  deps: ServiceDeps,
  event: { id: string; cwd: string },
): Promise<void> {
  const index = await loadIndex(deps.fs, deps.paseoHome);
  const wantedCwd = normalizeAbsolute(event.cwd);

  // A constituent row archived from the host drops its registration; the next
  // reconcile re-registers it if the worktree is still there.
  for (const entry of Object.values(index.virtual)) {
    if (!(await deps.fs.isDirectory(entry.rootPath))) continue;
    const candidate = await readManifest(deps.fs, entry.rootPath);
    const constituent = candidate?.constituents.find((c) => c.workspaceId === event.id);
    if (!candidate || !constituent) continue;
    constituent.workspaceId = null;
    candidate.updatedAt = deps.now();
    await writeManifest(deps.fs, candidate);
    return;
  }

  let virtualId: string | null = null;
  for (const [id, entry] of Object.entries(index.virtual)) {
    if (entry.workspaceId === event.id || normalizeAbsolute(entry.rootPath) === wantedCwd) {
      virtualId = id;
      break;
    }
  }
  if (!virtualId) return;

  const manifest = await readManifest(deps.fs, index.virtual[virtualId]?.rootPath ?? "");
  if (!manifest) {
    const staleId = virtualId;
    await updateIndex(deps, (next) => {
      delete next.virtual[staleId];
    });
    return;
  }
  // The plugin archive RPC drives its own cascade inline after calling archive():
  // it persists "archiving" first, so a hook event for that same archive must not
  // run a second concurrent cascade. Native archives arrive while still "ready".
  if (manifest.state === "archiving") return;
  if (manifest.state === "archived") {
    const doneId = virtualId;
    await updateIndex(deps, (next) => {
      delete next.virtual[doneId];
    });
    return;
  }
  manifest.state = "archiving";
  manifest.updatedAt = deps.now();
  await writeManifest(deps.fs, manifest);

  // Retry the cascade on reconcile if a repo workspace could not be archived.
  if ((await archiveConstituentWorkspaces(deps, manifest)).error) return;

  const teardown = await teardownConstituents(deps, manifest, new Set());
  if (teardown.blocked.length > 0) {
    manifest.state = "teardown-blocked";
    manifest.updatedAt = deps.now();
    await writeManifest(deps.fs, manifest);
    return;
  }
  if (await removeOwnedProject(deps, manifest)) return;
  manifest.state = "archived";
  await finalizeRemoval(deps, manifest);
}

export async function reconcileOnLoad(
  deps: ReconcileDeps,
): Promise<{ adopted: string[]; finalized: string[] }> {
  const snapshot = await deps.settings.snapshot();
  const index = await loadIndex(deps.fs, deps.paseoHome);
  const adopted = await adoptFromScan(deps, snapshot, new Set(Object.keys(index.virtual)));
  const finalized: string[] = [];
  const fresh = await loadIndex(deps.fs, deps.paseoHome);
  for (const [virtualId, entry] of Object.entries(fresh.virtual)) {
    if (!(await deps.fs.isDirectory(entry.rootPath))) continue;
    const manifest = await readManifest(deps.fs, entry.rootPath);
    if (manifest?.state !== "archived") continue;
    await finalizeRemoval(deps, manifest);
    finalized.push(virtualId);
  }
  return { adopted, finalized };
}

function candidateRootBases(snapshot: SettingsSnapshot, paseoHome: string): string[] {
  const bases = new Set<string>([
    resolveRootBase({ hostSetting: snapshot.virtualRootBase, paseoHome }),
  ]);
  for (const project of snapshot.uberProjects) {
    bases.add(
      resolveRootBase({
        perProject: project.virtualRootBase,
        hostSetting: snapshot.virtualRootBase,
        paseoHome,
      }),
    );
  }
  return [...bases];
}

async function adoptFromScan(
  deps: ReconcileDeps,
  snapshot: SettingsSnapshot,
  known: Set<string>,
): Promise<string[]> {
  const adopted: string[] = [];
  const additions: Array<{ virtualId: string; entry: IndexEntry }> = [];
  for (const base of candidateRootBases(snapshot, deps.paseoHome)) {
    const entries = (await deps.fs.readdir(base)) ?? [];
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const dirPath = normalizeAbsolute(joinSegments(base, name));
      if (!(await deps.fs.isDirectory(dirPath))) continue;
      const manifest = await readManifest(deps.fs, dirPath);
      if (!manifest) continue;
      if (known.has(manifest.virtualId)) continue;
      // A manifest whose recorded root differs from where it was found means
      // the directory was moved; constituent paths would be stale, so skip.
      if (normalizeAbsolute(manifest.rootPath) !== dirPath) continue;
      if (manifest.state === "archived") continue;
      known.add(manifest.virtualId);
      additions.push({
        virtualId: manifest.virtualId,
        entry: {
          rootPath: dirPath,
          workspaceId: manifest.workspaceId,
          uberProjectId: manifest.uberProjectId,
          feature: manifest.feature,
          branch: manifest.branch,
          updatedAt: deps.now(),
        },
      });
      adopted.push(manifest.virtualId);
    }
  }
  if (additions.length > 0) {
    await updateIndex(deps, (index) => {
      for (const addition of additions) {
        index.virtual[addition.virtualId] = addition.entry;
      }
    });
  }
  return adopted;
}

async function finishArchivingCascade(
  deps: ServiceDeps,
  manifest: VirtualWorkspaceManifest,
): Promise<{ finished: boolean }> {
  const teardown = await teardownConstituents(deps, manifest, new Set());
  if (teardown.blocked.length > 0) {
    manifest.state = "teardown-blocked";
    manifest.updatedAt = deps.now();
    await writeManifest(deps.fs, manifest);
    return { finished: false };
  }
  if (await removeOwnedProject(deps, manifest)) return { finished: false };
  manifest.state = "archived";
  await finalizeRemoval(deps, manifest);
  return { finished: true };
}

export async function reconcileVirtualWorkspaces(deps: ServiceDeps): Promise<{
  ok: boolean;
  error: string | null;
  report: ReconcileReport;
}> {
  const report = emptyReconcileReport();
  const snapshot = await deps.settings.snapshot();
  let host: HostWorkspaceRef[];
  try {
    host = await deps.workspaces.listWorkspaces();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { ok: false, error: `cannot list host workspaces: ${message}`, report };
  }
  const hostById = new Map(host.map((entry) => [entry.id, entry]));
  const hostByCwd = new Map(host.map((entry) => [normalizeAbsolute(entry.cwd), entry]));

  const index = await loadIndex(deps.fs, deps.paseoHome);
  report.adopted.push(
    ...(await adoptFromScan(deps, snapshot, new Set(Object.keys(index.virtual)))),
  );
  const fresh = await loadIndex(deps.fs, deps.paseoHome);

  for (const [virtualId, entry] of Object.entries(fresh.virtual)) {
    if (!(await deps.fs.isDirectory(entry.rootPath))) {
      report.orphaned.push(virtualId);
      continue;
    }
    const raw = await readManifest(deps.fs, entry.rootPath);
    const manifest = raw ? normalizeManifest(raw) : null;
    if (!manifest) {
      report.invalid.push(virtualId);
      continue;
    }
    if (manifest.state === "archived") {
      await finalizeRemoval(deps, manifest);
      report.finishedTeardown.push(virtualId);
      continue;
    }
    if (manifest.state === "archiving") {
      // Crash window: the host-side archive may or may not have happened.
      // Re-issuing it is safe; the archived hook skips manifests already marked archiving.
      if ((await archiveConstituentWorkspaces(deps, manifest)).error) continue;
      if (manifest.workspaceId && hostById.has(manifest.workspaceId)) {
        try {
          await deps.workspaces.archiveWorkspace(manifest.workspaceId);
        } catch {
          // Fall through to the teardown; a missing workspace just means the host is done.
        }
      }
      const done = await finishArchivingCascade(deps, manifest);
      if (done.finished) report.finishedTeardown.push(virtualId);
      continue;
    }
    if (manifest.workspaceId && !hostById.has(manifest.workspaceId)) {
      manifest.workspaceId = null;
      manifest.updatedAt = deps.now();
      await writeManifest(deps.fs, manifest);
      await updateIndex(deps, (next) => {
        const record = next.virtual[virtualId];
        if (record) {
          record.workspaceId = null;
          record.updatedAt = deps.now();
        }
      });
      report.workspaceCleared.push(virtualId);
    }
    if (!manifest.workspaceId) {
      const hostEntry = hostByCwd.get(normalizeAbsolute(manifest.rootPath));
      if (hostEntry) {
        manifest.workspaceId = hostEntry.id;
        manifest.updatedAt = deps.now();
        await writeManifest(deps.fs, manifest);
        await updateIndex(deps, (next) => {
          const record = next.virtual[virtualId];
          if (record) {
            record.workspaceId = hostEntry.id;
            record.updatedAt = deps.now();
          }
        });
        report.relinked.push(virtualId);
      }
    }
    if (manifest.workspaceId) {
      const liveProjectId = hostById.get(manifest.workspaceId)?.projectId ?? null;
      if (liveProjectId && liveProjectId !== manifest.projectId) {
        manifest.projectId = liveProjectId;
        manifest.projectOwned = false;
        manifest.updatedAt = deps.now();
        await writeManifest(deps.fs, manifest);
      }
    }
    await syncWorkspaceTitles(deps, manifest, snapshot, hostById);
    await reconcileConstituentWorkspaces(deps, manifest, hostById, hostByCwd, report);
  }
  return { ok: true, error: null, report };
}

/**
 * Moves rows off the titles older versions wrote and onto `<feature> / <row>`:
 * the root from `<uberProject> / <feature>`, each repo row from its directory
 * name. A title the user set is never overwritten.
 */
async function syncWorkspaceTitles(
  deps: ServiceDeps,
  manifest: VirtualWorkspaceManifest,
  snapshot: SettingsSnapshot,
  hostById: Map<string, HostWorkspaceRef>,
): Promise<void> {
  const legacyRoot = legacyRootWorkspaceTitle(
    lookupUberProjectName(snapshot, manifest.uberProjectId),
    manifest.feature,
  );
  const renames: Array<{ workspaceId: string; title: string; from: string }> = [];

  const rootWorkspaceId = manifest.workspaceId;
  const liveRoot = rootWorkspaceId ? hostById.get(rootWorkspaceId) : undefined;
  if (rootWorkspaceId && liveRoot?.name === legacyRoot) {
    renames.push({
      workspaceId: rootWorkspaceId,
      title: rootWorkspaceTitle(manifest.feature),
      from: legacyRoot,
    });
  }
  for (const constituent of manifest.constituents) {
    const workspaceId = constituent.workspaceId;
    const live = workspaceId ? hostById.get(workspaceId) : undefined;
    if (!workspaceId || !live) continue;
    if (live.name !== lastSegment(constituent.worktreePath)) continue;
    const title = repoWorkspaceTitle(manifest.feature, constituent.repoId);
    if (live.name === title) continue;
    renames.push({ workspaceId, title, from: live.name ?? "" });
  }

  for (const rename of renames) {
    try {
      await deps.workspaces.renameWorkspace(rename.workspaceId, rename.title);
    } catch {
      // Cosmetic: the next reconcile retries.
    }
  }
}

/**
 * Keeps the per-repo rows aligned with the host: a row the user archived is
 * re-registered while its worktree still exists, and an id the host no longer
 * knows is dropped so nothing else trusts it.
 */
async function reconcileConstituentWorkspaces(
  deps: ServiceDeps,
  manifest: VirtualWorkspaceManifest,
  hostById: Map<string, HostWorkspaceRef>,
  hostByCwd: Map<string, HostWorkspaceRef>,
  report: ReconcileReport,
): Promise<void> {
  let changed = false;
  for (const constituent of manifest.constituents) {
    if (constituent.state !== "created") continue;
    const key = `${manifest.virtualId}/${constituent.repoId}`;
    if (constituent.workspaceId) {
      if (hostById.has(constituent.workspaceId)) continue;
      constituent.workspaceId = null;
      changed = true;
      report.repoWorkspacesCleared.push(key);
    }
    // Adopt a workspace the host already opened on this worktree instead of
    // stacking a second row on the same directory.
    const adopted = hostByCwd.get(normalizeAbsolute(constituent.worktreePath));
    if (adopted) {
      constituent.workspaceId = adopted.id;
      changed = true;
      report.repoWorkspacesCreated.push(key);
      continue;
    }
    if (!manifest.projectId) continue;
    if (!(await deps.fs.isDirectory(constituent.worktreePath))) continue;
    try {
      const created = await deps.workspaces.createDirectoryWorkspace({
        path: constituent.worktreePath,
        title: repoWorkspaceTitle(manifest.feature, constituent.repoId),
        projectId: manifest.projectId,
      });
      constituent.workspaceId = created.workspaceId;
      changed = true;
      report.repoWorkspacesCreated.push(key);
    } catch {
      // Leave it unregistered; the next reconcile retries.
    }
  }
  if (changed) {
    manifest.updatedAt = deps.now();
    await writeManifest(deps.fs, manifest);
  }
}

export async function forgetVirtualWorkspace(
  deps: ServiceDeps,
  virtualId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const index = await loadIndex(deps.fs, deps.paseoHome);
  const entry = index.virtual[virtualId];
  if (!entry) return { ok: false, error: `unknown virtual workspace: ${virtualId}` };
  if (await deps.fs.isDirectory(entry.rootPath)) {
    const manifest = await readManifest(deps.fs, entry.rootPath);
    if (manifest && normalizeManifest(manifest)) {
      return {
        ok: false,
        error: `workspace has a live manifest at ${entry.rootPath}; archive it instead of forgetting`,
      };
    }
  }
  await updateIndex(deps, (next) => {
    delete next.virtual[virtualId];
  });
  return { ok: true, error: null };
}

export async function cleanupVirtualWorkspace(
  deps: ServiceDeps,
  virtualId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const index = await loadIndex(deps.fs, deps.paseoHome);
  const entry = index.virtual[virtualId];
  if (!entry) return { ok: false, error: `unknown virtual workspace: ${virtualId}` };
  if (await deps.fs.isDirectory(entry.rootPath)) {
    const manifest = await readManifest(deps.fs, entry.rootPath);
    if (manifest && normalizeManifest(manifest)) {
      return {
        ok: false,
        error: `workspace has a live manifest at ${entry.rootPath}; archive it instead of cleaning up`,
      };
    }
    try {
      await deps.fs.removeRecursive(entry.rootPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return { ok: false, error: `failed to remove ${entry.rootPath}: ${message}` };
    }
  }
  await updateIndex(deps, (next) => {
    delete next.virtual[virtualId];
  });
  return { ok: true, error: null };
}

export async function repairConstituent(
  deps: ServiceDeps,
  virtualId: string,
  repoId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const index = await loadIndex(deps.fs, deps.paseoHome);
  const entry = index.virtual[virtualId];
  if (!entry) return { ok: false, error: `unknown virtual workspace: ${virtualId}` };
  const raw = await readManifest(deps.fs, entry.rootPath);
  const manifest = raw ? normalizeManifest(raw) : null;
  if (!manifest) return { ok: false, error: `manifest missing at ${entry.rootPath}` };
  const constituent = manifest.constituents.find((item) => item.repoId === repoId);
  if (!constituent) return { ok: false, error: `unknown repo: ${repoId}` };
  if (constituent.state === "removed") {
    return { ok: false, error: `${repoId} was removed by archive and cannot be repaired` };
  }
  if (await deps.fs.isDirectory(constituent.worktreePath)) {
    return { ok: false, error: `${repoId} worktree is already present; nothing to repair` };
  }
  if (!(await deps.fs.isDirectory(constituent.sourcePath))) {
    return { ok: false, error: `source is not a directory: ${constituent.sourcePath}` };
  }
  if (!(await isGitRepo(deps.git, constituent.sourcePath))) {
    return { ok: false, error: `source is not a git repo: ${constituent.sourcePath}` };
  }
  if (!(await localBranchExists(deps.git, constituent.sourcePath, constituent.branch))) {
    return {
      ok: false,
      error: `branch ${constituent.branch} no longer exists in ${repoId}; recreate it first`,
    };
  }
  // A worktree directory deleted by hand leaves stale admin metadata behind,
  // which makes git report the branch as still checked out. Pruning drops
  // entries whose directories are gone; anything still genuinely checked out
  // elsewhere is reported below.
  try {
    await deps.git.run(["worktree", "prune"], constituent.sourcePath);
  } catch {
    // Pruning is best-effort; the checked-out guard below still applies.
  }
  const checkedOut = await listWorktreeBranches(deps.git, constituent.sourcePath);
  if (checkedOut.includes(constituent.branch) && !manifest.importDefaults) {
    return {
      ok: false,
      error: `branch ${constituent.branch} is already checked out in ${repoId}; remove that worktree first`,
    };
  }
  if (await deps.fs.exists(constituent.worktreePath)) {
    return { ok: false, error: `target path already exists: ${constituent.worktreePath}` };
  }
  try {
    if (manifest.importDefaults && checkedOut.includes(constituent.branch)) {
      // A default import may share its source branch with an existing worktree.
      await deps.git.run(
        ["worktree", "add", "--detach", constituent.worktreePath, constituent.branch],
        constituent.sourcePath,
      );
    } else {
      // Checkout mode: the branch already exists, so no -b flag.
      await deps.git.run(
        ["worktree", "add", constituent.worktreePath, constituent.branch],
        constituent.sourcePath,
      );
    }
  } catch (error) {
    return { ok: false, error: `git worktree add failed for ${repoId}: ${gitMessage(error)}` };
  }
  constituent.state = "created";
  manifest.updatedAt = deps.now();
  await writeManifest(deps.fs, manifest);
  await registerConstituentWorkspaces(deps, manifest);
  return { ok: true, error: null };
}

export function emptySettingsSnapshot(): SettingsSnapshot {
  return { uberProjects: [] };
}

export function newTestDeps(overrides: Partial<ServiceDeps> & { fs: FsPort }): ServiceDeps {
  return {
    git: {
      run: () => {
        throw new Error("git not stubbed");
      },
    },
    init: { run: () => Promise.resolve() },
    workspaces: {
      createDirectoryWorkspace: () => {
        throw new Error("workspaces not stubbed");
      },
      archiveWorkspace: () => {
        throw new Error("workspaces not stubbed");
      },
      renameWorkspace: () => {
        throw new Error("workspaces not stubbed");
      },
      listWorkspaces: () => {
        throw new Error("workspaces not stubbed");
      },
      listProjects: () => Promise.resolve([]),
      deleteProject: () => Promise.resolve(),
      createTerminal: () => Promise.resolve(),
    },
    settings: { snapshot: () => Promise.resolve(emptySettingsSnapshot()) },
    paseoHome: "/paseo-home",
    now: () => new Date(0).toISOString(),
    withIndexLock: () => Promise.resolve(() => {}),
    ...overrides,
  };
}

export function voidIndex(): WorkspaceIndex {
  return emptyIndex();
}
