import type { ArchiveResult } from "./service";

export type ArchiveJob =
  | { state: "running" }
  | { state: "finished"; result: ArchiveResult }
  | { state: "missing" };

interface Job {
  result?: ArchiveResult;
  expiresAt?: number;
}

const RETENTION_MS = 30 * 60 * 1000;

export function createArchiveJobManager() {
  const jobs = new Map<string, Job>();
  const activeByVirtualId = new Map<string, string>();

  function evictExpired(now: number): void {
    for (const [jobId, job] of jobs) {
      if (job.expiresAt !== undefined && job.expiresAt <= now) jobs.delete(jobId);
    }
  }

  return {
    start(virtualId: string, work: () => Promise<ArchiveResult>): string {
      evictExpired(Date.now());
      const activeId = activeByVirtualId.get(virtualId);
      if (activeId !== undefined) return activeId;

      const jobId = crypto.randomUUID();
      const job: Job = {};
      jobs.set(jobId, job);
      activeByVirtualId.set(virtualId, jobId);
      void Promise.resolve()
        .then(work)
        .catch(
          (error: unknown): ArchiveResult => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            blocked: [],
          }),
        )
        .then((result) => {
          job.result = result;
          job.expiresAt = Date.now() + RETENTION_MS;
          if (activeByVirtualId.get(virtualId) === jobId) activeByVirtualId.delete(virtualId);
        });
      return jobId;
    },

    get(jobId: string): ArchiveJob {
      evictExpired(Date.now());
      const job = jobs.get(jobId);
      if (!job) return { state: "missing" };
      return job.result === undefined
        ? { state: "running" }
        : { state: "finished", result: job.result };
    },

    hasRunning(virtualId?: string): boolean {
      return virtualId === undefined
        ? activeByVirtualId.size > 0
        : activeByVirtualId.has(virtualId);
    },

    dispose(): void {
      jobs.clear();
      activeByVirtualId.clear();
    },
  };
}
