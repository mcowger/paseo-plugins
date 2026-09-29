import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelReviewRpc,
  getReviewRpc,
  listHistoryRpc,
  listRefsRpc,
  loadSessionRpc,
  prepareSelectionRpc,
  searchSelectionsRpc,
  startReviewRpc,
  capabilitiesRpc,
} from "./shared/contracts.js";
import { preferencesSettings, selectionsSettings } from "./shared/settings.js";
import {
  getCurrentBranch,
  getGitRoot,
  listLocalAndRemoteBranches,
  resolveWorkspaceDirectory,
  runGit,
  validateBranchRefs,
} from "./server/git.js";
import { startJob, cancelJob, cleanupAll, getJob } from "./server/jobs.js";
import {
  batchToAttachmentItem,
  buildBatchFromFindings,
  filterBatches,
} from "./server/selections.js";
import {
  checkExecutable,
  listHistory,
  runReviewJson,
  sessionComments,
  showSession,
} from "./server/ocr.js";

function normalizeDir(value: string): string {
  return value.replace(/\/+$/, "");
}

async function resolveWorktree(
  paseo: Parameters<typeof resolveWorkspaceDirectory>[0],
  workspaceId: string,
): Promise<{ directory: string; name: string | null }> {
  return resolveWorkspaceDirectory(paseo, workspaceId);
}

function requireGitRootMatch(directory: string): string {
  const root = getGitRoot(directory);
  if (!root) {
    throw new Error(`Workspace directory ${directory} is not inside a Git repository`);
  }
  if (normalizeDir(root) !== normalizeDir(directory)) {
    throw new Error(
      `Unsupported scope: workspace directory ${directory} does not match repository root ${root}`,
    );
  }
  return root;
}

const DEFAULT_BASE_PREFERENCE = ["main", "origin/main", "master", "origin/master"];

export default function contribute(server: PluginServerContext) {
  server.registerSettings(preferencesSettings);
  const selectionsHandle = server.registerSettings(selectionsSettings);

  server.handle(capabilitiesRpc, async (input, context) => {
    const { directory } = await resolveWorktree(context.paseo, input.workspaceId);
    let gitAvailable = false;
    try {
      gitAvailable = runGit(directory, ["--version"]).exitCode === 0;
    } catch {
      gitAvailable = false;
    }
    const gitRoot = getGitRoot(directory);
    const ocr = checkExecutable();
    return {
      gitAvailable,
      isGitRepo: gitRoot !== null,
      gitRoot,
      ocrAvailable: ocr.available,
      ...(ocr.version ? { ocrVersion: ocr.version } : {}),
      workspaceDirectory: directory,
    };
  });

  server.handle(listRefsRpc, async (input, context) => {
    const { directory } = await resolveWorktree(context.paseo, input.workspaceId);
    const gitRoot = requireGitRootMatch(directory);
    const currentBranch = getCurrentBranch(directory);
    const branches = listLocalAndRemoteBranches(directory);
    const names = new Set(branches.map((branch) => branch.name));
    const defaultBase = DEFAULT_BASE_PREFERENCE.find((name) => names.has(name)) ?? null;
    return {
      gitRoot,
      currentBranch,
      branches,
      defaultTarget: currentBranch,
      defaultBase,
    };
  });

  server.handle(startReviewRpc, async (input, context) => {
    const { directory } = await resolveWorktree(context.paseo, input.workspaceId);
    requireGitRootMatch(directory);
    const ocr = checkExecutable();
    if (!ocr.available) {
      throw new Error("OpenCodeReview executable is not available on the Paseo host");
    }
    if (input.mode === "branch") {
      if (!input.targetRef || !input.baseRef) {
        throw new Error("Branch reviews require targetRef and baseRef");
      }
      validateBranchRefs(directory, input.targetRef, input.baseRef);
    }
    return startJob(
      {
        workspaceId: input.workspaceId,
        cwd: directory,
        mode: input.mode,
        ...(input.targetRef ? { targetRef: input.targetRef } : {}),
        ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      },
      {
        runReview: (args) =>
          runReviewJson({
            cwd: args.cwd,
            mode: args.mode,
            ...(args.targetRef ? { targetRef: args.targetRef } : {}),
            ...(args.baseRef ? { baseRef: args.baseRef } : {}),
            onChild: args.onChild,
          }),
      },
    );
  });

  server.handle(getReviewRpc, async (input) => {
    const review = getJob(input.workspaceId, input.jobId);
    if (!review) {
      throw new Error(`Review job ${input.jobId} was not found`);
    }
    return { review };
  });

  server.handle(cancelReviewRpc, async (input) => {
    return { canceled: cancelJob(input.workspaceId, input.jobId) };
  });

  server.handle(listHistoryRpc, async (input, context) => {
    const { directory } = await resolveWorktree(context.paseo, input.workspaceId);
    const sessions = await listHistory(directory, input.limit);
    return { sessions };
  });

  server.handle(loadSessionRpc, async (input, context) => {
    const { directory } = await resolveWorktree(context.paseo, input.workspaceId);
    const summary = await showSession(directory, input.sessionId);
    const findings = await sessionComments(directory, input.sessionId);
    return {
      sessionId: summary.sessionId,
      reviewMode: summary.reviewMode,
      findings,
      summary,
    };
  });

  server.handle(prepareSelectionRpc, async (input, context) => {
    const resolved = await resolveWorktree(context.paseo, input.workspaceId);
    const summary = await showSession(resolved.directory, input.sessionId);
    const findings = await sessionComments(resolved.directory, input.sessionId);
    const requested = new Set(input.findingIds);
    const selected = findings.filter((finding) => requested.has(finding.id));
    if (selected.length !== requested.size) {
      const known = new Set(selected.map((finding) => finding.id));
      const unknown = [...requested].filter((id) => !known.has(id));
      throw new Error(`Unknown finding ids for session ${input.sessionId}: ${unknown.join(", ")}`);
    }
    const rawMode = summary.reviewMode.trim().toLowerCase();
    const mode = rawMode === "range" || rawMode === "branch" ? "branch" : "uncommitted";
    const batch = buildBatchFromFindings({
      workspaceId: input.workspaceId,
      workspaceName: resolved.name ?? input.workspaceId,
      worktreeRoot: resolved.directory,
      session: { sessionId: summary.sessionId },
      findings: selected,
      mode,
      ...(mode === "branch" && summary.diffFrom ? { baseRef: summary.diffFrom } : {}),
      ...(mode === "branch" && (summary.diffTo ?? summary.diffCommit)
        ? { targetRef: (summary.diffTo ?? summary.diffCommit) as string }
        : {}),
    });
    return { batch };
  });

  server.handle(searchSelectionsRpc, async (input) => {
    const state = await selectionsHandle.read();
    if (state.status !== "ready") {
      return { items: [] };
    }
    const matches = filterBatches(state.values.batches, input.query).slice(0, 20);
    return { items: matches.map((batch) => batchToAttachmentItem(batch)) };
  });

  return () => {
    cleanupAll();
  };
}
