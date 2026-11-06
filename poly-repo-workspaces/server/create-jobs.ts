import type { CreateResult } from "./service";

export type CreateJob =
  | { state: "running" }
  | { state: "finished"; result: CreateResult }
  | { state: "missing" };

interface Job {
  key: string;
  result?: CreateResult;
  expiresAt?: number;
  completion?: Promise<void>;
}

const RETENTION_MS = 30 * 60 * 1000;

export function createJobManager() {
  const jobs = new Map<string, Job>();
  const activeByKey = new Map<string, string>();

  function evictExpired(now: number): void {
    for (const [jobId, job] of jobs) {
      if (job.expiresAt !== undefined && job.expiresAt <= now) jobs.delete(jobId);
    }
  }

  return {
    start(key: string, work: () => Promise<CreateResult>): string {
      evictExpired(Date.now());
      const activeId = activeByKey.get(key);
      if (activeId !== undefined) return activeId;

      const jobId = crypto.randomUUID();
      const job: Job = { key };
      jobs.set(jobId, job);
      activeByKey.set(key, jobId);
      job.completion = Promise.resolve()
        .then(work)
        .catch(
          (error: unknown): CreateResult => ({
            ok: false,
            virtualId: null,
            workspaceId: null,
            error: error instanceof Error ? error.message : String(error),
            preflight: [],
          }),
        )
        .then((result) => {
          job.result = result;
          job.expiresAt = Date.now() + RETENTION_MS;
          if (activeByKey.get(key) === jobId) activeByKey.delete(key);
        });
      return jobId;
    },

    hasRunning(key?: string): boolean {
      if (key !== undefined) return activeByKey.has(key);
      return activeByKey.size > 0;
    },
    async whenIdle(): Promise<void> {
      await Promise.all([...activeByKey.values()].map((id) => jobs.get(id)?.completion));
    },
    get(jobId: string): CreateJob {
      evictExpired(Date.now());
      const job = jobs.get(jobId);
      if (!job) return { state: "missing" };
      return job.result === undefined
        ? { state: "running" }
        : { state: "finished", result: job.result };
    },

    dispose(): void {
      jobs.clear();
      activeByKey.clear();
    },
  };
}
