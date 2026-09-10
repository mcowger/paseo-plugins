export type GithubToolKind =
  | "actions-get"
  | "actions-list"
  | "actions-run"
  | "file"
  | "job-logs"
  | "pull-request"
  | "search-code"
  | "search-repositories";

type JsonRecord = Record<string, unknown>;

const GITHUB_TOOL_LABELS: Readonly<Record<GithubToolKind, string>> = {
  "actions-get": "GitHub Actions Details",
  "actions-list": "GitHub Actions List",
  "actions-run": "GitHub Actions Run",
  file: "GitHub File",
  "job-logs": "GitHub Job Logs",
  "pull-request": "GitHub Pull Request",
  "search-code": "GitHub Code Search",
  "search-repositories": "GitHub Repository Search",
};

const GITHUB_TOOL_ICONS: Readonly<Record<GithubToolKind, string>> = {
  "actions-get": "Workflow",
  "actions-list": "ListChecks",
  "actions-run": "PlayCircle",
  file: "FileCode2",
  "job-logs": "ScrollText",
  "pull-request": "GitPullRequest",
  "search-code": "Code2",
  "search-repositories": "BookMarked",
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function fieldString(record: JsonRecord | null, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(record?.[key]);
    if (value) return value;
  }
  return undefined;
}

function toolLeaf(name: string): string {
  return name.trim().toLowerCase().split(/__|[.:/]/).at(-1) ?? "";
}

export function githubToolKind(name: string): GithubToolKind | null {
  const normalized = name.trim().toLowerCase();
  const leaf = toolLeaf(normalized);
  if (leaf === "github_actions_get" || leaf === "actions_get") return "actions-get";
  if (leaf === "github_actions_list" || leaf === "actions_list") return "actions-list";
  if (leaf === "github_actions_run_trigger" || leaf === "actions_run_trigger") {
    return "actions-run";
  }
  if (leaf === "github_get_file_contents" || leaf === "get_file_contents") return "file";
  if (leaf === "github_get_job_logs" || leaf === "get_job_logs") return "job-logs";
  if (leaf === "github_pull_request_read" || leaf === "pull_request_read") {
    return "pull-request";
  }
  if (leaf === "github_search_code" || leaf === "search_code") return "search-code";
  if (leaf === "github_search_repositories" || leaf === "search_repositories") {
    return "search-repositories";
  }
  return null;
}

export function githubToolLabel(kind: GithubToolKind): string {
  return GITHUB_TOOL_LABELS[kind];
}

export function githubToolIcon(kind: GithubToolKind): string {
  return GITHUB_TOOL_ICONS[kind];
}

function compactText(value: string, maxLength = 180): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

export function githubToolSummary(kind: GithubToolKind, input: unknown): string | undefined {
  const record = asRecord(input);
  switch (kind) {
    case "search-repositories":
    case "search-code":
      return compactText(fieldString(record, "query") ?? "");
    case "file":
      return fieldString(record, "path");
    case "pull-request": {
      const owner = fieldString(record, "owner");
      const repo = fieldString(record, "repo");
      const pullNumber = record?.pullNumber;
      if (owner && repo && (typeof pullNumber === "number" || typeof pullNumber === "string")) {
        return `${owner}/${repo}#${pullNumber}`;
      }
      return owner && repo ? `${owner}/${repo}` : undefined;
    }
    case "actions-get":
    case "actions-list":
    case "actions-run":
    case "job-logs":
      return (
        fieldString(record, "workflowId", "workflow_id", "workflow", "resource_id") ??
        fieldString(record, "runId", "run_id") ??
        fieldString(record, "jobId", "job_id")
      );
  }
}

function parseEmbeddedJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    for (const match of value.matchAll(/\{|\[/g)) {
      const offset = match.index;
      if (offset === undefined) continue;
      try {
        return JSON.parse(value.slice(offset)) as unknown;
      } catch {
        continue;
      }
    }
    return undefined;
  }
}

export function githubOutputText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  if (record.structuredContent !== undefined) {
    return githubOutputText(record.structuredContent);
  }
  if (typeof record.text === "string") return record.text.trim() || undefined;
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((part) => (asRecord(part)?.text as string | undefined))
      .filter((part): part is string => Boolean(part))
      .join("\n\n")
      .trim();
    return text || undefined;
  }
  return undefined;
}

export function githubOutputValue(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) {
    if (typeof value === "string") return parseEmbeddedJson(value) ?? value;
    return value;
  }
  if (record.structuredContent !== undefined) return githubOutputValue(record.structuredContent);
  if (Array.isArray(record.content)) {
    const text = githubOutputText(record);
    if (text) return parseEmbeddedJson(text) ?? text;
  }
  return value;
}
