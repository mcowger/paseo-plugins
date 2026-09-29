import type { Finding, Severity } from "./contracts.js";
import { SEVERITY_ORDER } from "./contracts.js";

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  unspecified: "Unspecified",
};

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unspecified: 4,
};

export function normalizeSeverity(value: unknown): Severity {
  if (value === "critical" || value === "high" || value === "medium" || value === "low") return value;
  return "unspecified";
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const severityDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severityDiff !== 0) return severityDiff;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.endLine !== b.endLine) return a.endLine - b.endLine;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export type SeverityPreset = "critical" | "high-plus" | "medium-plus" | "all";

export type SeverityThemeKey = "statusDanger" | "statusWarning" | "accent" | "foregroundMuted";

export function severityThemeKey(severity: Severity): SeverityThemeKey {
  if (severity === "critical") return "statusDanger";
  if (severity === "high") return "statusWarning";
  if (severity === "medium") return "accent";
  return "foregroundMuted";
}

export function severityIconName(severity: Severity): string {
  if (severity === "critical") return "OctagonAlert";
  if (severity === "high") return "TriangleAlert";
  if (severity === "medium") return "Info";
  if (severity === "low") return "Minus";
  return "CircleHelp";
}

export function severityTintOpacity(severity: Severity): number {
  if (severity === "critical") return 0.14;
  if (severity === "high") return 0.1;
  if (severity === "medium") return 0.07;
  return 0;
}

export function applySeverityPreset(findings: Finding[], preset: SeverityPreset): string[] {
  const keep = (severity: Severity): boolean => {
    if (preset === "critical") return severity === "critical";
    if (preset === "high-plus") return severity === "critical" || severity === "high";
    if (preset === "medium-plus")
      return severity === "critical" || severity === "high" || severity === "medium";
    return true;
  };
  return findings.filter((finding) => keep(finding.severity)).map((finding) => finding.id);
}

export function summarizeSeverities(findings: Finding[]): string {
  const counts = new Map<Severity, number>();
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  return SEVERITY_ORDER.filter((severity) => (counts.get(severity) ?? 0) > 0)
    .map((severity) => `${counts.get(severity)} ${severity}`)
    .join(", ");
}

export function stableFindingId(sessionId: string, index: number, parts: string[]): string {
  const canonical = [sessionId, String(index), ...parts].join("|");
  let hash = 0;
  for (let i = 0; i < canonical.length; i += 1) {
    hash = (hash * 31 + canonical.charCodeAt(i)) >>> 0;
  }
  return `${sessionId.slice(0, 8)}-${hash.toString(16)}-${index}`;
}

export interface FindingIdentityParts {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  category?: string;
  severity?: string;
}

export function buildFindingIdentity(parts: FindingIdentityParts): string {
  return [parts.path, parts.content, String(parts.startLine), String(parts.endLine), parts.category ?? "", parts.severity ?? ""].join(
    "|",
  );
}

export function formatFindingForText(finding: Finding): string {
  const lines: string[] = [];
  lines.push(`- [${finding.severity}] ${finding.path}:${finding.startLine}-${finding.endLine}`);
  if (finding.category) lines.push(`  Category: ${finding.category}`);
  lines.push(`  ${finding.content}`);
  if (finding.existingCode) lines.push(`  Existing:\n${indentBlock(finding.existingCode)}`);
  if (finding.suggestionCode) lines.push(`  Suggested:\n${indentBlock(finding.suggestionCode)}`);
  return lines.join("\n");
}

function indentBlock(value: string): string {
  return value
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

export interface BatchContext {
  workspaceName: string;
  worktreeRoot: string;
  sessionId: string;
  mode: string;
  baseRef?: string;
  targetRef?: string;
}

export function formatAttachmentText(findings: Finding[], context: BatchContext): string {
  const header = [
    `OpenCodeReview findings for ${context.workspaceName}`,
    `Session: ${context.sessionId} (${context.mode}${context.baseRef || context.targetRef ? ` ${context.baseRef ?? ""}..${context.targetRef ?? ""}`.trim() : ""})`,
    `Worktree: ${context.worktreeRoot}`,
    `Findings: ${findings.length} (${summarizeSeverities(findings) || "none"})`,
    "",
  ].join("\n");
  return `${header}${findings.map((finding) => formatFindingForText(finding)).join("\n")}\n`;
}

export function buildAgentPrompt(instructions: string, findings: Finding[], context: BatchContext): string {
  const trimmed = instructions.trim();
  return `${trimmed}\n\n${formatAttachmentText(findings, context)}`;
}

export function buildBatchLabel(findings: Finding[], mode: string): string {
  const summary = summarizeSeverities(findings);
  return `${findings.length} findings (${mode}${summary ? `; ${summary}` : ""})`;
}

export function matchesBatchQuery(
  query: string,
  batch: { label: string; workspaceName: string; sessionId: string; attachmentText: string },
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${batch.label}\n${batch.workspaceName}\n${batch.sessionId}\n${batch.attachmentText}`.toLowerCase();
  return needle
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}
