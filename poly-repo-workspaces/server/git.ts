import { execCommand } from "@getpaseo/plugin/server";
import type { GitFailure, GitPort, GitRunResult } from "./ports";

const GIT_TIMEOUT_MS = 60_000;

function toFailure(error: unknown): GitFailure {
  if (error && typeof error === "object") {
    const record = error as {
      message?: unknown;
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    const exitCode =
      typeof record.code === "number"
        ? record.code
        : typeof record.code === "string" && /^\d+$/.test(record.code)
          ? Number(record.code)
          : null;
    return {
      message: typeof record.message === "string" ? record.message : "git command failed",
      exitCode,
      stdout: typeof record.stdout === "string" ? record.stdout : "",
      stderr: typeof record.stderr === "string" ? record.stderr : "",
    };
  }
  return {
    message: "git command failed",
    exitCode: null,
    stdout: "",
    stderr: "",
  };
}

export function createGitPort(): GitPort {
  return {
    async run(args: string[], cwd: string): Promise<GitRunResult> {
      try {
        const result = await execCommand("git", args, {
          cwd,
          timeout: GIT_TIMEOUT_MS,
        });
        return { stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        throw toFailure(error);
      }
    },
  };
}

export async function isGitRepo(git: GitPort, path: string): Promise<boolean> {
  try {
    await git.run(["rev-parse", "--git-dir"], path);
    return true;
  } catch {
    return false;
  }
}

export async function localBranchExists(
  git: GitPort,
  sourcePath: string,
  branch: string,
): Promise<boolean> {
  try {
    await git.run(["show-ref", "--verify", `refs/heads/${branch}`], sourcePath);
    return true;
  } catch {
    return false;
  }
}

export async function listWorktreeBranches(git: GitPort, sourcePath: string): Promise<string[]> {
  try {
    const result = await git.run(["worktree", "list", "--porcelain"], sourcePath);
    const branches: string[] = [];
    for (const line of result.stdout.split("\n")) {
      if (!line.startsWith("branch ")) continue;
      const ref = line.slice("branch ".length).trim();
      branches.push(ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref);
    }
    return branches;
  } catch {
    return [];
  }
}

export async function resolveBaseBranch(
  git: GitPort,
  sourcePath: string,
  configured?: string,
): Promise<string | null> {
  if (configured) return configured;
  try {
    const result = await git.run(["symbolic-ref", "refs/remotes/origin/HEAD"], sourcePath);
    const ref = result.stdout.trim();
    const match = /^refs\/remotes\/origin\/(.+)$/.exec(ref);
    if (match?.[1]) return match[1];
  } catch {
    // No origin/HEAD; fall through to the current branch.
  }
  try {
    const result = await git.run(["branch", "--show-current"], sourcePath);
    const current = result.stdout.trim();
    if (current.length > 0) return current;
  } catch {
    return null;
  }
  return null;
}

export async function currentBranch(git: GitPort, cwd: string): Promise<string | null> {
  try {
    const result = await git.run(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const branch = result.stdout.trim();
    return branch.length > 0 && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

export async function statusPorcelain(git: GitPort, cwd: string): Promise<string[]> {
  const result = await git.run(["status", "--porcelain=v1", "--untracked-files=all"], cwd);
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

export async function upstreamRef(git: GitPort, cwd: string): Promise<string | null> {
  try {
    const result = await git.run(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      cwd,
    );
    const upstream = result.stdout.trim();
    return upstream.length > 0 ? upstream : null;
  } catch {
    return null;
  }
}

export async function diffShortStat(git: GitPort, cwd: string): Promise<string | null> {
  try {
    const result = await git.run(["diff", "--shortstat"], cwd);
    const stat = result.stdout.trim();
    return stat.length > 0 ? stat.slice(0, 200) : null;
  } catch {
    return null;
  }
}

export async function aheadBehind(
  git: GitPort,
  cwd: string,
): Promise<{ ahead: number; behind: number } | null> {
  try {
    const result = await git.run(["rev-list", "--left-right", "--count", "HEAD...@{u}"], cwd);
    const parts = result.stdout.trim().split(/\s+/);
    const ahead = Number(parts[0]);
    const behind = Number(parts[1]);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return null;
    return { ahead, behind };
  } catch {
    return null;
  }
}
