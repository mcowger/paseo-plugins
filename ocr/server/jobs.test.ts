import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearJobsForTests,
  cancelJob,
  cleanupAll,
  getJob,
  startJob,
  type KillableChild,
} from "./jobs.js";
import type { NormalizedReview } from "./ocr.js";

function completeOutcome(): NormalizedReview {
  return { status: "complete", sessionId: "s-1", findings: [], warnings: [], counts: {} };
}

function fakeChild(): KillableChild & { killed: string[] } {
  const killed: string[] = [];
  return {
    killed,
    kill: (signal?: NodeJS.Signals) => {
      killed.push(signal ?? "SIGTERM");
      return true;
    },
  };
}

beforeEach(() => {
  __clearJobsForTests();
});

describe("jobs", () => {
  it("runs a review to completion and exposes it via getJob", async () => {
    const { jobId, workspaceId } = startJob(
      { workspaceId: "ws-1", cwd: "/tmp", mode: "uncommitted" },
      { runReview: () => Promise.resolve(completeOutcome()) },
    );
    expect(getJob(workspaceId, jobId)?.status).toBe("running");
    await vi.waitFor(() => {
      expect(getJob(workspaceId, jobId)?.status).toBe("complete");
    });
    expect(getJob(workspaceId, jobId)?.sessionId).toBe("s-1");
  });

  it("rejects a second concurrent job for the same workspace", () => {
    let release!: (value: NormalizedReview) => void;
    const pending = new Promise<NormalizedReview>((resolve) => {
      release = resolve;
    });
    startJob({ workspaceId: "ws-1", cwd: "/tmp", mode: "uncommitted" }, { runReview: () => pending });
    expect(() =>
      startJob(
        { workspaceId: "ws-1", cwd: "/tmp", mode: "uncommitted" },
        { runReview: () => Promise.resolve(completeOutcome()) },
      ),
    ).toThrow(/already running/);
    release(completeOutcome());
  });

  it("maps run failures to error status", async () => {
    const { jobId, workspaceId } = startJob(
      { workspaceId: "ws-1", cwd: "/tmp", mode: "uncommitted" },
      { runReview: () => Promise.reject(new Error("boom")) },
    );
    await vi.waitFor(() => {
      expect(getJob(workspaceId, jobId)?.status).toBe("error");
    });
    expect(getJob(workspaceId, jobId)?.message).toBe("boom");
  });

  it("cancels a running job and kills the child with SIGTERM then SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      let release!: (value: NormalizedReview) => void;
      const pending = new Promise<NormalizedReview>((resolve) => {
        release = resolve;
      });
      const { jobId, workspaceId } = startJob(
        { workspaceId: "ws-1", cwd: "/tmp", mode: "uncommitted" },
        {
          runReview: (args) => {
            args.onChild(child);
            return pending;
          },
        },
      );
      // Let the background task register the child handle.
      await Promise.resolve();
      await Promise.resolve();
      expect(cancelJob(workspaceId, jobId)).toBe(true);
      expect(child.killed).toEqual(["SIGTERM"]);
      expect(getJob(workspaceId, jobId)?.status).toBe("canceled");
      await vi.advanceTimersByTimeAsync(2000);
      expect(child.killed).toEqual(["SIGTERM", "SIGKILL"]);
      release(completeOutcome());
      await Promise.resolve();
      // A canceled job stays canceled even if the child later resolves.
      expect(getJob(workspaceId, jobId)?.status).toBe("canceled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns false when canceling a finished job", async () => {
    const { jobId, workspaceId } = startJob(
      { workspaceId: "ws-1", cwd: "/tmp", mode: "uncommitted" },
      { runReview: () => Promise.resolve(completeOutcome()) },
    );
    await vi.waitFor(() => {
      expect(getJob(workspaceId, jobId)?.status).toBe("complete");
    });
    expect(cancelJob(workspaceId, jobId)).toBe(false);
  });

  it("cleanupAll kills running jobs", async () => {
    const child = fakeChild();
    let release!: (value: NormalizedReview) => void;
    const pending = new Promise<NormalizedReview>((resolve) => {
      release = resolve;
    });
    const first = startJob(
      { workspaceId: "ws-1", cwd: "/tmp", mode: "uncommitted" },
      {
        runReview: (args) => {
          args.onChild(child);
          return pending;
        },
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    cleanupAll();
    expect(child.killed).toEqual(["SIGTERM"]);
    expect(getJob(first.workspaceId, first.jobId)).toBeNull();
    release(completeOutcome());
  });
});
