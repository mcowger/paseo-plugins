import { describe, expect, it, vi } from "vitest";
import { createArchiveJobManager } from "./archive-jobs";
import type { ArchiveResult } from "./service";

const completed: ArchiveResult = { ok: true, error: null, blocked: [] };

describe("archive job manager", () => {
  it("returns running before work completes and coalesces same virtual workspace", async () => {
    const manager = createArchiveJobManager();
    let finish: (result: ArchiveResult) => void = () => {};
    const promise = new Promise<ArchiveResult>((resolve) => {
      finish = resolve;
    });
    const work = vi.fn(() => promise);
    const first = manager.start("virtual", work);
    expect(manager.hasRunning()).toBe(true);
    expect(manager.start("virtual", work)).toBe(first);
    expect(manager.get(first)).toEqual({ state: "running" });
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(1);
    finish(completed);
    await vi.waitFor(() => expect(manager.get(first).state).toBe("finished"));
    expect(manager.hasRunning()).toBe(false);
    expect(manager.get(first)).toEqual({ state: "finished", result: completed });
    manager.dispose();
  });

  it("preserves blocked results and converts thrown errors", async () => {
    const manager = createArchiveJobManager();
    const blocked: ArchiveResult = {
      ok: false,
      error: null,
      blocked: [
        {
          repoId: "repo",
          worktreePath: "/repo",
          branch: "main",
          dirty: true,
          dirtyFileCount: 1,
          diffStat: null,
          ahead: 0,
          behind: 0,
          upstreamRef: null,
          error: null,
        },
      ],
    };
    const blockedId = manager.start("blocked", async () => blocked);
    await vi.waitFor(() => expect(manager.get(blockedId).state).toBe("finished"));
    expect(manager.get(blockedId)).toEqual({ state: "finished", result: blocked });
    const errorId = manager.start("error", async () => {
      throw new Error("archive failed");
    });
    await vi.waitFor(() => expect(manager.get(errorId).state).toBe("finished"));
    expect(manager.get(errorId)).toEqual({
      state: "finished",
      result: { ok: false, error: "archive failed", blocked: [] },
    });
    manager.dispose();
  });
});
