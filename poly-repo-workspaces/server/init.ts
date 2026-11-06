import type { ChildProcess } from "node:child_process";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";

const SHUTDOWN_GRACE_MS = 1_000;

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function stopUnixGroup(child: ChildProcess, pid: number): Promise<void> {
  if (!signalGroup(pid, "SIGTERM")) return;
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (Date.now() < deadline) {
    if (!signalGroup(pid, 0)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  signalGroup(pid, "SIGKILL");
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
  }
}

/** Runs setup without a terminal; scripts must not require interactive input. */
export function createInitRunner() {
  const children = new Set<ChildProcess>();
  let stopped = false;
  return {
    async run(script: string, cwd: string): Promise<void> {
      if (stopped) throw new Error("plugin is shutting down");
      const windows = process.platform === "win32";
      const shell = windows ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh";
      const args = windows ? ["/d", "/s", "/c", script] : ["-lc", script];
      await new Promise<void>((resolve, reject) => {
        const child = spawnProcess(shell, args, { cwd, stdio: "ignore", detached: !windows });
        children.add(child);
        child.once("error", () => {
          children.delete(child);
          reject(new Error("could not start the user's shell"));
        });
        child.once("exit", (code, signal) => {
          children.delete(child);
          if (code === 0) resolve();
          else reject(new Error(signal ? `terminated by ${signal}` : `exited with code ${code}`));
        });
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      await Promise.all(
        [...children].map(async (child) => {
          if (process.platform !== "win32" && child.pid) {
            await stopUnixGroup(child, child.pid);
            return;
          }
          await terminateProcess(child);
        }),
      );
    },
  };
}
