import type { RepoStatus } from "../shared/rpc";

export interface FsPort {
  readFile(path: string): Promise<string | null>;
  writeFileAtomic(path: string, content: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  readdir(path: string): Promise<string[] | null>;
  exists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
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

export interface HostWorkspaceRef {
  id: string;
  cwd: string;
  projectId: string | null;
  /** Resolved display name: the title when one is set, else the derived name. */
  name: string | null;
}

export interface CreateDirectoryWorkspaceInput {
  path: string;
  title: string;
  /**
   * Host project that owns the new workspace. The virtual root's project makes
   * the constituent repos render as one collapsible sidebar section.
   */
  projectId?: string;
}

export interface CreateDirectoryWorkspaceResult {
  workspaceId: string;
  /** Project the host attached the workspace to; null when it reported none. */
  projectId: string | null;
}

export interface HostProjectRef {
  id: string;
  rootPath: string;
}

export interface WorkspacesPort {
  createDirectoryWorkspace(
    input: CreateDirectoryWorkspaceInput,
  ): Promise<CreateDirectoryWorkspaceResult>;
  archiveWorkspace(workspaceId: string): Promise<void>;
  renameWorkspace(workspaceId: string, title: string): Promise<void>;
  listWorkspaces(): Promise<HostWorkspaceRef[]>;
  listProjects(): Promise<HostProjectRef[]>;
  deleteProject(projectId: string, paseoHome: string): Promise<void>;
  createTerminal(workspaceId: string, input: { cwd?: string; name?: string }): Promise<void>;
}

export interface WorkspaceArchivedEvent {
  id: string;
  cwd: string;
}

export type { RepoStatus };
