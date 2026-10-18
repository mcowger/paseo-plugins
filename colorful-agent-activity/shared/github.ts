import { toolOutputPayload, toolOutputText } from "./tool-output";

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
  return (
    name
      .trim()
      .toLowerCase()
      .split(/__|[.:/]/)
      .at(-1) ?? ""
  );
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

/**
 * How a search's results are counted: `3 of 146`, or just `3`.
 *
 * GitHub's `total_count` is the size of the match set, not the number of rows it returned.
 * A row only ever holds the page it asked for, so a bare `Total 146` above three rows reads
 * as a bug. Saying how many of how many reads as the preview it is, and needs no extra row.
 */
export function githubResultCount(shown: number, total?: number | null): string {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= shown) {
    return String(shown);
  }
  return `${shown} of ${total}`;
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

export function githubOutputText(value: unknown): string | undefined {
  return toolOutputText(value)?.trim() || undefined;
}

/**
 * The payload behind an MCP result, which arrives in one of two shapes.
 *
 * Paseo's own MCP path sends `{ content, structuredContent }`. A plugin provider cannot:
 * Pi's `ToolResultMessage` has no `structuredContent` field, and Pi folds it into a text
 * block only when the server returned no content blocks — so for us the payload is text
 * (`{ content: string, details }`) that may itself be JSON. Do not add a provider-side
 * field for it; there is nothing to carry.
 */
export function githubOutputValue(value: unknown): unknown {
  const payload = toolOutputPayload(value);
  return payload === undefined ? value : payload;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function shortSha(value: string | undefined, length = 7): string | undefined {
  if (!value) return undefined;
  return value.length > length ? value.slice(0, length) : value;
}

function stringify(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(stringify).filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  return undefined;
}

/** A repository reference, which GitHub sends as a name or as an object. */
export function repositoryLabel(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const record = asRecord(value);
  return (
    fieldString(record, "full_name", "fullName", "name_with_owner") ??
    fieldString(record, "name")
  );
}

// ─── file contents ──────────────────────────────────────────────────────────────

export interface GithubTreeEntry {
  type: "dir" | "file" | "symlink" | "submodule";
  name: string;
  path: string;
  size?: number;
}

export type GithubFileView =
  | { kind: "directory"; entries: GithubTreeEntry[] }
  | { kind: "text"; text: string; sha?: string }
  | { kind: "encoded"; size?: number; sha?: string; url?: string };

/** GitHub's file tool prefixes decoded content with a line about the blob. */
const DOWNLOAD_PREAMBLE = /^successfully downloaded (?:text|binary) file\s*\(SHA:\s*([0-9a-f]{7,40})\)\s*/i;

function treeEntries(value: unknown): GithubTreeEntry[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const entries: GithubTreeEntry[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const name = fieldString(record, "name");
    const path = fieldString(record, "path");
    const type = fieldString(record, "type");
    if (!name || !path) return undefined;
    if (type !== "dir" && type !== "file" && type !== "symlink" && type !== "submodule") {
      return undefined;
    }
    const size = numberValue(record?.size);
    entries.push({
      type,
      name,
      path,
      // A directory reports 0 bytes; the number carries nothing.
      ...(type === "file" && size ? { size } : {}),
    });
  }
  return entries;
}

/**
 * What a file read actually returned: a directory listing, decoded text, or an encoded blob.
 *
 * The tool answers all three through the same call, and two of them are JSON. Handing the
 * text to a generic JSON reader would show a package.json's `name` as though it were the
 * file's own path, so the shape is decided here, once.
 */
export function parseGithubFileResult(value: unknown): GithubFileView | undefined {
  const text = toolOutputText(value);
  if (!text) return undefined;
  let body = text.trim();
  const preamble = body.match(DOWNLOAD_PREAMBLE);
  if (preamble) body = body.slice(preamble[0].length).trim();
  const sha = preamble?.[1];
  if (body.startsWith("[")) {
    try {
      const entries = treeEntries(JSON.parse(body));
      if (entries) return { kind: "directory", entries };
    } catch {}
  }
  if (body.startsWith("{")) {
    try {
      const record = asRecord(JSON.parse(body));
      if (record && fieldString(record, "encoding") === "base64" && record.content !== undefined) {
        return {
          kind: "encoded",
          ...(numberValue(record.size) ? { size: numberValue(record.size) as number } : {}),
          ...(fieldString(record, "sha") ? { sha: fieldString(record, "sha") } : {}),
          ...(fieldString(record, "html_url", "htmlUrl", "url")
            ? { url: fieldString(record, "html_url", "htmlUrl", "url") }
            : {}),
        };
      }
    } catch {}
  }
  return { kind: "text", text: body, ...(sha ? { sha } : {}) };
}

// ─── code search ────────────────────────────────────────────────────────────────

export interface GithubCodeMatch {
  path: string;
  repository?: string;
  url?: string;
  /** One line per matched fragment: the excerpt is code, so it reads as code. */
  fragments: string[];
}

export interface GithubCodeSearchView {
  matches: GithubCodeMatch[];
  total?: number;
}

/** Fragments arrive as multi-line excerpts with their surrounding context. */
function fragmentLines(value: unknown, limit = 2): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const entry of value) {
    const fragment = fieldString(asRecord(entry), "fragment");
    if (!fragment) continue;
    const trimmed = fragment
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
    if (trimmed) lines.push(trimmed);
    if (lines.length >= limit) break;
  }
  return lines;
}

export function parseGithubCodeSearch(value: unknown): GithubCodeSearchView {
  const payload = toolOutputPayload(value);
  const record = asRecord(payload);
  const items = fieldArrayValue(record, "items", "results");
  const matches = items.flatMap((item) => {
    const result = asRecord(item);
    const path = fieldString(result, "path", "name");
    if (!path) return [];
    return [
      {
        path,
        repository: repositoryLabel(result?.repository ?? result?.repo),
        ...(fieldString(result, "html_url", "htmlUrl", "url")
          ? { url: fieldString(result, "html_url", "htmlUrl", "url") }
          : {}),
        fragments: fragmentLines(result?.text_matches ?? result?.textMatches),
      } satisfies GithubCodeMatch,
    ];
  });
  return {
    matches,
    ...(numberValue(record?.total_count) ? { total: numberValue(record?.total_count) } : {}),
  };
}

function fieldArrayValue(record: JsonRecord | null, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

// ─── workflows and runs ─────────────────────────────────────────────────────────

export interface GithubWorkflowRow {
  name: string;
  path?: string;
  state?: string;
}

export function parseGithubWorkflows(value: unknown): GithubWorkflowRow[] {
  const payload = toolOutputPayload(value);
  const record = asRecord(payload);
  const items = Array.isArray(payload)
    ? payload
    : fieldArrayValue(record, "workflows", "workflow_runs", "workflowRuns", "runs", "jobs");
  return items.flatMap((item) => {
    const workflow = asRecord(item);
    const name = fieldString(workflow, "name", "display_title", "displayTitle", "path", "id");
    if (!name) return [];
    return [
      {
        name,
        ...(fieldString(workflow, "path") ? { path: fieldString(workflow, "path") } : {}),
        ...(fieldString(workflow, "state", "conclusion", "status")
          ? { state: fieldString(workflow, "state", "conclusion", "status") }
          : {}),
      } satisfies GithubWorkflowRow,
    ];
  });
}

export interface GithubRunSummary {
  workflow?: string;
  title?: string;
  runNumber?: number;
  attempt?: number;
  event?: string;
  branch?: string;
  commit?: string;
  commitMessage?: string;
  actor?: string;
  status?: string;
  conclusion?: string;
  pullRequests?: string;
  url?: string;
  startedAt?: string;
  updatedAt?: string;
}

export function parseGithubRun(value: unknown): GithubRunSummary | undefined {
  const record = asRecord(toolOutputPayload(value));
  if (!record) return undefined;
  const runNumber = numberValue(record.run_number ?? record.runNumber);
  const attempt = numberValue(record.run_attempt ?? record.runAttempt);
  const pullRequests = Array.isArray(record.pull_requests)
    ? record.pull_requests
        .map((pull) => stringify(asRecord(pull)?.number ?? pull))
        .filter((pull): pull is string => Boolean(pull))
        .map((pull) => `#${pull.replace(/^#/, "")}`)
        .join(", ")
    : stringify(record.pull_requests);
  return {
    workflow: fieldString(record, "name", "workflow_name", "workflowName"),
    title: fieldString(record, "display_title", "displayTitle", "head_commit_message"),
    ...(runNumber !== undefined ? { runNumber } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    event: fieldString(record, "event"),
    branch: fieldString(record, "head_branch", "headBranch", "branch"),
    commit: shortSha(fieldString(record, "head_sha", "headSha", "sha"), 8),
    commitMessage: fieldString(asRecord(record.head_commit) ?? null, "message"),
    actor:
      fieldString(asRecord(record.actor) ?? null, "login") ??
      stringify(record.actor) ??
      fieldString(record, "triggering_actor", "triggeringActor"),
    status: fieldString(record, "status"),
    conclusion: fieldString(record, "conclusion"),
    ...(pullRequests ? { pullRequests } : {}),
    url: fieldString(record, "html_url", "htmlUrl", "url"),
    startedAt: fieldString(record, "run_started_at", "runStartedAt", "created_at"),
    updatedAt: fieldString(record, "updated_at", "updatedAt"),
  };
}

/** Ordered label/value rows for a run: the same facts, said as facts. */
export function githubRunFacts(run: GithubRunSummary): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const push = (label: string, value: string | undefined) => {
    if (value) rows.push([label, value]);
  };
  push("Workflow", run.workflow);
  push(
    "Run",
    run.runNumber === undefined
      ? undefined
      : `#${run.runNumber}${run.attempt && run.attempt > 1 ? ` (attempt ${run.attempt})` : ""}`,
  );
  push("Event", run.event);
  push("Branch", run.branch);
  push("Commit", run.commit && run.commitMessage ? `${run.commit} ${run.commitMessage}` : run.commit);
  push("Pull request", run.pullRequests);
  push("Actor", run.actor);
  push("Started", run.startedAt);
  push("Updated", run.updatedAt);
  return rows;
}

// ─── job logs ───────────────────────────────────────────────────────────────────

const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;
// The escape byte is built rather than written: a control character in source is a
// lint error, and this one only ever appears mid-log.
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g");
const WORKFLOW_MARKER = /##\[(group|endgroup|debug|command|section|warning|error|notice)\]/g;

/**
 * A log line as a person reads it: no runner timestamp, no ANSI, no `##[group]` markers.
 *
 * The timestamps are on every request line and carry nothing once the log is on screen.
 */
export function cleanGithubLogLines(text: string): string[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(TIMESTAMP_PREFIX, "")
        .replace(ANSI_ESCAPE, "")
        .replace(WORKFLOW_MARKER, (_marker, kind: string) => (kind === "error" ? "error: " : "")),
    );
  const collapsed: string[] = [];
  for (const line of lines) {
    if (!line.trim() && !collapsed.at(-1)?.trim()) continue;
    collapsed.push(line.replace(/\s+$/, ""));
  }
  while (collapsed.length > 0 && !collapsed[collapsed.length - 1]?.trim()) collapsed.pop();
  return collapsed;
}

export interface GithubJobLog {
  name: string;
  lines: string[];
}

export interface GithubJobLogsView {
  jobs: GithubJobLog[];
  failedJobs?: number;
  totalJobs?: number;
}

export function parseGithubJobLogs(value: unknown): GithubJobLogsView {
  const payload = toolOutputPayload(value);
  const record = asRecord(payload);
  const entries = Array.isArray(payload)
    ? payload
    : fieldArrayValue(record, "logs", "jobs");
  const jobs: GithubJobLog[] = [];
  for (const entry of entries) {
    const item = asRecord(entry);
    const text =
      typeof entry === "string"
        ? entry
        : fieldString(item, "logs_content", "logsContent", "logs", "content", "text");
    if (!text) continue;
    const name =
      fieldString(item, "job_name", "jobName", "name") ??
      (fieldString(item, "conclusion", "status")
        ? `${fieldString(item, "conclusion", "status")} job`
        : "Job log");
    jobs.push({ name, lines: cleanGithubLogLines(text) });
  }
  if (jobs.length === 0) {
    const text = toolOutputText(value);
    if (text) jobs.push({ name: "Job log", lines: cleanGithubLogLines(text) });
  }
  const failedJobs = numberValue(record?.failed_jobs ?? record?.failedJobs);
  const totalJobs = numberValue(record?.total_jobs ?? record?.totalJobs);
  return {
    jobs,
    ...(failedJobs !== undefined ? { failedJobs } : {}),
    ...(totalJobs !== undefined ? { totalJobs } : {}),
  };
}

// ─── pull requests ──────────────────────────────────────────────────────────────

export interface GithubPullRequestSummary {
  title?: string;
  state?: string;
  draft?: boolean;
  author?: string;
  base?: string;
  head?: string;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  commits?: number;
  comments?: number;
  mergeableState?: string;
  labels?: string;
  url?: string;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function parseGithubPullRequest(value: unknown): GithubPullRequestSummary | undefined {
  const record = asRecord(toolOutputPayload(value));
  if (!record) return undefined;
  const labels = Array.isArray(record.labels)
    ? record.labels
        .map((label) => stringify(asRecord(label)?.name ?? label))
        .filter((label): label is string => Boolean(label))
        .join(", ")
    : stringify(record.labels);
  return {
    title: fieldString(record, "title"),
    state: fieldString(record, "state"),
    ...(typeof record.draft === "boolean" ? { draft: record.draft } : {}),
    author:
      fieldString(asRecord(record.user) ?? null, "login") ?? fieldString(record, "author"),
    base: fieldString(asRecord(record.base) ?? null, "ref") ?? fieldString(record, "base"),
    head: fieldString(asRecord(record.head) ?? null, "ref") ?? fieldString(record, "head"),
    changedFiles: numberValue(record.changed_files ?? record.changedFiles),
    additions: numberValue(record.additions),
    deletions: numberValue(record.deletions),
    commits: numberValue(record.commits),
    comments: numberValue(record.comments),
    mergeableState: fieldString(record, "mergeable_state", "mergeableState"),
    ...(labels ? { labels } : {}),
    url: fieldString(record, "html_url", "htmlUrl", "url"),
    body: fieldString(record, "body"),
    createdAt: fieldString(record, "created_at", "createdAt"),
    updatedAt: fieldString(record, "updated_at", "updatedAt"),
  };
}

/** Ordered label/value rows for a pull request; the body is rendered, not listed. */
export function githubPullRequestFacts(pr: GithubPullRequestSummary): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const push = (label: string, value: string | undefined) => {
    if (value) rows.push([label, value]);
  };
  push("Title", pr.title);
  push("State", pr.draft ? `${pr.state ?? "open"} (draft)` : pr.state);
  push("Author", pr.author);
  push("Branch", pr.head && pr.base ? `${pr.head} → ${pr.base}` : (pr.head ?? pr.base));
  push(
    "Changes",
    pr.changedFiles === undefined
      ? undefined
      : [
          `${pr.changedFiles} ${pr.changedFiles === 1 ? "file" : "files"}`,
          pr.additions === undefined ? undefined : `+${pr.additions}`,
          pr.deletions === undefined ? undefined : `−${pr.deletions}`,
        ]
          .filter(Boolean)
          .join(" · "),
  );
  push("Commits", pr.commits === undefined ? undefined : String(pr.commits));
  push("Comments", pr.comments === undefined ? undefined : String(pr.comments));
  push("Merge", pr.mergeableState);
  push("Labels", pr.labels);
  push("Updated", pr.updatedAt);
  push("URL", pr.url);
  return rows;
}
