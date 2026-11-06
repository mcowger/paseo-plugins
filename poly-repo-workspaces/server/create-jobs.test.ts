import { describe, expect, it, vi } from "vitest";
import { createJobManager } from "./create-jobs";
import type { CreateResult } from "./service";

const success: CreateResult = {
  ok: true,
  virtualId: "virtual",
  workspaceId: "workspace",
  error: null,
  preflight: [],
};

describe("create job manager", () => {
  it("returns immediately and coalesces concurrent work with the same key", async () => {
    const manager = createJobManager();
    let finish: (value: CreateResult) => void = () => {};
    const promise = new Promise<CreateResult>((resolve) => {
      finish = resolve;
    });
    const work = vi.fn(() => promise);
    const first = manager.start("same", work);
    const second = manager.start("same", work);
    expect(second).toBe(first);
    expect(work).not.toHaveBeenCalled();
    expect(manager.get(first)).toEqual({ state: "running" });
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(1);
    finish(success);
    await vi.waitFor(() => expect(manager.get(first).state).toBe("finished"));
    expect(manager.get(first)).toEqual({ state: "finished", result: success });
    manager.dispose();
  });

  it("retains completed jobs and converts thrown failures to results", async () => {
    const manager = createJobManager();
    const id = manager.start("failure", async () => {
      throw new Error("create failed");
    });
    await vi.waitFor(() => expect(manager.get(id).state).toBe("finished"));
    expect(manager.get(id)).toEqual({
      state: "finished",
      result: {
        ok: false,
        virtualId: null,
        workspaceId: null,
        error: "create failed",
        preflight: [],
      },
    });
    manager.dispose();
    expect(manager.get(id)).toEqual({ state: "missing" });
  });
});
