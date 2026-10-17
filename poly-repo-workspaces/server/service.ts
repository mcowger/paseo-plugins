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
import type { PreflightIssue, RepoStatus, VirtualWorkspaceSummary } from "../shared/rpc";
import {
  aheadBehind,
  currentBranch,
  diffShortStat,
  isGitRepo,
  listWorktreeBranches,
  localBranchExists,
  resolveBaseBranch,
  statusPorcelain,
  upstreamRef,
} from "./git";
import { isSameOrInside, joinSegments, normalizeAbsolute } from "./paths";
import { type FsPort, type GitPort, isGitFailure, type WorkspacesPort } from "./ports";
import {
  emptyIndex,
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
  workspaces: WorkspacesPort;
  settings: { snapshot(): Promise<SettingsSnapshot> };
  paseoHome: string;
  now(): string;
  withIndexLock(): Promise<() => void>;
}

export interface CreateInput {
  uberProjectId: string;
  feature: string;
  baseBranchOverrides?: Record<string, string>;
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

const MISSING_WORKTREE = "worktree missing";
const FRAGMENT_CHARS = 4000;

function gitMessage(error: unknown): string {
  if (isGitFailure(error)) {
    const detail = error.stderr.trim() || error.stdout.trim() || error.message;
    return detail.slice(0, 500);
  }
  return error instanceof Error ? error.message : "unknown error";
}

function sanitizeVirtualId(uberProjectId: string, feature: string): string {
  const raw = `${uberProjectId}--${feature}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const trimmed = raw.replace(/^-+|-+$/g, "").slice(0, 120);
  return trimmed.length > 0 ? trimmed : "virtual";
}

async function updateIndex(
  deps: ServiceDeps,
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

export async function createVirtualWorkspace(
  deps: ServiceDeps,
  input: CreateInput,
): Promise<CreateResult> {
  const snapshot = await deps.settings.snapshot();
  const project = snapshot.uberProjects.find((p) => p.id === input.uberProjectId);
  if (!project) return failure(`unknown uber-project: ${input.uberProjectId}`);

  const featureError = validateFeatureName(input.feature);
  if (featureError) return failure(`invalid feature name: ${featureError}`);

  const branch = renderBranchName(project.branchTemplate, {
    uberProjectId: project.id,
    feature: input.feature,
  });
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

  const worktreesRoot = await getWorktreesBaseRoot(deps);
  if (isSameOrInside(worktreesRoot, rootPath)) {
    return failure(
      `virtual root must not live under the Paseo worktrees root (${worktreesRoot}); ` +
        `change virtualRootBase to a path outside it`,
    );
  }
  for (const repo of project.repos) {
    const sourcePath = normalizeAbsolute(repo.sourcePath);
    if (isSameOrInside(sourcePath, rootPath)) {
      return failure(`virtual root must not live inside repo source: ${repo.id}`);
    }
  }

  const virtualId = sanitizeVirtualId(project.id, input.feature);
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

  const timestamp = deps.now();
  if (!manifest) {
    manifest = {
      version: 1,
      virtualId,
      uberProjectId: project.id,
      feature: input.feature,
      branch,
      rootPath,
      workspaceId: null,
      state: "creating",
      constituents: planned.map((p) => ({
        repoId: p.repo.id,
        sourcePath: p.sourcePath,
        worktreePath: p.worktreePath,
        branch,
        baseBranch: "",
        state: "pending" as const,
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
    const base = await resolveBaseBranch(
      deps.git,
      item.sourcePath,
      input.baseBranchOverrides?.[item.repo.id] ?? item.repo.baseBranch,
    );
    if (!base) {
      preflight.push({
        repoId: item.repo.id,
        code: "base-unresolvable",
        message: `cannot resolve base branch for ${item.repo.id}`,
      });
      continue;
    }
    item.baseBranch = base;
    if (constituent) constituent.baseBranch = base;
    if (await localBranchExists(deps.git, item.sourcePath, branch)) {
      preflight.push({
        repoId: item.repo.id,
        code: "branch-exists",
        message: `branch ${branch} already exists in ${item.repo.id}`,
      });
      continue;
    }
    const checkedOut = await listWorktreeBranches(deps.git, item.sourcePath);
    if (checkedOut.includes(branch)) {
      preflight.push({
        repoId: item.repo.id,
        code: "branch-checked-out",
        message: `branch ${branch} is already checked out in ${item.repo.id}`,
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
      await deps.git.run(
        ["worktree", "add", "-b", branch, item.worktreePath, item.baseBranch],
        item.sourcePath,
      );
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
    try {
      const workspaceId = await deps.workspaces.createDirectoryWorkspace({
        path: rootPath,
        title: `${project.displayName} / ${input.feature}`,
      });
      active.workspaceId = workspaceId;
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
  deps: ServiceDeps,
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
        error: constituent.state === "removed" ? "worktree removed" : MISSING_WORKTREE,
      });
      continue;
    }
    try {
      const branch =
        (await currentBranch(deps.git, constituent.worktreePath)) ?? constituent.branch;
      const files = await statusPorcelain(deps.git, constituent.worktreePath);
      const upstream = await upstreamRef(deps.git, constituent.worktreePath);
      const counts = upstream ? await aheadBehind(deps.git, constituent.worktreePath) : null;
      const diffStat =
        files.length > 0 ? await diffShortStat(deps.git, constituent.worktreePath) : null;
      statuses.push({
        repoId: constituent.repoId,
        worktreePath: constituent.worktreePath,
        branch,
        dirty: files.length > 0,
        dirtyFileCount: files.length,
        diffStat,
        ahead: counts?.ahead ?? null,
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
  deps: ServiceDeps,
  manifest: VirtualWorkspaceManifest,
): Promise<void> {
  await deps.fs.removeRecursive(manifest.rootPath).catch(() => {});
  await updateIndex(deps, (index: WorkspaceIndex) => {
    delete index.virtual[manifest.virtualId];
  });
}

export interface TeardownResult {
  blocked: RepoStatus[];
}

export async function teardownConstituents(
  deps: ServiceDeps,
  manifest: VirtualWorkspaceManifest,
  forceRepoIds: Set<string>,
): Promise<TeardownResult> {
  const statuses = await collectStatuses(deps, manifest);
  const blocked: RepoStatus[] = [];
  const sources = new Set<string>();

  for (const constituent of manifest.constituents) {
    if (constituent.state !== "created") continue;
    const status = statuses.find((s) => s.repoId === constituent.repoId);
    if (!status) continue;
    sources.add(constituent.sourcePath);
    if (status.error === MISSING_WORKTREE || status.error === "worktree removed") {
      constituent.state = "removed";
      continue;
    }
    const forced = forceRepoIds.has(constituent.repoId);
    const needsBlock = status.error !== null || status.dirty || (status.ahead ?? 0) > 0;
    if (needsBlock && !forced) {
      blocked.push(status);
      continue;
    }
    try {
      const args = forced
        ? ["worktree", "remove", "--force", constituent.worktreePath]
        : ["worktree", "remove", constituent.worktreePath];
      await deps.git.run(args, constituent.sourcePath);
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
  input: { virtualId: string; forceRepoIds?: string[] },
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
  const statuses = await collectStatuses(deps, current);
  const blocked = statuses.filter((status) => {
    if (status.error === MISSING_WORKTREE || status.error === "worktree removed") return false;
    if (forced.has(status.repoId)) return false;
    return status.error !== null || status.dirty || (status.ahead ?? 0) > 0;
  });
  if (blocked.length > 0) {
    return { ok: false, error: null, blocked };
  }

  current.state = "archiving";
  current.updatedAt = deps.now();
  await writeManifest(deps.fs, current);

  if (current.workspaceId) {
    try {
      await deps.workspaces.archiveWorkspace(current.workspaceId);
    } catch (error) {
      if (!isMissingWorkspace(error)) {
        const message = error instanceof Error ? error.message : "unknown error";
        return {
          ok: false,
          error: `workspace archive failed: ${message}`,
          blocked: [],
        };
      }
    }
  }

  const teardown = await teardownConstituents(deps, current, forced);
  if (teardown.blocked.length > 0) {
    current.state = "teardown-blocked";
    current.updatedAt = deps.now();
    await writeManifest(deps.fs, current);
    return { ok: false, error: null, blocked: teardown.blocked };
  }

  current.state = "archived";
  await finalizeRemoval(deps, current);
  return { ok: true, error: null, blocked: [] };
}

export async function handleWorkspaceArchived(
  deps: ServiceDeps,
  event: { id: string; cwd: string },
): Promise<void> {
  const index = await loadIndex(deps.fs, deps.paseoHome);
  const wantedCwd = normalizeAbsolute(event.cwd);
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

  const teardown = await teardownConstituents(deps, manifest, new Set());
  if (teardown.blocked.length > 0) {
    manifest.state = "teardown-blocked";
    manifest.updatedAt = deps.now();
    await writeManifest(deps.fs, manifest);
    return;
  }
  manifest.state = "archived";
  await finalizeRemoval(deps, manifest);
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
    workspaces: {
      createDirectoryWorkspace: () => {
        throw new Error("workspaces not stubbed");
      },
      archiveWorkspace: () => {
        throw new Error("workspaces not stubbed");
      },
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
