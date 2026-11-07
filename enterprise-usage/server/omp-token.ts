import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// OMP owns OAuth refresh and coordinates it with other OMP processes.
export async function ompToken(provider: "anthropic" | "openai-codex"): Promise<string> {
  const { stdout } = await execFileAsync("omp", ["token", provider, "--account", "1"], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const token = stdout.trim();
  if (!token) throw new Error("OMP returned an empty credential");
  return token;
}
