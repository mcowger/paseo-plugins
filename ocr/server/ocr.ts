import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Finding, ReviewCounts, ReviewMode, ReviewStatus, SessionSummary } from "../shared/contracts.js";
import { normalizeSeverity, stableFindingId } from "../shared/presentation.js";

export type KillableChild = Pick<ChildProcess, "kill"> & { pid?: number };

export function getOcrBin(): string {
  const override = process.env.OCR_BIN?.trim();
  return override ? override : "opencodereview";
}

export interface OcrAvailability {
  available: boolean;
  version?: string;
}

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;

export function checkExecutable(): OcrAvailability {
  try {
    const result = spawnSync(getOcrBin(), ["--version"], {
      timeout: 10000,
      encoding: "utf8",
      maxBuffer: MAX_STDERR_BYTES * 2,
      shell: false,
    });
    if (result.status !== 0) return { available: false };
    const version = `${typeof result.stdout === "string" ? result.stdout : ""}${
      typeof result.stderr === "string" ? result.stderr : ""
    }`
      .trim()
      .slice(0, 200);
    return version ? { available: true, version } : { available: true };
  } catch {
    return { available: false };
  }
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runProcess(
  args: string[],
  cwd: string,
  timeoutMs: number,
  onChild?: (child: KillableChild) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(getOcrBin(), args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Failed to start OCR process"));
      return;
    }
    onChild?.(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore kill failures; the close handler below still settles.
      }
      reject(new Error(`OCR process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stdout.length < MAX_STDOUT_BYTES) {
        stdout += text.slice(0, MAX_STDOUT_BYTES - stdout.length);
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += text.slice(0, MAX_STDERR_BYTES - stderr.length);
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

function assertValidSessionId(sessionId: string): void {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid session id "${sessionId}"`);
  }
}

export interface NormalizedReview {
  status: ReviewStatus;
  sessionId?: string;
  findings: Finding[];
  warnings: string[];
  counts: ReviewCounts;
  message?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return undefined;
}

function normalizeStatusToken(raw: string, findingCount: number): ReviewStatus {
  const token = raw.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (
    token === "skipped" ||
    token === "no_files" ||
    token === "no_eligible_files" ||
    token === "no_files_changed"
  ) {
    return "skipped";
  }
  if (
    token === "partial" ||
    token === "completed_with_warnings" ||
    token === "completed_with_errors" ||
    token === "failed" ||
    token === "failure" ||
    token === "error"
  ) {
    return "partial";
  }
  if (token === "success" || token === "completed" || token === "complete" || token === "ok") {
    return findingCount > 0 ? "complete" : "complete";
  }
  return "unknown";
}

function normalizeComment(raw: unknown, sessionKey: string, occurrence: number): Finding | null {
  const comment = asRecord(raw);
  if (!comment) return null;
  const path = firstString(comment.path, comment.file, comment.filePath, comment.relativePath);
  const content = firstString(comment.content, comment.body, comment.message, comment.text);
  if (!path || !content) return null;
  const startLine =
    toNonNegativeInt(comment.startLine ?? comment.start_line ?? comment.start ?? comment.line) ?? 0;
  const endLine =
    toNonNegativeInt(comment.endLine ?? comment.end_line ?? comment.end) ?? startLine;
  const category = firstString(comment.category);
  const severity = normalizeSeverity(comment.severity);
  const existingCode = firstString(comment.existingCode, comment.existing, comment.original);
  const suggestionCode = firstString(
    comment.suggestionCode,
    comment.suggestion,
    comment.proposed,
    comment.fix,
  );
  const id = stableFindingId(sessionKey, occurrence, [
    path,
    content,
    String(startLine),
    String(endLine),
    category ?? "",
    severity,
  ]);
  return {
    id,
    path,
    content,
    startLine,
    endLine,
    ...(existingCode ? { existingCode } : {}),
    ...(suggestionCode ? { suggestionCode } : {}),
    ...(category ? { category } : {}),
    severity,
  };
}

export function normalizeOcrEnvelope(json: unknown, sessionFallback?: string): NormalizedReview {
  const envelope = asRecord(json);
  if (!envelope) {
    throw new Error("Malformed OCR output: expected a JSON object");
  }
  const manifest = asRecord(envelope.manifest);
  const session = asRecord(envelope.session);
  const rawComments = Array.isArray(envelope.comments)
    ? envelope.comments
    : Array.isArray(envelope.findings)
      ? envelope.findings
      : [];
  const sessionId = firstString(
    envelope.sessionId,
    envelope.session_id,
    session?.id,
    session?.sessionId,
    manifest?.sessionId,
    manifest?.session_id,
    sessionFallback,
  );
  const sessionKey = sessionId ?? sessionFallback ?? "unknown-session";
  const occurrenceCounts = new Map<string, number>();
  const findings: Finding[] = [];
  for (const raw of rawComments) {
    const probe = asRecord(raw);
    const key = probe
      ? JSON.stringify([
          firstString(probe.path, probe.file, probe.filePath, probe.relativePath) ?? "",
          firstString(probe.content, probe.body, probe.message, probe.text) ?? "",
        ])
      : "invalid";
    const occurrence = occurrenceCounts.get(key) ?? 0;
    occurrenceCounts.set(key, occurrence + 1);
    const finding = normalizeComment(raw, sessionKey, occurrence);
    if (finding) findings.push(finding);
  }
  const statusToken = firstString(
    manifest?.terminal_state,
    manifest?.terminalState,
    manifest?.status,
    envelope.status,
    envelope.state,
  );
  const status = statusToken ? normalizeStatusToken(statusToken, findings.length) : "unknown";
  const warnings = [
    ...firstStringArray(envelope.warnings),
    ...firstStringArray(manifest?.warnings),
  ];
  const countsSource =
    asRecord(envelope.counts) ?? asRecord(envelope.summary) ?? asRecord(manifest?.counts) ?? {};
  const counts: ReviewCounts = {};
  for (const key of ["selected", "completed", "failed", "reused", "waived", "filesReviewed"] as const) {
    const value = toNonNegativeInt(countsSource[key]);
    if (value !== undefined) counts[key] = value;
  }
  if (countsSource.files_reviewed !== undefined && counts.filesReviewed === undefined) {
    const value = toNonNegativeInt(countsSource.files_reviewed);
    if (value !== undefined) counts.filesReviewed = value;
  }
  const totalComments =
    toNonNegativeInt(countsSource.totalComments) ??
    toNonNegativeInt(countsSource.total_comments) ??
    toNonNegativeInt(envelope.totalComments);
  if (totalComments !== undefined && counts.completed === undefined) {
    counts.completed = totalComments;
  }
  const message = firstString(envelope.message, envelope.error, manifest?.message);
  return {
    status,
    ...(sessionId ? { sessionId } : {}),
    findings,
    warnings,
    counts,
    ...(message ? { message } : {}),
  };
}

export interface RunReviewOptions {
  cwd: string;
  mode: ReviewMode;
  targetRef?: string;
  baseRef?: string;
  timeoutMs?: number;
  onChild?: (child: KillableChild) => void;
}

export interface ReviewRunOutcome extends NormalizedReview {
  elapsedMs: number;
}

export async function runReviewJson(options: RunReviewOptions): Promise<ReviewRunOutcome> {
  const startedAt = Date.now();
  const args = ["review", "--format", "json", "--audience", "agent", "--repo", options.cwd];
  if (options.mode === "branch") {
    if (!options.targetRef || !options.baseRef) {
      throw new Error("Branch reviews require targetRef and baseRef");
    }
    args.push("--from", options.baseRef, "--to", options.targetRef);
  }
  const result = await runProcess(args, options.cwd, options.timeoutMs ?? 600000, options.onChild);
  const elapsedMs = Date.now() - startedAt;
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 2000);
    throw new Error(`OCR review failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Malformed OCR output: stdout is not a single JSON document");
  }
  const normalized = normalizeOcrEnvelope(parsed);
  return { ...normalized, elapsedMs };
}

function normalizeSessionEntry(raw: unknown): SessionSummary | null {
  const entry = asRecord(raw);
  if (!entry) return null;
  const sessionId = firstString(entry.sessionId, entry.session_id, entry.id);
  if (!sessionId) return null;
  const comments = Array.isArray(entry.comments) ? entry.comments : undefined;
  return {
    sessionId,
    reviewMode: firstString(entry.reviewMode, entry.review_mode, entry.mode, entry.kind) ?? "unknown",
    ...(firstString(entry.createdAt, entry.created_at, entry.timestamp)
      ? { createdAt: firstString(entry.createdAt, entry.created_at, entry.timestamp) as string }
      : {}),
    ...(toNonNegativeInt(entry.totalComments ?? entry.total_comments ?? entry.commentCount) !== undefined
      ? {
          totalComments: toNonNegativeInt(
            entry.totalComments ?? entry.total_comments ?? entry.commentCount,
          ) as number,
        }
      : comments
        ? { totalComments: comments.length }
        : {}),
    ...(firstString(entry.model) ? { model: firstString(entry.model) as string } : {}),
    ...(firstString(entry.gitBranch, entry.git_branch, entry.branch)
      ? { gitBranch: firstString(entry.gitBranch, entry.git_branch, entry.branch) as string }
      : {}),
    ...(firstString(entry.diffFrom, entry.diff_from, entry.from)
      ? { diffFrom: firstString(entry.diffFrom, entry.diff_from, entry.from) as string }
      : {}),
    ...(firstString(entry.diffTo, entry.diff_to, entry.to)
      ? { diffTo: firstString(entry.diffTo, entry.diff_to, entry.to) as string }
      : {}),
    ...(firstString(entry.diffCommit, entry.diff_commit, entry.commit)
      ? { diffCommit: firstString(entry.diffCommit, entry.diff_commit, entry.commit) as string }
      : {}),
  };
}

export async function listHistory(cwd: string, limit?: number): Promise<SessionSummary[]> {
  const result = await runProcess(["session", "list", "--repo", cwd, "--json"], cwd, 30000);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 1000);
    throw new Error(`Failed to list OCR sessions${detail ? `: ${detail}` : ""}`);
  }
  const trimmed = result.stdout.trim();
  if (!trimmed || trimmed === "null") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Malformed OCR session list output");
  }
  if (parsed === null) return [];
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(asRecord(parsed)?.sessions)
      ? (asRecord(parsed)?.sessions as unknown[])
      : null;
  if (!entries) {
    throw new Error("Malformed OCR session list output");
  }
  const sessions: SessionSummary[] = [];
  for (const entry of entries) {
    const normalized = normalizeSessionEntry(entry);
    if (normalized) sessions.push(normalized);
  }
  return limit !== undefined ? sessions.slice(0, limit) : sessions;
}

async function assertSessionInHistory(cwd: string, sessionId: string): Promise<SessionSummary[]> {
  assertValidSessionId(sessionId);
  const sessions = await listHistory(cwd);
  if (!sessions.some((session) => session.sessionId === sessionId)) {
    throw new Error(`Session "${sessionId}" was not found for this worktree`);
  }
  return sessions;
}

export async function showSession(cwd: string, sessionId: string): Promise<SessionSummary> {
  await assertSessionInHistory(cwd, sessionId);
  const result = await runProcess(
    ["session", "show", "--repo", cwd, "--json", sessionId],
    cwd,
    30000,
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 1000);
    throw new Error(`Failed to load OCR session "${sessionId}"${detail ? `: ${detail}` : ""}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`Malformed OCR session output for "${sessionId}"`);
  }
  const summary = normalizeSessionEntry(parsed);
  if (!summary) {
    throw new Error(`Malformed OCR session output for "${sessionId}"`);
  }
  return summary;
}

export async function sessionComments(cwd: string, sessionId: string): Promise<Finding[]> {
  await assertSessionInHistory(cwd, sessionId);
  const result = await runProcess(
    ["session", "comments", "--repo", cwd, "--json", sessionId],
    cwd,
    30000,
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 1000);
    throw new Error(`Failed to load OCR session comments for "${sessionId}"${detail ? `: ${detail}` : ""}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`Malformed OCR comments output for "${sessionId}"`);
  }
  const records = asRecord(parsed);
  const rawComments = Array.isArray(parsed)
    ? (parsed as unknown[])
    : records && Array.isArray(records.comments)
      ? (records.comments as unknown[])
      : null;
  if (!rawComments) {
    throw new Error(`Malformed OCR comments output for "${sessionId}"`);
  }
  const occurrenceCounts = new Map<string, number>();
  const findings: Finding[] = [];
  for (const raw of rawComments) {
    const probe = asRecord(raw);
    const key = probe
      ? JSON.stringify([
          firstString(probe.path, probe.file, probe.filePath, probe.relativePath) ?? "",
          firstString(probe.content, probe.body, probe.message, probe.text) ?? "",
        ])
      : "invalid";
    const occurrence = occurrenceCounts.get(key) ?? 0;
    occurrenceCounts.set(key, occurrence + 1);
    const finding = normalizeComment(raw, sessionId, occurrence);
    if (finding) findings.push(finding);
  }
  return findings;
}
