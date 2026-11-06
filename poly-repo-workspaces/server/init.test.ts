import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@getpaseo/plugin/server", () => ({
  spawnProcess: spawn,
  terminateProcess: async () => {},
}));

import { createInitRunner } from "./init";

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform === "win32")("init runner shutdown", () => {
  it("kills a script that ignores SIGTERM before stop resolves", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "poly-init-test-"));
    const runner = createInitRunner();
    vi.stubEnv("SHELL", "/bin/sh");
    const running = runner.run("trap '' TERM; echo $$ > ready; exec sleep 60", cwd);
    const outcome = running.catch((error: unknown) => error);
    let pid = 0;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          pid = Number(await readFile(join(cwd, "ready"), "utf8"));
          break;
        } catch {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(pid).toBeGreaterThan(0);
      await runner.stop();
      expect(((await outcome) as Error).message).toContain("SIGKILL");
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await runner.stop();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
