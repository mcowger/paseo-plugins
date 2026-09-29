import { spawnSync } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";

export interface ResolvedWorkspace {
  directory: string;
  name: string | null;
}

export async function resolveWorkspaceDirectory(
  paseo: PaseoApi,
  workspaceId: string,
): Promise<ResolvedWorkspace> {
  const ref = paseo.workspaces.ref(workspaceId);
  const snapshot = await ref.refresh();
  const directory = snapshot?.workspaceDirectory ?? ref.directory;
  if (!directory) {
    throw new Error(`Workspace ${workspaceId} is not active or has no directory`);
  }
  const name = snapshot?.name ?? ref.name ?? null;
  return { directory, name };
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

function truncateOutput(value: string): string {
  return value.length > MAX_GIT_OUTPUT_BYTES ? value.slice(0, MAX_GIT_OUTPUT_BYTES) : value;
}

export function runGit(cwd: string, args: string[], timeoutMs = 10000): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES * 2,
    shell: false,
  });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const stdout = truncateOutput(typeof result.stdout === "string" ? result.stdout : "");
  const stderr = truncateOutput(typeof result.stderr === "string" ? result.stderr : "");
  return {
    stdout,
    stderr,
    exitCode: result.status ?? 1,
    timedOut: errorCode === "ETIMEDOUT",
  };
}

export function getGitRoot(cwd: string): string | null {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) return null;
  const root = result.stdout.trim();
  return root ? root : null;
}

export function getCurrentBranch(cwd: string): string | null {
  const result = runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (result.exitCode !== 0) return null;
  const branch = result.stdout.trim();
  return branch ? branch : null;
}

export interface BranchRef {
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
}

export function listLocalAndRemoteBranches(cwd: string): BranchRef[] {
  const result = runGit(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to list branches: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  const current = getCurrentBranch(cwd);
  const branches: BranchRef[] = [];
  for (const line of result.stdout.split("\n")) {
    const refname = line.trim();
    if (!refname) continue;
    if (refname.startsWith("refs/heads/")) {
      const name = refname.slice("refs/heads/".length);
      if (!name || name.includes("..")) continue;
      branches.push({ name, isRemote: false, isCurrent: name === current });
    } else if (refname.startsWith("refs/remotes/")) {
      const name = refname.slice("refs/remotes/".length);
      if (!name || name.endsWith("/HEAD") || name.includes("..")) continue;
      branches.push({ name, isRemote: true, isCurrent: false });
    }
  }
  return branches;
}

export interface ValidatedBranchRefs {
  targetSha: string;
  baseSha: string;
  mergeBase: string;
}

function assertRefValue(ref: string, role: string): void {
  if (!ref || !ref.trim()) {
    throw new Error(`Missing ${role} branch ref`);
  }
  if (ref.startsWith("-")) {
    throw new Error(`Invalid ${role} branch ref "${ref}": must not start with '-'`);
  }
}

function resolveRefSha(cwd: string, ref: string, role: string): string {
  const result = runGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (result.exitCode !== 0) {
    throw new Error(`Unknown ${role} branch ref "${ref}"`);
  }
  const sha = result.stdout.trim();
  if (!sha) {
    throw new Error(`Unknown ${role} branch ref "${ref}"`);
  }
  return sha;
}

export function validateBranchRefs(cwd: string, target: string, base: string): ValidatedBranchRefs {
  assertRefValue(target, "target");
  assertRefValue(base, "base");
  const targetSha = resolveRefSha(cwd, target, "target");
  const baseSha = resolveRefSha(cwd, base, "base");
  if (targetSha === baseSha) {
    throw new Error("Target and base refs resolve to the same commit");
  }
  const mergeBase = runGit(cwd, ["merge-base", "--end-of-options", target, base]);
  if (mergeBase.exitCode !== 0) {
    throw new Error(`No merge-base between "${target}" and "${base}"`);
  }
  const sha = mergeBase.stdout.trim();
  if (!sha) {
    throw new Error(`No merge-base between "${target}" and "${base}"`);
  }
  return { targetSha, baseSha, mergeBase: sha };
}
