import type { FsPort, GitPort, GitRunResult, WorkspacesPort } from "./ports";
import { isGitFailure } from "./ports";

export function createMemoryFs(seed: Record<string, string> = {}): FsPort & {
  files: Map<string, string>;
  dirs: Set<string>;
} {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>(["/"]);
  for (const path of files.keys()) {
    let current = path.slice(0, path.lastIndexOf("/")) || "/";
    while (current !== "/" && !dirs.has(current)) {
      dirs.add(current);
      current = current.slice(0, current.lastIndexOf("/")) || "/";
    }
  }
  const parent = (path: string): string => {
    const index = path.lastIndexOf("/");
    return index <= 0 ? "/" : path.slice(0, index);
  };
  const ensureParents = (path: string): void => {
    let current = parent(path);
    while (current !== "/" && !dirs.has(current)) {
      dirs.add(current);
      current = parent(current);
    }
    dirs.add("/");
  };
  return {
    files,
    dirs,
    readFile: (path: string) =>
      Promise.resolve(files.has(path) ? (files.get(path) as string) : null),
    writeFileAtomic: (path: string, content: string) => {
      ensureParents(path);
      files.set(path, content);
      return Promise.resolve();
    },
    mkdirp: (path: string) => {
      ensureParents(path);
      dirs.add(path);
      return Promise.resolve();
    },
    readdir: (path: string) => {
      if (!dirs.has(path)) return Promise.resolve(null);
      const prefix = path === "/" ? "/" : `${path}/`;
      const entries = new Set<string>();
      for (const file of files.keys()) {
        if (file.startsWith(prefix)) {
          const rest = file.slice(prefix.length);
          if (!rest.includes("/")) entries.add(rest);
        }
      }
      for (const dir of dirs) {
        if (dir.startsWith(prefix)) {
          const rest = dir.slice(prefix.length);
          if (rest.length > 0 && !rest.includes("/")) entries.add(rest);
        }
      }
      return Promise.resolve([...entries]);
    },
    exists: (path: string) => Promise.resolve(files.has(path) || dirs.has(path)),
    isDirectory: (path: string) => Promise.resolve(dirs.has(path)),
    removeRecursive: (path: string) => {
      const prefix = path === "/" ? "/" : `${path}/`;
      for (const file of files.keys()) {
        if (file === path || file.startsWith(prefix)) files.delete(file);
      }
      for (const dir of dirs) {
        if (dir !== "/" && (dir === path || dir.startsWith(prefix))) dirs.delete(dir);
      }
      return Promise.resolve();
    },
  };
}

export interface FakeGitScript {
  onWorktreeAdd?: (path: string) => void;
  existingBranches?: string[];
  worktreeBranches?: string[];
  originHead?: string | null;
  currentBranch?: string;
  porcelain?: string | ((cwd: string) => string);
  diffStat?: string;
  upstream?: string | null;
  aheadBehind?: string | null;
  failOn?: Array<{ match: string[]; message: string }>;
  log?: string[][];
}

export function createFakeGit(script: FakeGitScript = {}): GitPort & { script: FakeGitScript } {
  const log: string[][] = [];
  const fail = (message: string): never => {
    throw { message, exitCode: 1, stdout: "", stderr: message };
  };
  return {
    script,
    run: (args: string[], cwd: string): Promise<GitRunResult> => {
      log.push([cwd, ...args]);
      script.log = log;
      for (const rule of script.failOn ?? []) {
        if (rule.match.every((part) => args.includes(part))) fail(rule.message);
      }
      const [head, ...rest] = args;
      if (head === "rev-parse" && rest[0] === "--git-dir")
        return Promise.resolve({ stdout: ".git\n", stderr: "" });
      if (head === "symbolic-ref") {
        if (script.originHead === null || script.originHead === undefined) fail("no origin HEAD");
        return Promise.resolve({ stdout: `${script.originHead}\n`, stderr: "" });
      }
      if (head === "show-ref") {
        const ref = rest[rest.length - 1] ?? "";
        const branch = ref.replace(/^refs\/heads\//, "");
        if ((script.existingBranches ?? []).includes(branch)) {
          return Promise.resolve({ stdout: `${"0".repeat(40)} ${ref}\n`, stderr: "" });
        }
        fail(`unknown revision ${ref}`);
      }
      if (head === "worktree" && rest[0] === "list") {
        const body = (script.worktreeBranches ?? [])
          .map((b) => `worktree /wt/${b}\nHEAD ${"0".repeat(40)}\nbranch refs/heads/${b}\n\n`)
          .join("");
        return Promise.resolve({ stdout: body, stderr: "" });
      }
      if (head === "worktree" && rest[0] === "add") {
        const target = rest.findLast((part) => part.startsWith("/"));
        if (target && script.onWorktreeAdd) script.onWorktreeAdd(target);
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (head === "worktree" && (rest[0] === "remove" || rest[0] === "prune")) {
        if (rest[0] === "prune") script.worktreeBranches = [];
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (head === "branch" && rest[0] === "--show-current") {
        return Promise.resolve({ stdout: `${script.currentBranch ?? "main"}\n`, stderr: "" });
      }
      if (head === "rev-parse" && rest.includes("HEAD") && !rest.includes("@{u}")) {
        return Promise.resolve({ stdout: `${script.currentBranch ?? "main"}\n`, stderr: "" });
      }
      if (head === "diff") {
        return Promise.resolve({ stdout: script.diffStat ?? "", stderr: "" });
      }
      if (head === "status") {
        const porcelain =
          typeof script.porcelain === "function" ? script.porcelain(cwd) : (script.porcelain ?? "");
        return Promise.resolve({ stdout: porcelain, stderr: "" });
      }
      if (head === "rev-parse" && rest.includes("@{u}") && rest.includes("--abbrev-ref")) {
        if (script.upstream) {
          return Promise.resolve({ stdout: `${script.upstream}\n`, stderr: "" });
        }
        fail("no upstream");
      }
      if (head === "rev-list") {
        if (script.aheadBehind) {
          return Promise.resolve({ stdout: script.aheadBehind, stderr: "" });
        }
        fail("no upstream");
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    },
  };
}

export function gitFailedWith(message: string): { match: string[]; message: string } {
  return { match: ["worktree", "add"], message };
}

export function createFakeWorkspaces(): WorkspacesPort & {
  created: Array<{ path: string; title: string }>;
  archived: string[];
  terminals: Array<{ workspaceId: string; cwd?: string; name?: string }>;
  hostWorkspaces: Array<{ id: string; cwd: string }>;
} {
  const created: Array<{ path: string; title: string }> = [];
  const archived: string[] = [];
  const terminals: Array<{ workspaceId: string; cwd?: string; name?: string }> = [];
  const hostWorkspaces: Array<{ id: string; cwd: string }> = [];
  let counter = 0;
  return {
    created,
    archived,
    terminals,
    hostWorkspaces,
    createDirectoryWorkspace: (input: { path: string; title: string }) => {
      created.push(input);
      counter += 1;
      return Promise.resolve(`wks_test${String(counter).padStart(2, "0")}`);
    },
    archiveWorkspace: (workspaceId: string) => {
      archived.push(workspaceId);
      return Promise.resolve();
    },
    listWorkspaces: () => Promise.resolve([...hostWorkspaces]),
    createTerminal: (workspaceId: string, input: { cwd?: string; name?: string }) => {
      terminals.push({ workspaceId, ...input });
      return Promise.resolve();
    },
  };
}

export function expectGitFailureMessage(error: unknown): string {
  if (isGitFailure(error)) return error.message;
  throw new Error("expected a git failure");
}
