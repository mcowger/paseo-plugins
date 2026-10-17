import type { RepoStatus } from "../shared/rpc";

export interface FsPort {
  readFile(path: string): Promise<string | null>;
  writeFileAtomic(path: string, content: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  readdir(path: string): Promise<string[] | null>;
  exists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  removeRecursive(path: string): Promise<void>;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

export interface GitFailure {
  message: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function isGitFailure(error: unknown): error is GitFailure {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return (
    typeof record.message === "string" && "exitCode" in record && typeof record.stdout === "string"
  );
}

export interface GitPort {
  run(args: string[], cwd: string): Promise<GitRunResult>;
}

export interface WorkspacesPort {
  createDirectoryWorkspace(input: { path: string; title: string }): Promise<string>;
  archiveWorkspace(workspaceId: string): Promise<void>;
  createTerminal(workspaceId: string, input: { cwd?: string; name?: string }): Promise<void>;
}

export interface WorkspaceArchivedEvent {
  id: string;
  cwd: string;
}

export type { RepoStatus };
