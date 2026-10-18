import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";

const AUTH_FILE = "auth.json";

function sourceAgentDirectory(env: NodeJS.ProcessEnv): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (configured)
    return configured.startsWith("~/") ? path.join(homedir(), configured.slice(2)) : configured;
  return path.join(homedir(), ".pi", "agent");
}

/**
 * Per-user runtime dir: XDG_RUNTIME_DIR is 0700 tmpfs cleared at logout. Falls back
 * to a per-user temp dir when it is unset.
 */
function snapshotRoot(env: NodeJS.ProcessEnv): string {
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, "plexuspi");
  return path.join(tmpdir(), `plexuspi-agent-${userInfo().uid}`);
}

/**
 * Builds a Pi agent dir whose auth.json is read without taking Pi's file lock.
 * Pi's startup blocks on the auth lock; a snapshot avoids that wait. Every other
 * file in the real agent dir is symlinked so settings and models stay shared.
 * Returns undefined (use the real dir) when auth.json is missing or unreadable.
 */
export function prepareAuthSnapshot(input: {
  env: NodeJS.ProcessEnv;
  root?: string;
}): string | undefined {
  const source = sourceAgentDirectory(input.env);
  const authPath = path.join(source, AUTH_FILE);
  let content: string;
  try {
    content = readFileSync(authPath, "utf-8");
    JSON.parse(content);
  } catch {
    return undefined;
  }

  const target = path.join(input.root ?? snapshotRoot(input.env), "agent-dir");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const linked = new Set(
    readdirSync(source).filter((entry) => entry !== AUTH_FILE && !entry.endsWith(".lock")),
  );
  for (const entry of readdirSync(target)) {
    if (linked.has(entry) || entry === AUTH_FILE) continue;
    if (isSymlink(path.join(target, entry))) rmSync(path.join(target, entry));
  }
  for (const entry of linked) {
    const link = path.join(target, entry);
    if (existsSync(link) || isSymlink(link)) continue;
    symlinkSync(path.join(source, entry), link);
  }

  const staged = path.join(target, `${AUTH_FILE}.${randomUUID()}.tmp`);
  writeFileSync(staged, content, { mode: 0o600 });
  renameSync(staged, path.join(target, AUTH_FILE));
  return target;
}

function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
