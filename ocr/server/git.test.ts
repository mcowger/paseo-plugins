import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getCurrentBranch,
  getGitRoot,
  listLocalAndRemoteBranches,
  runGit,
  validateBranchRefs,
} from "./git.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocr-git-test-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "file.txt"), "hello\n");
  git(dir, ["add", "file.txt"]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

describe("git adapter", () => {
  it("resolves root, current branch, and branch list", () => {
    const dir = initRepo();
    git(dir, ["checkout", "-b", "feature"]);

    expect(getGitRoot(dir)).toBe(dir);
    expect(getCurrentBranch(dir)).toBe("feature");

    const branches = listLocalAndRemoteBranches(dir);
    const names = branches.map((branch) => branch.name);
    expect(names).toContain("main");
    expect(names).toContain("feature");
    const feature = branches.find((branch) => branch.name === "feature");
    expect(feature?.isRemote).toBe(false);
    expect(feature?.isCurrent).toBe(true);
  });

  it("returns null branch when detached", () => {
    const dir = initRepo();
    git(dir, ["checkout", "--detach", "HEAD"]);
    expect(getCurrentBranch(dir)).toBeNull();
  });

  it("validates branch refs and detects identical heads", () => {
    const dir = initRepo();
    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(join(dir, "file.txt"), "changed\n");
    git(dir, ["commit", "-am", "change"]);

    const validated = validateBranchRefs(dir, "feature", "main");
    expect(validated.targetSha).toMatch(/^[0-9a-f]{40}$/);
    expect(validated.mergeBase).toMatch(/^[0-9a-f]{40}$/);

    expect(() => validateBranchRefs(dir, "-feature", "main")).toThrow(/must not start/);
    expect(() => validateBranchRefs(dir, "does-not-exist", "main")).toThrow(/Unknown target/);
    expect(() => validateBranchRefs(dir, "feature", "does-not-exist")).toThrow(/Unknown base/);
    expect(() => validateBranchRefs(dir, "main", "main")).toThrow(/same commit/);
  });

  it("rejects refs without a merge-base", () => {
    const dir = initRepo();
    git(dir, ["checkout", "--orphan", "orphan"]);
    execFileSync("git", ["rm", "-rf", "."], { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "other.txt"), "other\n");
    git(dir, ["add", "other.txt"]);
    git(dir, ["commit", "-m", "orphan commit"]);
    expect(() => validateBranchRefs(dir, "main", "orphan")).toThrow(/merge-base/);
  });

  it("uses fixed argument arrays without shell interpolation", () => {
    const dir = initRepo();
    const result = runGit(dir, ["rev-parse", "--verify", "--end-of-options", "main^{commit}"]);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });
});
