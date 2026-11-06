import { describe, expect, it, vi } from "vitest";
import type { UberProject } from "../shared/config";
import { createArchiveJobManager } from "./archive-jobs";
import { createFakeGit, createFakeWorkspaces, createMemoryFs, gitFailedWith } from "./fakes";
import {
  archiveVirtualWorkspace,
  cleanupVirtualWorkspace,
  collectStatuses,
  createVirtualWorkspace,
  discoverImportBranches,
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

describe("repository initialization", () => {
  it("registers the root and repos before a long init finishes", async () => {
    const p = project({
      repos: [
        {
          id: "frontend",
          sourcePath: "/src/frontend",
          dirTemplate: "{repo}_{branch}",
          initScript: "setup",
        },
        { id: "app", sourcePath: "/src/app", dirTemplate: "{repo}_{branch}" },
      ],
    });
    const { deps, fs, workspaces } = depsFor(p);
    let release: () => void = () => {};
    let signalStart: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStart = resolve;
    });
    deps.init.run = async () => {
      signalStart();
      await gate;
    };
    const creation = createVirtualWorkspace(deps, { uberProjectId: "uber", feature: "feature" });
    await started;
    expect(workspaces.hostWorkspaces.map((entry) => entry.name)).toEqual([
      "feature / Root",
      "feature / frontend",
      "feature / app",
    ]);
    expect(await fs.readFile("/paseo/poly-workspaces/uber-feature/AGENTS.md")).not.toBeNull();
    const summary = (await listVirtualWorkspaces(deps))[0];
    expect(summary?.workspaceId).toBe("wks_test01");
    expect(summary?.state).toBe("creating");
    expect(summary?.constituents.map((item) => item.setupStatus)).toEqual([
      "running-init",
      "ready",
    ]);
    release();
    expect((await creation).ok).toBe(true);
    expect(
      (await readManifest(fs, "/paseo/poly-workspaces/uber-feature"))?.constituents.map(
        (item) => item.setupStatus,
      ),
    ).toEqual(["ready", "ready"]);
  });

  it("retains per-repo preflight failures and resumes after a missing source is restored", async () => {
    const { deps, fs } = depsFor(project());
    await fs.removeRecursive("/src/app");
    const input = { uberProjectId: "uber", feature: "feature" };
    const result = await createVirtualWorkspace(deps, input);
    expect(result.preflight[0]?.code).toBe("source-missing");
    const summary = (await listVirtualWorkspaces(deps))[0];
    expect(summary?.state).toBe("creating");
    expect(summary?.constituents.find((repo) => repo.repoId === "app")?.setupStatus).toBe("failed");
    await fs.mkdirp("/src/app/.git");
    await fs.writeFileAtomic("/src/app/.git/HEAD", "ref: refs/heads/main\n");
    expect((await createVirtualWorkspace(deps, { ...input, resume: true })).ok).toBe(true);
  });

  it("does not run init if a repo workspace cannot be registered, and resumes", async () => {
    const p = project({
      repos: [
        {
          id: "frontend",
          sourcePath: "/src/frontend",
          dirTemplate: "{repo}_{branch}",
          initScript: "setup",
        },
      ],
    });
    const { deps, fs, workspaces } = depsFor(p);
    const register = workspaces.createDirectoryWorkspace;
    let fail = true;
    workspaces.createDirectoryWorkspace = (workspaceInput) => {
      if (fail && workspaceInput.projectId)
        return Promise.reject(new Error("registration unavailable"));
      return register(workspaceInput);
    };
    const runInit = vi.fn(async () => {});
    deps.init.run = runInit;
    const input = { uberProjectId: "uber", feature: "feature" };
    const result = await createVirtualWorkspace(deps, input);
    expect(result.error).toContain("registration unavailable");
    expect(result.workspaceId).toBe("wks_test01");
    expect(runInit).not.toHaveBeenCalled();
    expect(
      (await readManifest(fs, "/paseo/poly-workspaces/uber-feature"))?.constituents[0]?.setupStatus,
    ).toBe("failed");
    fail = false;
    expect((await createVirtualWorkspace(deps, { ...input, resume: true })).ok).toBe(true);
    expect(runInit).toHaveBeenCalledTimes(1);
  });

  it("runs scripts in created worktrees and retries only failed scripts on resume", async () => {
    const p = project({
      repos: [
        {
          id: "frontend",
          sourcePath: "/src/frontend",
          dirTemplate: "{repo}_{branch}",
          initScript: "first",
        },
        { id: "app", sourcePath: "/src/app", dirTemplate: "{repo}_{branch}", initScript: "second" },
      ],
    });
    const { deps, fs } = depsFor(p);
    const calls: Array<[string, string]> = [];
    let fail = true;
    deps.init.run = async (script, cwd) => {
      expect(await fs.isDirectory("/paseo/poly-workspaces/uber-feature/app_feature")).toBe(true);
      calls.push([script, cwd]);
      if (script === "second" && fail) throw new Error("exited with code 1");
    };
    const input = { uberProjectId: "uber", feature: "feature" };
    const result = await createVirtualWorkspace(deps, input);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("init script failed for app");
    expect(result.workspaceId).toBe("wks_test01");
    const failedManifest = await readManifest(fs, "/paseo/poly-workspaces/uber-feature");
    expect(failedManifest?.constituents.map((item) => item.setupStatus)).toEqual([
      "ready",
      "failed",
    ]);
    expect(failedManifest?.constituents[1]?.setupError).toContain("exited with code 1");
    expect((await readManifest(fs, "/paseo/poly-workspaces/uber-feature"))?.state).toBe("creating");
    fail = false;
    expect((await createVirtualWorkspace(deps, { ...input, resume: true })).ok).toBe(true);
    expect(calls).toEqual([
      ["first", "/paseo/poly-workspaces/uber-feature/frontend_feature"],
      ["second", "/paseo/poly-workspaces/uber-feature/app_feature"],
      ["second", "/paseo/poly-workspaces/uber-feature/app_feature"],
    ]);
  });
});

describe("default branch imports", () => {
  it("imports mixed defaults and detaches a default already checked out elsewhere", async () => {
    const p = project({
      repos: [
        {
          id: "frontend",
          sourcePath: "/src/frontend",
          dirTemplate: "{repo}_{branch}",
          baseBranch: "master",
        },
        { id: "app", sourcePath: "/src/app", dirTemplate: "{repo}_{branch}", baseBranch: "main" },
      ],
    });
    const { deps, git, fs } = depsFor(p);
    git.script.existingBranches = ["master", "main"];
    git.script.remoteBranches = ["master", "main"];
    git.script.worktreeBranches = ["master"];
    const result = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "default",
      importDefaults: true,
    });
    expect(result.ok).toBe(true);
    const root = "/paseo/poly-workspaces/uber-default";
    const manifest = await readManifest(fs, root);
    expect(manifest?.branch).toBe("default");
    expect(manifest?.constituents.map(({ repoId, branch }) => [repoId, branch])).toEqual([
      ["frontend", "master"],
      ["app", "main"],
    ]);
    expect(git.script.log).toContainEqual([
      "/src/frontend",
      "worktree",
      "add",
      "--detach",
      `${root}/frontend_default`,
      "master",
    ]);
  });
  it("repairs a missing default import as detached when its branch is checked out", async () => {
    const { deps, fs, git } = depsFor(
      project({
        repos: [
          {
            id: "frontend",
            sourcePath: "/src/frontend",
            dirTemplate: "{repo}_{branch}",
            baseBranch: "main",
          },
        ],
      }),
    );
    git.script.existingBranches = ["main"];
    git.script.remoteBranches = ["main"];
    const created = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "default",
      importDefaults: true,
    });
    expect(created.ok).toBe(true);
    if (!created.virtualId) throw new Error("missing virtual workspace id");
    const root = "/paseo/poly-workspaces/uber-default";
    const worktree = `${root}/frontend_default`;
    fs.dirs.delete(worktree);
    git.script.worktreeBranches = ["main"];
    const run = git.run;
    git.run = (args, cwd) =>
      args[0] === "worktree" && args[1] === "prune"
        ? Promise.resolve({ stdout: "", stderr: "" })
        : run(args, cwd);

    const repaired = await repairConstituent(deps, created.virtualId, "frontend");
    expect(repaired).toEqual({ ok: true, error: null });
    expect(await fs.isDirectory(worktree)).toBe(true);
  });

  it("persists defaults on partial creation and resumes without the input flag", async () => {
    const p = project({
      repos: [
        {
          id: "frontend",
          sourcePath: "/src/frontend",
          dirTemplate: "{repo}_{branch}",
          baseBranch: "master",
        },
        { id: "app", sourcePath: "/src/app", dirTemplate: "{repo}_{branch}", baseBranch: "main" },
      ],
    });
    const { deps, git, fs } = depsFor(p);
    git.script.existingBranches = ["master", "main"];
    git.script.remoteBranches = ["master", "main"];
    git.script.failOn = [
      {
        match: ["worktree", "add", "/paseo/poly-workspaces/uber-default/app_default"],
        message: "simulated partial failure",
      },
    ];
    const input = { uberProjectId: "uber", feature: "default", importDefaults: true };
    expect((await createVirtualWorkspace(deps, input)).ok).toBe(false);
    const root = "/paseo/poly-workspaces/uber-default";
    const manifest = await readManifest(fs, root);
    expect(manifest?.importDefaultBranches).toEqual({ frontend: "master", app: "main" });
    git.script.failOn = [];
    expect(
      (
        await createVirtualWorkspace(deps, {
          uberProjectId: "uber",
          feature: "default",
          resume: true,
        })
      ).ok,
    ).toBe(true);
  });

  it("rejects unavailable defaults and does not fall back to the current branch", async () => {
    const p = project({
      repos: [
        {
          id: "frontend",
          sourcePath: "/src/frontend",
          dirTemplate: "{repo}_{branch}",
          baseBranch: "gone",
        },
      ],
    });
    const { deps } = depsFor(p);
    const result = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "default",
      importDefaults: true,
    });
    expect(result.ok).toBe(false);
    expect(result.preflight[0]?.code).toBe("base-unresolvable");
  });
  it("uses GitHub's advertised symbolic default when local origin/HEAD is missing", async () => {
    const { deps, git } = depsFor(
      project({
        repos: [{ id: "frontend", sourcePath: "/src/frontend", dirTemplate: "{repo}_{branch}" }],
      }),
    );
    git.script.originHead = null;
    git.script.originUrl = "https://github.com/acme/frontend.git";
    git.script.remoteHead = "master";
    git.script.existingBranches = ["master"];
    const result = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "default",
      importDefaults: true,
    });
    expect(result.ok).toBe(true);
    expect(git.script.log).toContainEqual([
      "/src/frontend",
      "ls-remote",
      "--symref",
      "origin",
      "HEAD",
    ]);
  });

  it("does not query an unsafe origin and does not use its error text", async () => {
    const { deps, git } = depsFor(
      project({
        repos: [{ id: "frontend", sourcePath: "/src/frontend", dirTemplate: "{repo}_{branch}" }],
      }),
    );
    git.script.originHead = null;
    git.script.originUrl = "https://evil.example/acme/frontend";
    git.script.remoteHead = "master";
    const result = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "default",
      importDefaults: true,
    });
    expect(result.ok).toBe(false);
    expect(git.script.log?.some((entry) => entry.includes("ls-remote"))).toBe(false);
  });

  it("rejects malformed symbolic HEAD and honors configured and cached defaults first", async () => {
    const configured = depsFor(
      project({
        repos: [
          {
            id: "frontend",
            sourcePath: "/src/frontend",
            dirTemplate: "{repo}_{branch}",
            baseBranch: "main",
          },
        ],
      }),
    );
    configured.git.script.originHead = null;
    configured.git.script.originUrl = "https://github.com/acme/frontend";
    configured.git.script.remoteHead = "master";
    configured.git.script.existingBranches = ["main", "master"];
    await createVirtualWorkspace(configured.deps, {
      uberProjectId: "uber",
      feature: "cfg",
      importDefaults: true,
    });
    expect(configured.git.script.log?.some((entry) => entry.includes("ls-remote"))).toBe(false);

    const malformed = depsFor(
      project({
        repos: [{ id: "frontend", sourcePath: "/src/frontend", dirTemplate: "{repo}_{branch}" }],
      }),
    );
    malformed.git.script.originHead = null;
    malformed.git.script.originUrl = "https://github.com/acme/frontend";
    malformed.git.script.remoteHead = "bad\nHEAD";
    const result = await createVirtualWorkspace(malformed.deps, {
      uberProjectId: "uber",
      feature: "bad",
      importDefaults: true,
    });
    expect(result.ok).toBe(false);
  });
});
it("does not infer defaults from a feature branch when origin/HEAD is missing", async () => {
  const p = project({
    repos: [{ id: "frontend", sourcePath: "/src/frontend", dirTemplate: "{repo}_{branch}" }],
  });
  const { deps, git } = depsFor(p);
  git.script.originHead = null;
  git.script.currentBranch = "feature/work";
  const discovery = await discoverImportBranches(deps, "uber");
  expect(discovery.defaults).toEqual([]);
  expect(discovery.defaultError).toContain("cannot resolve available default branch");
  const created = await createVirtualWorkspace(deps, {
    uberProjectId: "uber",
    feature: "default",
    importDefaults: true,
  });
  expect(created.ok).toBe(false);
  expect(created.preflight[0]?.code).toBe("base-unresolvable");
});
it("blocks archiving a detached default import with unreferenced commits", async () => {
  const p = project({
    repos: [
      {
        id: "frontend",
        sourcePath: "/src/frontend",
        dirTemplate: "{repo}_{branch}",
        baseBranch: "main",
      },
    ],
  });
  const { deps, git } = depsFor(p);
  git.script.existingBranches = ["main"];
  git.script.worktreeBranches = ["main"];
  git.script.currentBranch = "HEAD";
  git.script.aheadBehind = "1";
  const created = await createVirtualWorkspace(deps, {
    uberProjectId: "uber",
    feature: "default",
    importDefaults: true,
  });
  expect(created.ok).toBe(true);
  if (!created.virtualId) throw new Error("missing virtual workspace id");
  const archived = await archiveVirtualWorkspace(deps, { virtualId: created.virtualId });
  expect(archived.ok).toBe(false);
  expect(archived.blocked[0]?.ahead).toBe(1);
});

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
    expect(workspaces.created).toEqual([
      { path: root, title: "featureA / Root" },
      { path: `${root}/frontend_featureA`, title: "featureA / frontend", projectId: "proj_test01" },
      { path: `${root}/app_featureA`, title: "featureA / app", projectId: "proj_test01" },
    ]);
    const manifest = await readManifest(fs, root);
    expect(manifest?.projectId).toBe("proj_test01");
    expect(manifest?.constituents.map((item) => item.workspaceId)).toEqual([
      "wks_test02",
      "wks_test03",
    ]);
    const adds = (git.script.log ?? []).filter((args) => args.includes("add"));
    expect(adds).toHaveLength(2);

    const listed = await listVirtualWorkspaces(deps);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.state).toBe("ready");
    expect(listed[0]?.constituents).toHaveLength(2);
  });

  it("preserves the friendly name but sanitizes branches and folder names", async () => {
    const { deps, fs, git, workspaces } = depsFor(project());
    const feature = "SIG: ABSCD - Fix My Stuff";
    const branch = "sig-abscd-fix-my-stuff";
    const root = `/paseo/poly-workspaces/uber-${branch}`;

    const result = await createVirtualWorkspace(deps, { uberProjectId: "uber", feature });

    expect(result.ok).toBe(true);
    expect(workspaces.created).toEqual([
      { path: root, title: `${feature} / Root` },
      {
        path: `${root}/frontend_${branch}`,
        title: `${feature} / frontend`,
        projectId: "proj_test01",
      },
      { path: `${root}/app_${branch}`, title: `${feature} / app`, projectId: "proj_test01" },
    ]);
    expect(await fs.readFile(`${root}/AGENTS.md`)).toContain(feature);
    const manifest = await readManifest(fs, root);
    expect(manifest?.feature).toBe(feature);
    expect(manifest?.branch).toBe(branch);
    expect(manifest?.constituents.map((item) => item.worktreePath)).toEqual([
      `${root}/frontend_${branch}`,
      `${root}/app_${branch}`,
    ]);
    const adds = (git.script.log ?? []).filter((args) => args.includes("add"));
    expect(adds).toHaveLength(2);
    expect(adds.every((args) => args[4] === branch)).toBe(true);
    expect((await listVirtualWorkspaces(deps))[0]?.feature).toBe(feature);
  });

  it("resumes a failed creation using the same friendly name and sanitized paths", async () => {
    const { deps, fs, git } = depsFor(project());
    const input = { uberProjectId: "uber", feature: "SIG: ABSCD - Fix My Stuff" };
    const root = "/paseo/poly-workspaces/uber-sig-abscd-fix-my-stuff";
    const appPath = `${root}/app_sig-abscd-fix-my-stuff`;
    git.script.failOn = [{ match: ["worktree", "add", appPath], message: "disk exploded" }];
    expect((await createVirtualWorkspace(deps, input)).ok).toBe(false);
    const before = await readManifest(fs, root);
    expect(before?.constituents.map((item) => item.state)).toEqual(["created", "pending"]);
    git.script.failOn = [];
    expect((await createVirtualWorkspace(deps, { ...input, resume: true })).ok).toBe(true);
    const after = await readManifest(fs, root);
    expect(after?.rootPath).toBe(before?.rootPath);
    expect(after?.branch).toBe(before?.branch);
    expect(after?.constituents.map((item) => item.worktreePath)).toEqual(
      before?.constituents.map((item) => item.worktreePath),
    );
    expect(after?.constituents.every((item) => item.state === "created")).toBe(true);
    const adds = (git.script.log ?? []).filter((args) => args.includes("add"));
    expect(
      adds.filter((args) => args.includes(`${root}/frontend_sig-abscd-fix-my-stuff`)),
    ).toHaveLength(1);
    expect(adds.filter((args) => args.includes(appPath))).toHaveLength(2);
  });

  it.each([
    ["feature", "修 复"],
    ["Fix my stuff", "Fix: my stuff"],
  ])("refuses to resume %j as a different name %j", async (original, alias) => {
    const { deps, git } = depsFor(project());
    git.script.failOn = [gitFailedWith("disk exploded")];
    await createVirtualWorkspace(deps, { uberProjectId: "uber", feature: original });
    git.script.failOn = [];
    const result = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: alias,
      resume: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("different feature name");
    const listed = await listVirtualWorkspaces(deps);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.feature).toBe(original);
    expect(listed[0]?.state).toBe("creating");
  });

  it("does not overwrite a workspace when two friendly names sanitize to the same path", async () => {
    const { deps, git } = depsFor(project());
    expect(
      (await createVirtualWorkspace(deps, { uberProjectId: "uber", feature: "Fix: my stuff" })).ok,
    ).toBe(true);
    const addsBefore = (git.script.log ?? []).filter((args) => args.includes("add")).length;
    const duplicate = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "Fix my stuff!",
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toContain("already exists");
    expect((git.script.log ?? []).filter((args) => args.includes("add"))).toHaveLength(addsBefore);
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
  });

  it("rejects invalid feature names and unknown projects", async () => {
    const p = project();
    const { deps } = depsFor(p);

    const invalid = await createVirtualWorkspace(deps, { uberProjectId: "uber", feature: "   " });
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
    // Repo rows leave with their worktrees; the root workspace goes last.
    expect(workspaces.archived).toEqual(["wks_test02", "wks_test03", "wks_test01"]);
    expect(workspaces.deletedProjects).toEqual([{ projectId: "proj_test01", paseoHome: "/paseo" }]);
    const removes = (git.script.log ?? []).filter((args) => args.includes("remove"));
    expect(removes).toHaveLength(2);
    expect(await fs.exists("/paseo/poly-workspaces/uber-featureA")).toBe(false);
    expect(await listVirtualWorkspaces(deps)).toHaveLength(0);
  });

  it("preserves a project with an unrelated active workspace", async () => {
    const { deps, workspaces, virtualId } = await created();
    workspaces.hostWorkspaces.push({
      id: "unrelated",
      cwd: "/elsewhere",
      projectId: "proj_test01",
      name: "Other",
    });
    expect((await archiveVirtualWorkspace(deps, { virtualId })).ok).toBe(true);
    expect(workspaces.deletedProjects).toEqual([]);
    expect(workspaces.hostProjects).toContainEqual({
      id: "proj_test01",
      rootPath: "/paseo/poly-workspaces/uber-featureA",
    });
  });

  it("retains cleanup state when project deletion fails and retries it", async () => {
    const { deps, fs, workspaces, virtualId } = await created();
    workspaces.deleteProjectError = new Error("CLI unavailable");
    const failed = await archiveVirtualWorkspace(deps, { virtualId });
    expect(failed.error).toContain("CLI unavailable");
    expect(await fs.exists("/paseo/poly-workspaces/uber-featureA")).toBe(true);
    workspaces.deleteProjectError = null;
    expect((await archiveVirtualWorkspace(deps, { virtualId })).ok).toBe(true);
    expect(workspaces.hostProjects).toEqual([]);
  });

  it("keeps the index when root removal fails", async () => {
    const { deps, fs, virtualId } = await created();
    const remove = fs.removeRecursive;
    fs.removeRecursive = async () => {
      throw new Error("permission denied");
    };
    const failed = await archiveVirtualWorkspace(deps, { virtualId });
    expect(failed.error).toContain("permission denied");
    expect((await listVirtualWorkspaces(deps)).map((item) => item.virtualId)).toContain(virtualId);
    fs.removeRecursive = remove;
    expect((await archiveVirtualWorkspace(deps, { virtualId })).ok).toBe(true);
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

  it("force removes dirty worktrees when host archive hooks fail", async () => {
    const { deps, fs, git, workspaces, virtualId } = await created();
    git.script.porcelain = () => " M dirty.ts\n";
    workspaces.archiveWorkspace = () => Promise.reject(new Error("archive hook failed"));

    const blocked = await archiveVirtualWorkspace(deps, { virtualId });
    expect(blocked.ok).toBe(false);
    expect(await fs.exists("/paseo/poly-workspaces/uber-featureA")).toBe(true);

    const result = await archiveVirtualWorkspace(deps, { virtualId, force: true });
    expect(result.ok).toBe(true);
    const removes = (git.script.log ?? []).filter((args) => args.includes("remove"));
    expect(removes).toHaveLength(2);
    expect(removes.every((args) => args.includes("--force"))).toBe(true);
    expect(await fs.exists("/paseo/poly-workspaces/uber-featureA")).toBe(false);
    expect(await listVirtualWorkspaces(deps)).toHaveLength(0);
  });

  it("removes worktree directories and prunes when forced Git removal fails", async () => {
    const { deps, fs, git, virtualId } = await created();
    git.script.failOn = [{ match: ["worktree", "remove"], message: "git remove failed" }];
    const result = await archiveVirtualWorkspace(deps, { virtualId, force: true });
    expect(result.ok).toBe(true);
    expect(await fs.exists("/paseo/poly-workspaces/uber-featureA")).toBe(false);
    expect((git.script.log ?? []).some((args) => args.includes("--expire"))).toBe(true);
    expect(await listVirtualWorkspaces(deps)).toHaveLength(0);
  });

  it("retains the index and reports filesystem removal failures", async () => {
    const { deps, fs, git, virtualId } = await created();
    const root = "/paseo/poly-workspaces/uber-featureA";
    const remove = fs.removeRecursive;
    fs.removeRecursive = (path) =>
      path === `${root}/frontend_featureA`
        ? Promise.reject(new Error("permission denied"))
        : remove(path);
    git.script.failOn = [{ match: ["worktree", "remove"], message: "git remove failed" }];
    const result = await archiveVirtualWorkspace(deps, { virtualId, force: true });
    expect(result.ok).toBe(false);
    expect(result.blocked[0]?.error).toContain("permission denied");
    expect(await fs.exists(root)).toBe(true);
    expect(await listVirtualWorkspaces(deps)).toHaveLength(1);
  });

  it("retains the workspace on prune failure and retries missing worktrees", async () => {
    const { deps, fs, git, virtualId } = await created();
    git.script.failOn = [
      { match: ["worktree", "remove"], message: "git remove failed" },
      { match: ["worktree", "prune"], message: "git prune failed" },
    ];
    const first = await archiveVirtualWorkspace(deps, { virtualId, force: true });
    expect(first.ok).toBe(false);
    expect(first.blocked[0]?.error).toContain("git prune failed");
    expect(await fs.exists("/paseo/poly-workspaces/uber-featureA")).toBe(true);
    expect(await listVirtualWorkspaces(deps)).toHaveLength(1);

    git.script.failOn = [];
    const retry = await archiveVirtualWorkspace(deps, { virtualId, force: true });
    expect(retry.ok).toBe(true);
    expect(await listVirtualWorkspaces(deps)).toHaveLength(0);
  });

  it("keeps the workspace when a registered worktree survives pruning", async () => {
    const { deps, fs, git, virtualId } = await created();
    const root = "/paseo/poly-workspaces/uber-featureA";
    git.script.failOn = [{ match: ["worktree", "remove"], message: "git remove failed" }];
    const run = git.run;
    git.run = (args, cwd) =>
      args.includes("list") && args.includes("-z")
        ? Promise.resolve({ stdout: `worktree ${root}/frontend_featureA\0locked\0`, stderr: "" })
        : run(args, cwd);
    const result = await archiveVirtualWorkspace(deps, { virtualId, force: true });
    expect(result.ok).toBe(false);
    expect(result.blocked[0]?.error).toContain("still lists worktree");
    expect(await fs.exists(root)).toBe(true);
    expect(await listVirtualWorkspaces(deps)).toHaveLength(1);
  });

  it("refuses to recursively remove a worktree outside the root", async () => {
    const { deps, fs, git, virtualId } = await created();
    const root = "/paseo/poly-workspaces/uber-featureA";
    const manifest = await readManifest(fs, root);
    const constituent = manifest?.constituents[0];
    if (!manifest || !constituent) throw new Error("missing manifest or constituent");
    constituent.worktreePath = "/src/frontend";
    await writeManifest(fs, manifest);
    git.script.failOn = [{ match: ["worktree", "remove"], message: "git remove failed" }];
    const result = await archiveVirtualWorkspace(deps, { virtualId, force: true });
    expect(result.ok).toBe(false);
    expect(result.blocked[0]?.error).toContain("unsafe worktree path");
    expect(await fs.isDirectory("/src/frontend")).toBe(true);
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

  it("clears stale running setup labels after a plugin reload", async () => {
    const { deps, fs } = await created();
    const manifest = await readManifest(fs, root);
    if (!manifest?.constituents[0] || !manifest.constituents[1])
      throw new Error("missing manifest constituents");
    manifest.state = "creating";
    manifest.constituents[0].setupStatus = "running-init";
    manifest.constituents[0].initState = "pending";
    manifest.constituents[1].state = "pending";
    manifest.constituents[1].setupStatus = "checking-out";
    await writeManifest(fs, manifest);
    await reconcileOnLoad(deps);
    expect((await readManifest(fs, root))?.constituents.map((repo) => repo.setupStatus)).toEqual([
      "checked-out",
      "pending",
    ]);
  });

  it("adopts a manifest directory missing from the index", async () => {
    const p = project();
    const { deps, fs } = depsFor(p);
    const rootB = "/paseo/poly-workspaces/uber-featureB";
    await fs.mkdirp(rootB);
    await writeManifest(deps.fs, {
      version: 2,
      virtualId: "uber-featureb",
      uberProjectId: "uber",
      feature: "featureB",
      branch: "featureB",
      rootPath: rootB,
      workspaceId: null,
      projectId: null,
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
    const manifest = await readManifest(deps.fs, root);
    expect(manifest).not.toBeNull();
    if (manifest) {
      manifest.state = "archiving";
      await writeManifest(deps.fs, manifest);
    }

    const result = await reconcileVirtualWorkspaces(deps);

    expect(result.ok).toBe(true);
    expect(result.report.finishedTeardown).toEqual([virtualId]);
    expect(workspaces.archived).toEqual(["wks_test02", "wks_test03", "wks_test01"]);
    expect(await fs.exists(root)).toBe(false);
    expect(await listVirtualWorkspaces(deps)).toHaveLength(0);
  });

  it("schedules delayed archive recovery without holding resync open", async () => {
    const { deps, fs, git, virtualId } = await created();
    const manifest = await readManifest(fs, root);
    if (!manifest) throw new Error("missing manifest");
    manifest.state = "archiving";
    await writeManifest(fs, manifest);
    let release: () => void = () => {};
    let signalStart: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStart = resolve;
    });
    const run = git.run;
    git.run = async (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        signalStart();
        await gate;
      }
      return run(args, cwd);
    };
    const jobs = createArchiveJobManager();
    let jobId = "";
    const result = await reconcileVirtualWorkspaces(deps, {
      scheduleArchive(id) {
        jobId = jobs.start(id, () => archiveVirtualWorkspace(deps, { virtualId: id }));
      },
    });
    expect(result.report.scheduledTeardown).toEqual([virtualId]);
    await started;
    expect(jobs.get(jobId).state).toBe("running");
    release();
    await vi.waitFor(() => expect(jobs.get(jobId).state).toBe("finished"));
    expect(jobs.get(jobId)).toMatchObject({ state: "finished", result: { ok: true } });
    expect(await fs.exists(root)).toBe(false);
  });

  it("clears stale workspace ids and relinks a reopened root by cwd", async () => {
    const { deps, virtualId } = await created();
    const fake = deps.workspaces as ReturnType<typeof createFakeWorkspaces>;
    fake.hostWorkspaces.length = 0;

    const cleared = await reconcileVirtualWorkspaces(deps);
    expect(cleared.report.workspaceCleared).toEqual([virtualId]);
    expect(cleared.report.repoWorkspacesCleared).toEqual([
      `${virtualId}/frontend`,
      `${virtualId}/app`,
    ]);
    // Both repo rows come back, still inside the recorded project.
    expect(cleared.report.repoWorkspacesCreated).toEqual([
      `${virtualId}/frontend`,
      `${virtualId}/app`,
    ]);
    const listed = await listVirtualWorkspaces(deps);
    expect(listed[0]?.workspaceId).toBeNull();
    expect(listed[0]?.constituents.map((item) => item.workspaceId)).toEqual([
      "wks_test04",
      "wks_test05",
    ]);
    expect(fake.created.slice(3).map((item) => item.projectId)).toEqual([
      "proj_test01",
      "proj_test01",
    ]);

    fake.hostWorkspaces.push({
      id: "wks_reopened",
      cwd: root,
      projectId: "proj_relinked",
      name: "featureA / Root",
    });

    const relinked = await reconcileVirtualWorkspaces(deps);
    expect(relinked.report.relinked).toEqual([virtualId]);
    const relisted = await listVirtualWorkspaces(deps);
    expect(relisted[0]?.workspaceId).toBe("wks_reopened");
  });

  it("upgrades a v1 manifest and registers its repo rows on reconcile", async () => {
    const { deps, fs, workspaces } = depsFor(project());
    const rootB = "/paseo/poly-workspaces/uber-featureB";
    await fs.mkdirp(`${rootB}/frontend_featureB`);
    await fs.mkdirp(`${rootB}/app_featureB`);
    await fs.writeFileAtomic(
      `${rootB}/.polyrepo.json`,
      JSON.stringify({
        version: 1,
        virtualId: "uber-featureb",
        uberProjectId: "uber",
        feature: "featureB",
        branch: "featureB",
        rootPath: rootB,
        workspaceId: "wks_legacy",
        state: "ready",
        constituents: ["frontend", "app"].map((repoId) => ({
          repoId,
          sourcePath: `/src/${repoId}`,
          worktreePath: `${rootB}/${repoId}_featureB`,
          branch: "featureB",
          baseBranch: "main",
          state: "created",
        })),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    workspaces.hostWorkspaces.push({
      id: "wks_legacy",
      cwd: rootB,
      projectId: "proj_legacy",
      name: "featureB / Root",
    });

    // Adoption reads the manifest, so this is also the v1-accepted check.
    const loaded = await reconcileOnLoad(deps);
    expect(loaded.adopted).toEqual(["uber-featureb"]);
    const listed = await listVirtualWorkspaces(deps);
    expect(listed[0]).toMatchObject({ state: "ready", workspaceId: "wks_legacy" });

    const result = await reconcileVirtualWorkspaces(deps);
    expect(result.report.repoWorkspacesCreated).toEqual([
      "uber-featureb/frontend",
      "uber-featureb/app",
    ]);
    const manifest = await readManifest(fs, rootB);
    expect(manifest?.version).toBe(2);
    expect(manifest?.projectId).toBe("proj_legacy");
    expect(manifest?.constituents.map((item) => item.workspaceId)).toEqual([
      "wks_test01",
      "wks_test02",
    ]);
  });

  it("retitles legacy workspace names and leaves user renames alone", async () => {
    const { deps, workspaces, virtualId } = await created();
    const rootEntry = workspaces.hostWorkspaces.find((entry) => entry.id === "wks_test01");
    const repoEntry = workspaces.hostWorkspaces.find((entry) => entry.id === "wks_test02");
    expect(rootEntry?.name).toBe("featureA / Root");
    expect(repoEntry?.name).toBe("featureA / frontend");

    if (rootEntry) rootEntry.name = "Uber / featureA";
    if (repoEntry) repoEntry.name = "frontend_featureA";
    await reconcileVirtualWorkspaces(deps);
    expect(workspaces.renamed).toEqual([
      { workspaceId: "wks_test01", title: "featureA / Root" },
      { workspaceId: "wks_test02", title: "featureA / frontend" },
    ]);

    if (rootEntry) rootEntry.name = "What I called it";
    if (repoEntry) repoEntry.name = "frontend (mine)";
    await reconcileVirtualWorkspaces(deps);
    expect(workspaces.renamed).toHaveLength(2);
    expect(virtualId).toContain("uber");
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

  it("drops a repo row archived from the host and re-registers it on reconcile", async () => {
    const { deps, fs, workspaces, virtualId } = await created();
    const frontend = `${root}/frontend_featureA`;

    await workspaces.archiveWorkspace("wks_test02");
    await handleWorkspaceArchived(deps, { id: "wks_test02", cwd: frontend });

    const manifest = await readManifest(fs, root);
    expect(manifest?.workspaceId).toBe("wks_test01");
    expect(
      manifest?.constituents.find((item) => item.repoId === "frontend")?.workspaceId,
    ).toBeNull();
    expect(await fs.exists(root)).toBe(true);

    const result = await reconcileVirtualWorkspaces(deps);
    expect(result.report.repoWorkspacesCreated).toEqual([`${virtualId}/frontend`]);
    const listed = await listVirtualWorkspaces(deps);
    expect(listed[0]?.constituents.find((item) => item.repoId === "frontend")?.workspaceId).toBe(
      "wks_test04",
    );
  });

  it("adopts a workspace opened by hand on a repo worktree instead of duplicating it", async () => {
    const { deps, fs, workspaces, virtualId } = await created();
    const frontend = `${root}/frontend_featureA`;
    await workspaces.archiveWorkspace("wks_test02");
    await handleWorkspaceArchived(deps, { id: "wks_test02", cwd: frontend });
    // The panel's escape hatch opens the repo path, which mints its own project.
    workspaces.hostWorkspaces.push({
      id: "wks_handmade",
      cwd: frontend,
      projectId: "proj_frontend",
      name: "frontend_featureA",
    });
    const createdBefore = workspaces.created.length;

    const result = await reconcileVirtualWorkspaces(deps);
    expect(result.report.repoWorkspacesCreated).toEqual([`${virtualId}/frontend`]);
    const manifest = await readManifest(fs, root);
    expect(manifest?.constituents.find((item) => item.repoId === "frontend")?.workspaceId).toBe(
      "wks_handmade",
    );
    expect(workspaces.created.length).toBe(createdBefore);
  });

  it("registers a repo workspace when repairing a constituent", async () => {
    const { deps, fs, git, workspaces, virtualId } = await created();
    const frontend = `${root}/frontend_featureA`;
    await workspaces.archiveWorkspace("wks_test02");
    await handleWorkspaceArchived(deps, { id: "wks_test02", cwd: frontend });
    fs.dirs.delete(frontend);
    git.script.existingBranches = ["featureA"];

    const repaired = await repairConstituent(deps, virtualId, "frontend");
    expect(repaired).toEqual({ ok: true, error: null });
    expect(workspaces.created.at(-1)).toEqual({
      path: frontend,
      title: "featureA / frontend",
      projectId: "proj_test01",
    });
    const manifest = await readManifest(fs, root);
    expect(manifest?.constituents.find((item) => item.repoId === "frontend")?.workspaceId).toBe(
      "wks_test04",
    );
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

describe("import branches", () => {
  it("discovers local and origin branches while excluding symbolic origin HEAD", async () => {
    const { deps, git } = depsFor(project());
    const run = git.run;
    git.run = (args, cwd) =>
      args[0] === "for-each-ref"
        ? Promise.resolve({
            stdout:
              cwd === "/src/frontend"
                ? "refs/heads/shared\nrefs/heads/frontend-only\nrefs/remotes/origin/HEAD\n"
                : "refs/remotes/origin/shared\nrefs/heads/app-only\n",
            stderr: "",
          })
        : run(args, cwd);

    const result = await discoverImportBranches(deps, "uber");

    expect(result.branches).toEqual(["shared"]);
    expect(result.error).toBeNull();
  });

  it("checks out a local imported branch independently of the configured template", async () => {
    const { deps, git } = depsFor(project({ branchTemplate: "generated-{feature}" }));
    git.script.existingBranches = ["release/next"];

    const result = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "friendly-name",
      importBranch: "release/next",
    });

    expect(result.ok).toBe(true);
    expect(
      git.script.log?.some(
        (args) =>
          args.includes("worktree") && args.includes("release/next") && !args.includes("-b"),
      ),
    ).toBe(true);
  });

  it("force deletes imported slash-branch worktrees when Git removal fails", async () => {
    const { deps, fs, git } = depsFor(project());
    git.script.existingBranches = ["release/next"];
    const created = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "friendly-name",
      importBranch: "release/next",
    });
    expect(created.ok).toBe(true);
    if (!created.virtualId) throw new Error("missing virtual workspace id");
    const root = "/paseo/poly-workspaces/uber-friendly-name";
    expect(await fs.isDirectory(`${root}/frontend_release/next`)).toBe(true);
    git.script.failOn = [{ match: ["worktree", "remove"], message: "git remove failed" }];

    const removed = await archiveVirtualWorkspace(deps, {
      virtualId: created.virtualId,
      force: true,
    });
    expect(removed.ok).toBe(true);
    expect(await fs.exists(root)).toBe(false);
    expect(await listVirtualWorkspaces(deps)).toHaveLength(0);
  });

  it("refuses fallback removal when a nested worktree resolves outside the root", async () => {
    const { deps, fs, git } = depsFor(project());
    git.script.existingBranches = ["release/next"];
    const created = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "friendly-name",
      importBranch: "release/next",
    });
    if (!created.virtualId) throw new Error("missing virtual workspace id");
    const root = "/paseo/poly-workspaces/uber-friendly-name";
    const realpath = fs.realpath;
    fs.realpath = (path) =>
      path === `${root}/frontend_release/next`
        ? Promise.resolve("/outside/important")
        : realpath(path);
    git.script.failOn = [{ match: ["worktree", "remove"], message: "git remove failed" }];

    const result = await archiveVirtualWorkspace(deps, {
      virtualId: created.virtualId,
      force: true,
    });
    expect(result.ok).toBe(false);
    expect(result.blocked[0]?.error).toContain("unsafe worktree path");
    expect(await fs.isDirectory(`${root}/frontend_release/next`)).toBe(true);
  });

  it("tracks an imported origin branch locally", async () => {
    const { deps, git } = depsFor(project());
    git.script.remoteBranches = ["release"];

    const result = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "friendly-name",
      importBranch: "release",
    });

    expect(result.ok).toBe(true);
    expect(
      git.script.log?.some((args) => args.includes("--track") && args.includes("origin/release")),
    ).toBe(true);
  });

  it("resumes using the persisted import branch when importBranch is omitted", async () => {
    const { deps, fs, git } = depsFor(project());
    git.script.remoteBranches = ["release"];
    git.script.failOn = [
      {
        match: ["worktree", "add", "/paseo/poly-workspaces/uber-friendly-name/app_release"],
        message: "interrupted",
      },
    ];
    const first = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "friendly-name",
      importBranch: "release",
    });
    expect(first.ok).toBe(false);
    git.script.failOn = [];

    const resumed = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "friendly-name",
      resume: true,
    });

    expect(resumed.ok).toBe(true);
    expect(await fs.readFile("/paseo/poly-workspaces/uber-friendly-name/.polyrepo.json")).toContain(
      '"importBranch": "release"',
    );
    expect(git.script.log?.some((args) => args.includes("origin/release"))).toBe(true);
  });

  it("reports an import branch that is no longer present during preflight", async () => {
    const { deps } = depsFor(project());
    const result = await createVirtualWorkspace(deps, {
      uberProjectId: "uber",
      feature: "friendly-name",
      importBranch: "missing",
    });

    expect(result.ok).toBe(false);
    expect(result.preflight).toHaveLength(2);
    expect(result.preflight[0]?.code).toBe("branch-unavailable");
  });
});
