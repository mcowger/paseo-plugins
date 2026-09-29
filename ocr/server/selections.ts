import { randomUUID } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Finding } from "../shared/contracts.js";
import {
  MAX_SELECTION_BATCHES,
  retainRecentBatches,
  type SelectionBatch,
} from "../shared/settings.js";
import {
  buildBatchLabel,
  formatAttachmentText,
  matchesBatchQuery,
  summarizeSeverities,
} from "../shared/presentation.js";

export interface BatchSession {
  sessionId: string;
}

export interface BuildBatchInput {
  workspaceId: string;
  workspaceName: string;
  worktreeRoot: string;
  session: BatchSession | string;
  findings: Finding[];
  mode: "uncommitted" | "branch";
  baseRef?: string;
  targetRef?: string;
}

export interface AttachmentItem {
  id: string;
  identifier: string;
  title: string;
  subtitle?: string;
  url: string;
  text: string;
  resourceType: string;
}

function newBatchId(): string {
  try {
    return randomUUID();
  } catch {
    return `batch-${Date.now()}-${Math.floor(Math.random() * 1000000000)}`;
  }
}

function resolveSessionId(session: BatchSession | string): string {
  return typeof session === "string" ? session : session.sessionId;
}

function containsNullByte(value: string): boolean {
  return value.includes("\0");
}

function resolveInsideWorktree(worktreeRoot: string, findingPath: string): string | null {
  if (!findingPath || containsNullByte(findingPath)) return null;
  const normalizedRoot = resolve(worktreeRoot);
  const resolved = isAbsolute(findingPath) ? resolve(findingPath) : resolve(normalizedRoot, findingPath);
  if (resolved === normalizedRoot || resolved.startsWith(normalizedRoot + sep)) {
    return resolved;
  }
  return null;
}

export function buildFileUrl(worktreeRoot: string, findings: Finding[]): string {
  const first = findings[0];
  const inside = first ? resolveInsideWorktree(worktreeRoot, first.path) : null;
  return pathToFileURL(inside ?? resolve(worktreeRoot)).href;
}

export function buildBatchFromFindings(input: BuildBatchInput): SelectionBatch {
  const sessionId = resolveSessionId(input.session);
  const createdAt = new Date().toISOString();
  return {
    id: newBatchId(),
    label: buildBatchLabel(input.findings, input.mode),
    createdAt,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    worktreeRoot: input.worktreeRoot,
    sessionId,
    mode: input.mode,
    ...(input.baseRef ? { baseRef: input.baseRef } : {}),
    ...(input.targetRef ? { targetRef: input.targetRef } : {}),
    findingCount: input.findings.length,
    severitySummary: summarizeSeverities(input.findings),
    findingIds: input.findings.map((finding) => finding.id),
    attachmentText: formatAttachmentText(input.findings, {
      workspaceName: input.workspaceName,
      worktreeRoot: input.worktreeRoot,
      sessionId,
      mode: input.mode,
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      ...(input.targetRef ? { targetRef: input.targetRef } : {}),
    }),
    fileUrl: buildFileUrl(input.worktreeRoot, input.findings),
  };
}

export function batchToAttachmentItem(batch: SelectionBatch): AttachmentItem {
  const scope =
    batch.mode === "branch"
      ? `${batch.baseRef ?? "?"}..${batch.targetRef ?? "?"}`
      : "uncommitted";
  return {
    id: batch.id,
    identifier: batch.id,
    title: `${batch.workspaceName} — ${batch.label}`,
    subtitle: `Session ${batch.sessionId} · ${scope} · ${batch.findingCount} findings · saved ${batch.createdAt}`,
    url: batch.fileUrl,
    text: batch.attachmentText,
    resourceType: "ocr-selection",
  };
}

export function filterBatches(batches: SelectionBatch[], query: string): SelectionBatch[] {
  return batches.filter((batch) => matchesBatchQuery(query, batch));
}

export function limitBatches(batches: SelectionBatch[]): SelectionBatch[] {
  return retainRecentBatches(batches);
}

export { MAX_SELECTION_BATCHES };
