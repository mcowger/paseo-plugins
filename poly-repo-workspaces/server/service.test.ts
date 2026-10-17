import { describe, expect, it } from "vitest";
import type { UberProject } from "../shared/config";
import { createFakeGit, createFakeWorkspaces, createMemoryFs, gitFailedWith } from "./fakes";
import {
  archiveVirtualWorkspace,
  cleanupVirtualWorkspace,
  collectStatuses,
  createVirtualWorkspace,
  forgetVirtualWorkspace,
  getRepoStatuses,
  handleWorkspaceArchived,
  listVirtualWorkspaces,
  newTestDeps,
  reconcileOnLoad,
  reconcileVirtualWorkspaces,
  repairConstituent,
  type ServiceDeps,
} from "./service";
import { readManifest, writeManifest } from "./store";

function project(overrides?: Partial<UberProject>): UberProject {
  return {
    id: "uber",
    displayName: "Uber",
    branchTemplate: "{feature}",
    rootDirTemplate: "{uberProject}-{feature}",
    agentsTemplatePath: "/templates/agents.md",
    repos: [
      { id: "frontend", sourcePath: "/src/frontend", dirTemplate: "{repo}_{branch}" },
      { id: "app", sourcePath: "/src/app", dirTemplate: "{repo}_{branch}" },
    ],
    ...overrides,
  };
}

function seedFs() {
  return createMemoryFs({
    "/templates/agents.md": "# Agents for {{uberProject}} / {{feature}}\n\n{{repos}}\n",
    "/src/frontend/.git/HEAD": "ref: refs/heads/main\n",
    "/src/app/.git/HEAD": "ref: refs/heads/main\n",
  });
}

function depsFor(
  p: UberProject,
  seed = seedFs(),
): {
  deps: ServiceDeps;
  fs: ReturnType<typeof seedFs>;
  git: ReturnType<typeof createFakeGit>;
  workspaces: ReturnType<typeof createFakeWorkspaces>;
} {
  const fs = seed;
  const git = createFakeGit({
    originHead: "refs/remotes/origin/main",
    onWorktreeAdd: (path: string) => {
      void fs.mkdirp(path);
    },
  });
  const workspaces = createFakeWorkspaces();
  const deps = newTestDeps({
    fs,
    git,
    workspaces,
    settings: { snapshot: () => Promise.resolve({ uberProjects: [p] }) },
    paseoHome: "/paseo",
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { deps, fs, git, workspaces };
}

describe("createVirtualWorkspace", () => {
  it("creates worktrees, files, and a workspace on the happy path", async () => {
    const p = project();
    const { deps, fs, git, workspaces } = depsFor(p);

    const result = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "featureA",
    });

    expect(result.ok).toBe(true);
    expect(result.workspaceId).toBe("wks_test01");
    expect(result.preflight).toEqual([]);
    const root = "/paseo/poly-workspaces/uber-featureA";
    expect(await fs.readFile(`${root}/AGENTS.md`)).toContain("frontend_featureA/");
    expect(await fs.readFile(`${root}/REPOMAP.md`)).toContain("## frontend");
    expect(await fs.readFile(`${root}/.polyrepo.json`)).toContain('"state": "ready"');
    expect(workspaces.created).toEqual([{ path: root, title: "Uber / featureA" }]);
    const adds = (git.script.log ?? []).filter((args) => args.includes("add"));
    expect(adds).toHaveLength(2);

    const listed = await listVirtualWorkspaces(deps);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.state).toBe("ready");
    expect(listed[0]?.constituents).toHaveLength(2);
  });

  it("creates per-repo terminals when requested", async () => {
    const p = project();
    const { deps, workspaces } = depsFor(p);

    const result = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "featureA",
      createTerminals: true,
    });

    expect(result.ok).toBe(true);
    expect(workspaces.terminals.map((t) => t.name)).toEqual(["root", "frontend", "app"]);
  });

  it("fails preflight when the branch already exists", async () => {
    const p = project();
    const { deps } = depsFor(p);
    deps.git = createFakeGit({
      originHead: "refs/remotes/origin/main",
      existingBranches: ["featureA"],
    });

    const result = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "featureA",
    });

    expect(result.ok).toBe(false);
    expect(result.preflight).toHaveLength(2);
    expect(result.preflight[0]?.code).toBe("branch-exists");
    const manifest = await readManifest(deps.fs, "/paseo/poly-workspaces/uber-featureA");
    expect(manifest?.state).toBe("creating");
  });

  it("refuses a second create without resume and resumes with it", async () => {
    const p = project();
    const { deps, git } = depsFor(p);
    git.script.failOn = [gitFailedWith("disk exploded")];

    const first = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "featureA",
    });
    expect(first.ok).toBe(false);
    expect(first.error).toContain("disk exploded");

    const second = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "featureA",
    });
    expect(second.ok).toBe(false);
    expect(second.error).toContain("already exists");

    git.script.failOn = [];
    const resumed = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "featureA",
      resume: true,
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.workspaceId).toBe("wks_test01");
  });

  it("rejects roots under the worktrees root and inside sources", async () => {
    const p = project();
    const { deps } = depsFor(p);

    const underWorktrees = await createVirtualWorkspace(
      { ...deps, paseoHome: "/paseo" },
      { uberProjectId: "uber", feature: "featureA" },
    );
    expect(underWorktrees.ok).toBe(true);

    const badBase = project({ virtualRootBase: "/paseo/worktrees/sneaky" });
    const badDeps = newTestDeps({
      ...deps,
      settings: { snapshot: () => Promise.resolve({ uberProjects: [badBase] }) },
    });
    const rejected = await createVirtualWorkspace(badDeps, {
      uberProjectId: "uber",
      feature: "featureA",
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("worktrees root");

    const insideSource = project({ virtualRootBase: "/src/frontend/nested" });
    const insideDeps = newTestDeps({
      ...deps,
      settings: { snapshot: () => Promise.resolve({ uberProjects: [insideSource] }) },
    });
    const inside = await createVirtualWorkspace(insideDeps, {
      uberProjectId: "uber",
      feature: "featureA",
    });
    expect(inside.ok).toBe(false);
    expect(inside.error).toContain("inside repo source");
  });

  it("rejects invalid feature names and unknown projects", async () => {
    const p = project();
    const { deps } = depsFor(p);

    const invalid = await createVirtualWorkspace(deps, { uberProjectId: "uber", feature: "a..b" });
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain("invalid feature name");

    const unknown = await createVirtualWorkspace(deps, {
      uberProjectId: "nope",
      feature: "featureA",
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("unknown uber-project");
  });
});

describe("archiveVirtualWorkspace", () => {
  async function created() {
    const p = project();
    const ctx = depsFor(p);
    const result = await createVirtualWorkspace(ctx.deps, {
      uberProjectId: "uber",
      feature: "featureA",
    });
    expect(result.ok).toBe(true);
    return { ...ctx, virtualId: result.virtualId as string };
  }

  it("archives clean workspaces and removes everything", async () => {
    const { deps, fs, git, workspaces, virtualId } = await created();

    const result = await archiveVirtualWorkspace(deps, { virtualId });

    expect(result.ok).toBe(true);
    expect(workspaces.archived).toEqual(["wks_test01"]);
    const removes = (git.script.log ?? []).filter((args) => args.includes("remove"));
    expect(removes).toHaveLength(2);
    expect(await fs.exists("/paseo/poly-workspaces/uber-featureA")).toBe(false);
    expect(await listVirtualWorkspaces(deps)).toHaveLength(0);
  });

  it("blocks when a constituent is dirty and leaves the tree intact", async () => {
    const { deps, fs, git, workspaces, virtualId } = await created();
    git.script.porcelain = (cwd: string) => (cwd.includes("frontend") ? " M dirty.ts\n" : "");

    const result = await archiveVirtualWorkspace(deps, { virtualId });

    expect(result.ok).toBe(false);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.repoId).toBe("frontend");
    expect(workspaces.archived).toEqual([]);
    expect(await fs.exists("/paseo/poly-workspaces/uber-featureA")).toBe(true);
  });

  it("blocks when a constituent is ahead and removes it with force", async () => {
    const { deps, git, virtualId } = await created();
    git.script.upstream = "origin/featureA";
    git.script.aheadBehind = "2\t0\n";

    const blocked = await archiveVirtualWorkspace(deps, { virtualId });
    expect(blocked.ok).toBe(false);
    expect(blocked.blocked[0]?.ahead).toBe(2);

    const forced = await archiveVirtualWorkspace(deps, {
      virtualId,
      forceRepoIds: ["frontend", "app"],
    });
    expect(forced.ok).toBe(true);
    expect(await listVirtualWorkspaces(deps)).toHaveLength(0);
  });

  it("ignores archives the plugin RPC already owns", async () => {
    const { deps, fs, git } = await created();
    const root = "/paseo/poly-workspaces/uber-featureA";
    const manifest = await readManifest(deps.fs, root);
    expect(manifest).not.toBeNull();
    if (manifest) {
      manifest.state = "archiving";
      await writeManifest(deps.fs, manifest);
    }
    const removesBefore = (git.script.log ?? []).filter((args) => args.includes("remove")).length;

    await handleWorkspaceArchived(deps, { id: "wks_test01", cwd: root });

    const removesAfter = (git.script.log ?? []).filter((args) => args.includes("remove")).length;
    expect(removesAfter).toBe(removesBefore);
    expect(await fs.exists(root)).toBe(true);
  });

  it("marks teardown-blocked when a native archive meets dirty work", async () => {
    const { deps, fs, git, virtualId } = await created();
    git.script.porcelain = " M dirty.ts\n";
    const manifest = await readManifest(deps.fs, "/paseo/poly-workspaces/uber-featureA");
    expect(manifest?.workspaceId).toBe("wks_test01");

    await handleWorkspaceArchived(deps, {
      id: "wks_test01",
      cwd: "/paseo/poly-workspaces/uber-featureA",
    });

    expect(await fs.exists("/paseo/poly-workspaces/uber-featureA")).toBe(true);
    const listed = await listVirtualWorkspaces(deps);
    expect(listed[0]?.state).toBe("teardown-blocked");
    expect(virtualId).toContain("uber");
  });
});

describe("statuses", () => {
  it("reports clean repos with upstream counts", async () => {
    const p = project();
    const { deps, git } = depsFor(p);
    const created = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "featureA",
    });
    git.script.upstream = "origin/featureA";
    git.script.aheadBehind = "1\t2\n";

    const result = await getRepoStatuses(deps, created.virtualId as string);

    expect(result.ok).toBe(true);
    expect(result.statuses).toHaveLength(2);
    expect(result.statuses[0]).toMatchObject({ dirty: false, ahead: 1, behind: 2, error: null });

    const listed = await listVirtualWorkspaces(deps);
    expect(listed[0]).toMatchObject({ dirtyRepos: 0, aheadRepos: 2 });
  });

  it("reports diffstat for dirty repos", async () => {
    const p = project();
    const { deps, git } = depsFor(p);
    const created = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "featureA",
    });
    expect(created.ok).toBe(true);
    git.script.porcelain = " M dirty.ts\n";
    git.script.diffStat = " 1 file changed, 1 insertion(+)\n";

    const result = await getRepoStatuses(deps, created.virtualId as string);

    expect(result.statuses[0]).toMatchObject({
      dirty: true,
      diffStat: "1 file changed, 1 insertion(+)\n".trim(),
    });

    const listed = await listVirtualWorkspaces(deps);
    expect(listed[0]).toMatchObject({ dirtyRepos: 2, aheadRepos: 0 });
  });

  it("collects statuses without throwing on git errors", async () => {
    const p = project();
    const { deps } = depsFor(p);
    const created = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "featureA",
    });
    const throwing = createFakeGit({ originHead: "refs/remotes/origin/main" });
    throwing.run = () =>
      Promise.reject({ message: "boom", exitCode: 1, stdout: "", stderr: "boom" });
    deps.git = throwing;

    const manifest = await readManifest(deps.fs, "/paseo/poly-workspaces/uber-featureA");
    expect(manifest).not.toBeNull();
    const statuses = await collectStatuses(deps, manifest ?? ({} as never));
    expect(statuses[0]?.error).toContain("boom");
    expect(created.ok).toBe(true);
  });
});

describe("reconcile and repair", () => {
  const root = "/paseo/poly-workspaces/uber-featureA";

  async function created() {
    const p = project();
    const ctx = depsFor(p);
    const result = await createVirtualWorkspace(ctx.deps, {
      uberProjectId: "uber",
      feature: "featureA",
    });
    expect(result.ok).toBe(true);
    return { ...ctx, virtualId: result.virtualId as string };
  }

  it("adopts a manifest directory missing from the index", async () => {
    const p = project();
    const { deps, fs } = depsFor(p);
    const rootB = "/paseo/poly-workspaces/uber-featureB";
    await fs.mkdirp(rootB);
    await writeManifest(deps.fs, {
      version: 1,
      virtualId: "uber-featureb",
      uberProjectId: "uber",
      feature: "featureB",
      branch: "featureB",
      rootPath: rootB,
      workspaceId: null,
      state: "ready",
      constituents: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const loaded = await reconcileOnLoad(deps);
    expect(loaded.adopted).toEqual(["uber-featureb"]);

    const listed = await listVirtualWorkspaces(deps);
    expect(listed.map((item) => item.virtualId)).toEqual(["uber-featureb"]);
  });

  it("finishes a crash-window archive and re-archives the open workspace", async () => {
    const { deps, fs, workspaces, virtualId } = await created();
    workspaces.hostWorkspaces.push({ id: "wks_test01", cwd: root });
    const manifest = await readManifest(deps.fs, root);
    expect(manifest).not.toBeNull();
    if (manifest) {
      manifest.state = "archiving";
      await writeManifest(deps.fs, manifest);
    }

    const result = await reconcileVirtualWorkspaces(deps);

    expect(result.ok).toBe(true);
    expect(result.report.finishedTeardown).toEqual([virtualId]);
    expect(workspaces.archived).toEqual(["wks_test01"]);
    expect(await fs.exists(root)).toBe(false);
    expect(await listVirtualWorkspaces(deps)).toHaveLength(0);
  });

  it("clears a dead workspace id and relinks a reopened workspace by cwd", async () => {
    const { deps, virtualId } = await created();

    const cleared = await reconcileVirtualWorkspaces(deps);
    expect(cleared.report.workspaceCleared).toEqual([virtualId]);
    const listed = await listVirtualWorkspaces(deps);
    expect(listed[0]?.workspaceId).toBeNull();

    const { workspaces } = deps;
    expect(workspaces).toBeDefined();
    const fake = workspaces as ReturnType<typeof createFakeWorkspaces>;
    fake.hostWorkspaces.push({ id: "wks_reopened", cwd: root });

    const relinked = await reconcileVirtualWorkspaces(deps);
    expect(relinked.report.relinked).toEqual([virtualId]);
    const relisted = await listVirtualWorkspaces(deps);
    expect(relisted[0]?.workspaceId).toBe("wks_reopened");
  });

  it("reports orphaned roots and forgets them", async () => {
    const { deps, fs, virtualId } = await created();
    await fs.removeRecursive(root);

    const result = await reconcileVirtualWorkspaces(deps);
    expect(result.report.orphaned).toEqual([virtualId]);
    const listed = await listVirtualWorkspaces(deps);
    expect(listed[0]).toMatchObject({ state: "orphaned", rootExists: false });

    const forgotten = await forgetVirtualWorkspace(deps, virtualId);
    expect(forgotten).toEqual({ ok: true, error: null });
    expect(await listVirtualWorkspaces(deps)).toHaveLength(0);
  });

  it("refuses to forget a workspace with a live manifest", async () => {
    const { deps, virtualId } = await created();

    const refused = await forgetVirtualWorkspace(deps, virtualId);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("archive it instead");
  });

  it("cleans up an invalid root and refuses live manifests", async () => {
    const { deps, fs, virtualId } = await created();

    const refused = await cleanupVirtualWorkspace(deps, virtualId);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("archive it instead");

    await fs.writeFileAtomic(`${root}/.polyrepo.json`, "not json");
    const listed = await listVirtualWorkspaces(deps);
    expect(listed[0]).toMatchObject({ state: "orphaned", rootExists: true });

    const cleaned = await cleanupVirtualWorkspace(deps, virtualId);
    expect(cleaned).toEqual({ ok: true, error: null });
    expect(await fs.exists(root)).toBe(false);
    expect(await listVirtualWorkspaces(deps)).toHaveLength(0);
  });

  it("repairs a missing worktree in checkout mode", async () => {
    const { deps, fs, git, virtualId } = await created();
    const frontend = `${root}/frontend_featureA`;
    fs.dirs.delete(frontend);
    git.script.existingBranches = ["featureA"];

    const repaired = await repairConstituent(deps, virtualId, "frontend");
    expect(repaired).toEqual({ ok: true, error: null });
    const adds = (git.script.log ?? []).filter((args) => args.includes("add"));
    expect(adds[adds.length - 1]).toEqual([
      `/src/frontend`,
      "worktree",
      "add",
      frontend,
      "featureA",
    ]);

    const again = await repairConstituent(deps, virtualId, "frontend");
    expect(again.ok).toBe(false);
    expect(again.error).toContain("nothing to repair");
  });

  it("prunes stale metadata before repairing a hand-deleted worktree", async () => {
    const { deps, fs, git, virtualId } = await created();
    fs.dirs.delete(`${root}/frontend_featureA`);
    git.script.existingBranches = ["featureA"];
    git.script.worktreeBranches = ["featureA"];

    const repaired = await repairConstituent(deps, virtualId, "frontend");
    expect(repaired).toEqual({ ok: true, error: null });
    const prunes = (git.script.log ?? []).filter((args) => args.includes("prune"));
    expect(prunes.length).toBeGreaterThan(0);
  });

  it("refuses repair when the branch is gone", async () => {
    const { deps, fs, git, virtualId } = await created();
    fs.dirs.delete(`${root}/app_featureA`);
    git.script.existingBranches = [];

    const result = await repairConstituent(deps, virtualId, "app");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no longer exists");
  });
});
