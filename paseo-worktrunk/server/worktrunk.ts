import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { PluginLifecycleRegistration } from "@getpaseo/plugin/server";

type Run = (args: string[], signal: AbortSignal, timeout: number) => Promise<string>;

export const runWt: Run = (args, signal, timeout) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "wt",
      args,
      { timeout, signal, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
    // Never allow an unattended daemon to answer Worktrunk approval prompts.
    child.stdin?.end();
  });

function missingWt(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function rememberPendingCreation(pending: Map<string, number>, path: string) {
  const now = performance.now();
  for (const [pendingPath, startedAt] of pending) {
    if (now - startedAt > 10 * 60_000) pending.delete(pendingPath);
  }
  if (pending.size >= 100 && !pending.has(path)) {
    const oldestPath = pending.keys().next().value;
    if (oldestPath !== undefined) pending.delete(oldestPath);
  }
  pending.set(path, now);
}

function logTiming(stage: string, startedAt: number, outcome: string) {
  console.info(
    `paseo-worktrunk: timing stage=${stage} durationMs=${Math.max(0, Math.round(performance.now() - startedAt))} outcome=${outcome}`,
  );
}

function warn(action: "path calculation" | "pre-start" | "post-start", error: unknown) {
  const reason = missingWt(error) ? "wt was not found on the daemon PATH" : `${action} failed`;
  const consequence =
    action === "path calculation"
      ? "using Paseo's default worktree path"
      : `${action} setup did not complete; check Worktrunk approvals and hook logs`;
  // Hook output can contain secrets: don't include subprocess output or command text.
  console.warn(`paseo-worktrunk: ${reason}; ${consequence}`);
}

async function usablePath(candidate: string, repoRoot: string): Promise<boolean> {
  if (!isAbsolute(candidate) || candidate.includes("\0")) return false;
  const raw = resolve(candidate);
  if (raw.split(sep).some((part) => part.toLowerCase() === ".git")) return false;
  const tail: string[] = [];
  let parent = raw;
  while (true) {
    try {
      await lstat(parent);
      break;
    } catch (error) {
      if (!missingWt(error)) throw error;
      tail.unshift(basename(parent));
      const next = dirname(parent);
      if (next === parent) return false;
      parent = next;
    }
  }
  if (tail.length === 0) return false;
  const target = join(await realpath(parent), ...tail);
  const repo = await realpath(repoRoot);
  const home = await realpath(homedir());
  const fromTarget = relative(target, repo);
  return (
    target !== parse(target).root &&
    target !== home &&
    target !== repo &&
    !target.split(sep).some((part) => part.toLowerCase() === ".git") &&
    (fromTarget.startsWith(`..${sep}`) || fromTarget === ".." || isAbsolute(fromTarget))
  );
}

export function createWorktrunkHooks(
  server: Pick<PluginLifecycleRegistration, "addHook">,
  run: Run = runWt,
): () => void {
  const pendingCreations = new Map<string, number>();
  let removeBefore: (() => void) | undefined;
  try {
    removeBefore = server.addHook("worktree.create.before", async ({ request }, { signal }) => {
      const startedAt = performance.now();
      let selectedPath = request.path;
      let outcome = "fallback";
      try {
        // Pass the branch as a JSON string literal inside the template, never via a shell.
        const template = `{{ expected_worktree_path_of_branch(${JSON.stringify(request.branch)}) }}`;
        const output = await run(
          ["-C", request.sourceCheckout, "step", "eval", "--format", "json", template],
          signal,
          10_000,
        );
        const result: unknown = JSON.parse(output);
        if (
          typeof result !== "object" ||
          result === null ||
          !("result" in result) ||
          typeof result.result !== "string" ||
          !isAbsolute(result.result) ||
          result.result.includes("\0")
        ) {
          throw new Error("invalid Worktrunk path");
        }
        if (!(await usablePath(result.result, request.repoRoot))) {
          throw new Error("unusable Worktrunk destination");
        }
        selectedPath = result.result;
        outcome = "placed";
        return { ...request, path: result.result };
      } catch (error) {
        warn("path calculation", error);
        return undefined;
      } finally {
        logTiming("path-calculation", startedAt, outcome);
        rememberPendingCreation(pendingCreations, selectedPath);
      }
    });
    const removeAfter = server.addHook(
      "worktree.create.after",
      async ({ worktree }, { signal }) => {
        const creationStartedAt = pendingCreations.get(worktree.path);
        if (creationStartedAt !== undefined) {
          pendingCreations.delete(worktree.path);
          logTiming("worktree-core", creationStartedAt, "completed");
        }
        for (const [hook, timeout] of [
          ["pre-start", 15_000],
          ["post-start", 8_000],
        ] as const) {
          const startedAt = performance.now();
          let outcome = "completed";
          try {
            await run(["-C", worktree.path, "hook", hook], signal, timeout);
          } catch (error) {
            outcome = "failed";
            warn(hook, error);
            break;
          } finally {
            logTiming(hook, startedAt, outcome);
          }
        }
      },
    );
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      removeAfter();
      removeBefore?.();
    };
  } catch {
    removeBefore?.();
    console.warn("paseo-worktrunk: host does not support worktree lifecycle hooks");
    return () => {};
  }
}
