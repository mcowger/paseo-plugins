import { randomUUID } from "node:crypto";
import type { ReviewMode, ReviewResult } from "../shared/contracts.js";
import type { KillableChild, NormalizedReview } from "./ocr.js";

export type { KillableChild };

export interface StartJobInput {
  workspaceId: string;
  cwd: string;
  mode: ReviewMode;
  targetRef?: string;
  baseRef?: string;
}

export interface RunReviewArgs {
  cwd: string;
  mode: ReviewMode;
  targetRef?: string;
  baseRef?: string;
  onChild: (child: KillableChild) => void;
}

export interface RunReviewDeps {
  runReview: (args: RunReviewArgs) => Promise<NormalizedReview>;
}

interface StoredJob {
  review: ReviewResult;
  child?: KillableChild;
  cancelRequested: boolean;
}

const jobs = new Map<string, StoredJob>();

function jobKey(workspaceId: string, jobId: string): string {
  return `${workspaceId}:${jobId}`;
}

function newJobId(): string {
  try {
    return randomUUID();
  } catch {
    return `job-${Date.now()}-${Math.floor(Math.random() * 1000000000)}`;
  }
}

function hasRunningJob(workspaceId: string): boolean {
  for (const stored of jobs.values()) {
    if (stored.review.workspaceId === workspaceId && stored.review.status === "running") {
      return true;
    }
  }
  return false;
}

export function startJob(input: StartJobInput, deps: RunReviewDeps): { jobId: string; workspaceId: string } {
  if (hasRunningJob(input.workspaceId)) {
    throw new Error(`A review is already running for workspace ${input.workspaceId}`);
  }
  const jobId = newJobId();
  const startedAt = new Date().toISOString();
  const stored: StoredJob = {
    review: {
      jobId,
      workspaceId: input.workspaceId,
      status: "running",
      mode: input.mode,
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      ...(input.targetRef ? { targetRef: input.targetRef } : {}),
      startedAt,
      findings: [],
      warnings: [],
      counts: {},
    },
    cancelRequested: false,
  };
  jobs.set(jobKey(input.workspaceId, jobId), stored);
  void runInBackground(stored, input, deps);
  return { jobId, workspaceId: input.workspaceId };
}

async function runInBackground(
  stored: StoredJob,
  input: StartJobInput,
  deps: RunReviewDeps,
): Promise<void> {
  const startedMs = Date.now();
  try {
    const outcome = await deps.runReview({
      cwd: input.cwd,
      mode: input.mode,
      ...(input.targetRef ? { targetRef: input.targetRef } : {}),
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      onChild: (child) => {
        stored.child = child;
        if (stored.cancelRequested) {
          try {
            child.kill("SIGTERM");
          } catch {
            // Kill failures are non-fatal; status is already canceled.
          }
        }
      },
    });
    if (stored.cancelRequested) return;
    stored.review.status = outcome.status;
    if (outcome.sessionId) stored.review.sessionId = outcome.sessionId;
    stored.review.findings = outcome.findings;
    stored.review.warnings = outcome.warnings;
    stored.review.counts = outcome.counts;
    if (outcome.message) stored.review.message = outcome.message;
    stored.review.finishedAt = new Date().toISOString();
    stored.review.elapsedMs = Date.now() - startedMs;
  } catch (error) {
    if (stored.cancelRequested) return;
    stored.review.status = "error";
    stored.review.message = error instanceof Error ? error.message : "Review failed";
    stored.review.finishedAt = new Date().toISOString();
    stored.review.elapsedMs = Date.now() - startedMs;
  } finally {
    stored.child = undefined;
  }
}

export function getJob(workspaceId: string, jobId: string): ReviewResult | null {
  const stored = jobs.get(jobKey(workspaceId, jobId));
  if (!stored) return null;
  return { ...stored.review };
}

export function cancelJob(workspaceId: string, jobId: string): boolean {
  const stored = jobs.get(jobKey(workspaceId, jobId));
  if (!stored || stored.review.status !== "running") return false;
  stored.cancelRequested = true;
  const child = stored.child;
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore kill failures; escalation below still runs.
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill failures during forced termination.
      }
    }, 2000);
    if (typeof timer.unref === "function") timer.unref();
  }
  stored.review.status = "canceled";
  stored.review.message = "Review was canceled";
  stored.review.finishedAt = new Date().toISOString();
  return true;
}

export function cleanupAll(): void {
  for (const stored of jobs.values()) {
    if (stored.review.status === "running") {
      stored.cancelRequested = true;
      try {
        stored.child?.kill("SIGTERM");
      } catch {
        // Ignore kill failures during unload cleanup.
      }
      stored.review.status = "canceled";
      stored.review.finishedAt = new Date().toISOString();
    }
  }
  jobs.clear();
}

export function __clearJobsForTests(): void {
  jobs.clear();
}
