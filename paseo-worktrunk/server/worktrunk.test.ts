import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import type {
  PluginHookContext,
  PluginHookPayload,
  PluginLifecycleRegistration,
  PluginWorktreeCreateRequest,
} from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktrunkHooks, runWt } from "./worktrunk.js";

type Context = Pick<PluginHookContext, "signal">;
type Request = PluginWorktreeCreateRequest;
type Worktree = PluginHookPayload<"worktree.create.after">["worktree"];

function harness(run?: (args: string[], signal: AbortSignal, timeout: number) => Promise<string>) {
  let before!: (event: { request: Request }, context: Context) => Promise<Request | undefined>;
  let after!: (event: { worktree: Worktree }, context: Context) => Promise<void>;
  const removals: string[] = [];
  const server = {
    addHook(name: string, handler: never) {
      if (name === "worktree.create.before") before = handler;
      else after = handler;
      return () => removals.push(name);
    },
  };
  const cleanup = createWorktrunkHooks(
    server as unknown as Pick<PluginLifecycleRegistration, "addHook">,
    run,
  );
  return { before, after, cleanup, removals };
}

const signal = new AbortController().signal;
const candidate = join(tmpdir(), "paseo-worktrunk-test-absent", "worktree");
const request: Request = {
  branch: "feature/a",
  slug: "feature-a",
  path: "/paseo/original",
  sourceCheckout: "/source",
  repoRoot: process.cwd(),
  kind: "branch-off",
  baseRef: "main",
};

afterEach(() => vi.restoreAllMocks());

describe("Worktrunk hooks", () => {
  it("uses wt's computed destination without changing other request fields", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({ result: candidate }));
    const h = harness(run);
    expect(await h.before({ request }, { signal })).toEqual({
      ...request,
      path: candidate,
    });
    expect(run).toHaveBeenCalledWith(
      [
        "-C",
        "/source",
        "step",
        "eval",
        "--format",
        "json",
        '{{ expected_worktree_path_of_branch("feature/a") }}',
      ],
      signal,
      10_000,
    );
    h.cleanup();
    h.cleanup();
    expect(h.removals).toEqual(["worktree.create.after", "worktree.create.before"]);
  });

  it.each<Request>([
    request,
    {
      kind: "checkout-branch",
      branch: request.branch,
      slug: request.slug,
      path: request.path,
      repoRoot: request.repoRoot,
      sourceCheckout: request.sourceCheckout,
    },
    {
      ...request,
      kind: "checkout-change-request",
      forge: "github",
      changeRequestNumber: 12,
      headRef: "feature/a",
    },
  ])("preserves the $kind creation request", async (input) => {
    const h = harness(vi.fn().mockResolvedValue(JSON.stringify({ result: candidate })));
    expect(await h.before({ request: input }, { signal })).toEqual({ ...input, path: candidate });
  });

  it("safely embeds branch names without executing a shell", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({ result: candidate }));
    const h = harness(run);
    const branch = 'feature/"test"';
    await h.before({ request: { ...request, branch } }, { signal });
    expect(run.mock.calls[0]?.[0][6]).toBe(
      `{{ expected_worktree_path_of_branch(${JSON.stringify(branch)}) }}`,
    );
  });

  it("leaves Paseo unchanged when wt is unavailable or returns invalid output", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = harness(
      vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" })),
    );
    expect(await missing.before({ request }, { signal })).toBeUndefined();
    await missing.after(
      { worktree: { path: "/new", branch: "a", sourceCheckout: "/source" } },
      { signal },
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("wt was not found"));
    const invalid = harness(vi.fn().mockResolvedValue('{"result":"relative"}'));
    expect(await invalid.before({ request }, { signal })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("path calculation failed"));
  });

  it.each(["not json", "{}", '{"result":null}', '{"result":"relative"}'])(
    "falls back for malformed wt output %s",
    async (output) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = harness(vi.fn().mockResolvedValue(output));
      expect(await h.before({ request }, { signal })).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("using Paseo's default worktree path"),
      );
    },
  );

  it("falls back if the computed destination exists", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(vi.fn().mockResolvedValue(JSON.stringify({ result: tmpdir() })));
    expect(await h.before({ request }, { signal })).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "rejects dangerous paths, including symlinked parents",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "paseo-wt-path-"));
      try {
        const repo = join(root, "repo");
        const link = join(root, "git-link");
        await mkdir(join(repo, ".git"), { recursive: true });
        await symlink(join(repo, ".git"), link, "dir");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        for (const path of [
          parse(root).root,
          dirname(repo),
          repo,
          join(repo, ".git", "x"),
          join(link, "x"),
        ]) {
          const h = harness(vi.fn().mockResolvedValue(JSON.stringify({ result: path })));
          expect(
            await h.before({ request: { ...request, repoRoot: repo } }, { signal }),
          ).toBeUndefined();
        }
        expect(warn).toHaveBeenCalledTimes(5);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("runs pre-start before post-start and continues on failures without logging output", async () => {
    const run = vi.fn().mockResolvedValue("");
    const h = harness(run);
    const worktree = { path: "/new", branch: "a", sourceCheckout: "/source" };
    await h.after({ worktree }, { signal });
    expect(run.mock.calls.map((call) => call[0])).toEqual([
      ["-C", "/new", "hook", "pre-start"],
      ["-C", "/new", "hook", "post-start"],
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    run.mockReset().mockRejectedValue(new Error("secret"));
    await expect(h.after({ worktree }, { signal })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pre-start setup did not complete"));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    warn.mockClear();
    run.mockReset().mockResolvedValueOnce("").mockRejectedValueOnce(new Error("secret"));
    await expect(h.after({ worktree }, { signal })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("post-start setup did not complete"));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });

  it("removes partial registration if the host lacks the hook", () => {
    const remove = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const addHook = vi
      .fn()
      .mockReturnValueOnce(remove)
      .mockImplementationOnce(() => {
        throw new Error("unknown");
      });
    createWorktrunkHooks({ addHook } as Pick<PluginLifecycleRegistration, "addHook">)();
    expect(remove).toHaveBeenCalledOnce();
  });
});

describe.skipIf(process.platform === "win32")("Worktrunk subprocess", () => {
  it("closes stdin and stops on timeout or cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-wt-process-"));
    try {
      const executable = join(root, "wt");
      await writeFile(
        executable,
        '#!/bin/sh\nif [ "$1" = stdin ]; then read line || printf closed; else exec /bin/sleep 30; fi\n',
      );
      await chmod(executable, 0o755);
      vi.stubEnv("PATH", root);
      expect(await runWt(["stdin"], signal, 1_000)).toBe("closed");
      await expect(runWt(["sleep"], signal, 100)).rejects.toThrow();
      const controller = new AbortController();
      const pending = runWt(["sleep"], controller.signal, 1_000);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});

let wtAvailable = true;
try {
  execFileSync("wt", ["--version"], { stdio: "ignore" });
} catch {
  wtAvailable = false;
}

describe.skipIf(!wtAvailable || process.platform === "win32")("Worktrunk integration", () => {
  it("runs start hooks after Git creates the configured worktree and respects approvals", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-wt-"));
    const repo = join(root, "repo");
    const config = join(root, "config");
    try {
      await mkdir(repo);
      await mkdir(join(config, "worktrunk"), { recursive: true });
      await writeFile(
        join(config, "worktrunk", "config.toml"),
        'worktree-path = "{{ repo_path }}/../custom-{{ branch | sanitize }}"\n' +
          "pre-start = \"echo '{{ branch }}|{{ base }}|{{ base_worktree_path }}' > template-result\"\n" +
          'post-start = "printf ready > setup-result"\n',
      );
      vi.stubEnv("XDG_CONFIG_HOME", config);
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
      git("init");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      );
      const h = harness();
      const input = { ...request, sourceCheckout: repo, repoRoot: repo };
      const result = await h.before({ request: input }, { signal });
      expect(result?.path).toBe(join(await realpath(root), "custom-feature-a"));
      if (!result) throw new Error("Worktrunk did not return a path");
      git("worktree", "add", "-b", input.branch, result.path);
      await h.after(
        { worktree: { path: result.path, branch: input.branch, sourceCheckout: repo } },
        { signal },
      );
      expect(await readFile(join(result.path, "template-result"), "utf8")).toBe(
        `${input.branch}|${input.branch}|${result.path}\n`,
      );
      for (let i = 0; i < 100; i++) {
        if (
          await access(join(result.path, "setup-result")).then(
            () => true,
            () => false,
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await readFile(join(result.path, "setup-result"), "utf8")).toBe("ready");
      await mkdir(join(result.path, ".config"));
      await writeFile(
        join(result.path, ".config", "wt.toml"),
        'pre-start = "printf approved > project-result"\n',
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await h.after(
        { worktree: { path: result.path, branch: input.branch, sourceCheckout: repo } },
        { signal },
      );
      await expect(access(join(result.path, "project-result"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("check Worktrunk approvals"));
      execFileSync("wt", ["-C", result.path, "config", "approvals", "add", "--yes"], {
        stdio: "ignore",
      });
      warn.mockClear();
      await h.after(
        { worktree: { path: result.path, branch: input.branch, sourceCheckout: repo } },
        { signal },
      );
      expect(await readFile(join(result.path, "project-result"), "utf8")).toBe("approved");
      expect(warn).not.toHaveBeenCalled();
      h.cleanup();
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
