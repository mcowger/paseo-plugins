import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { isCodeModeTool } from "./codemode";
import { piSubagentOperation } from "./pi-subagents";
import {
  extractApplyPatchEdits,
  isApplyPatchTool,
  isOpencodeSubagentTool,
  isSubagentSupervisorTool,
  isTodoTool,
  resolveToolCallPresentation,
} from "./presentation";

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;
export type ToolCallStatus = ToolCallItem["status"];

export interface SummarySourceEntry {
  item: AgentTimelineItem;
  timestamp: Date;
}

export interface SummaryToolGroup {
  /** Stable identity for React keys and future toggles. */
  key: string;
  label: string;
  icon: string;
  count: number;
  /** Distinct file paths, in first-seen order. Empty for non-file tools. */
  files: string[];
  runningCount: number;
  failedCount: number;
  status: ToolCallStatus;
}

export interface SummaryThinkingEntry {
  text: string;
  timestamp: Date;
}

export interface SummaryOutputEntry {
  text: string;
  timestamp: Date;
}

export interface AgentActivitySummary {
  toolGroups: SummaryToolGroup[];
  thinking: SummaryThinkingEntry[];
  output: SummaryOutputEntry[];
  toolCallCount: number;
  thinkingCount: number;
  outputCount: number;
  /** Tool calls observed in the last 60 seconds. */
  toolCallsPerMinute: number;
  /** Milliseconds since the newest tool call, or null when there are none. */
  msSinceLastToolCall: number | null;
  activeToolCalls: number;
}

const MCP_PREFIX_PATTERN = /^mcp(__|_)/i;
const NAMESPACE_PREFIX_PATTERN = /^(?:functions|tools)\./i;
const RATE_WINDOW_MS = 60_000;

/**
 * Task/subagent delegation and todo bookkeeping are coordination calls, not
 * agent activity. They are left out of the summary entirely.
 */
export function isExcludedSummaryToolCall(item: ToolCallItem): boolean {
  if (item.detail.type === "sub_agent") return true;
  if (piSubagentOperation(item.name)) return true;
  if (isOpencodeSubagentTool(item.name) || isSubagentSupervisorTool(item.name)) return true;
  return isTodoTool(item.name);
}

/** The MCP tool leaf name (`mcp__exa__web_search_exa` -> `web_search_exa`). */
function mcpToolLeafName(rawName: string): string | null {
  const name = rawName.trim().replace(NAMESPACE_PREFIX_PATTERN, "");
  if (!MCP_PREFIX_PATTERN.test(name)) return null;
  const stripped = name.replace(/^mcp__/i, "").replace(/^mcp_/i, "");
  const segments = stripped.split("__").filter(Boolean);
  return segments.at(-1) ?? (stripped || null);
}

interface ToolCallClassification {
  key: string;
  label: string;
  icon: string;
  files: string[];
  /** apply_patch expands into one entry per edited file. */
  count: number;
}

function classifyToolCall(item: ToolCallItem): ToolCallClassification {
  if (isApplyPatchTool(item.name)) {
    const edits = extractApplyPatchEdits(
      item.detail,
      item.detail.type === "unknown" ? item.detail.output : undefined,
      item.metadata,
    );
    if (edits.length > 0) {
      return {
        key: "edit",
        label: "Edit",
        icon: "Pencil",
        files: edits.map((edit) => edit.filePath),
        count: edits.length,
      };
    }
  }

  if (isCodeModeTool(item.name)) {
    return { key: "codemode", label: "Codemode", icon: "SquareTerminal", files: [], count: 1 };
  }

  const mcpName = mcpToolLeafName(item.name);
  if (mcpName) {
    const presentation = resolveToolCallPresentation(item);
    return {
      key: `mcp:${mcpName}`,
      label: `MCP (${mcpName})`,
      icon: presentation.icon,
      files: [],
      count: 1,
    };
  }

  const presentation = resolveToolCallPresentation(item);
  return {
    key: `${presentation.category}:${presentation.label}`,
    label: presentation.label,
    icon: presentation.icon,
    files: presentation.filePath ? [presentation.filePath] : [],
    count: 1,
  };
}

function resolveGroupStatus(input: {
  runningCount: number;
  failedCount: number;
  canceledCount: number;
}): ToolCallStatus {
  if (input.runningCount > 0) return "running";
  if (input.failedCount > 0) return "failed";
  if (input.canceledCount > 0) return "canceled";
  return "completed";
}

interface MutableToolGroup {
  key: string;
  label: string;
  icon: string;
  count: number;
  files: Set<string>;
  runningCount: number;
  failedCount: number;
  canceledCount: number;
}

export function summarizeAgentActivity(
  entries: readonly SummarySourceEntry[],
  options: { now?: number } = {},
): AgentActivitySummary {
  const now = options.now ?? Date.now();
  const groups = new Map<string, MutableToolGroup>();
  const thinking: SummaryThinkingEntry[] = [];
  const output: SummaryOutputEntry[] = [];
  let toolCallCount = 0;
  let recentToolCalls = 0;
  let activeToolCalls = 0;
  let lastToolCallAt: number | null = null;

  for (const { item, timestamp } of entries) {
    if (item.type === "reasoning") {
      if (item.text.trim()) thinking.push({ text: item.text, timestamp });
      continue;
    }
    if (item.type === "assistant_message") {
      if (item.text.trim()) output.push({ text: item.text, timestamp });
      continue;
    }
    if (item.type !== "tool_call") continue;
    if (isExcludedSummaryToolCall(item)) continue;

    toolCallCount += 1;
    if (item.status === "running") activeToolCalls += 1;
    const at = timestamp.getTime();
    if (now - at <= RATE_WINDOW_MS) recentToolCalls += 1;
    if (lastToolCallAt === null || at > lastToolCallAt) lastToolCallAt = at;

    const classification = classifyToolCall(item);
    let group = groups.get(classification.key);
    if (!group) {
      group = {
        key: classification.key,
        label: classification.label,
        icon: classification.icon,
        count: 0,
        files: new Set(),
        runningCount: 0,
        failedCount: 0,
        canceledCount: 0,
      };
      groups.set(classification.key, group);
    }
    group.count += classification.count;
    for (const file of classification.files) group.files.add(file);
    if (item.status === "running") group.runningCount += 1;
    else if (item.status === "failed") group.failedCount += 1;
    else if (item.status === "canceled") group.canceledCount += 1;
  }

  const toolGroups = [...groups.values()]
    .map<SummaryToolGroup>((group) => ({
      key: group.key,
      label: group.label,
      icon: group.icon,
      count: group.count,
      files: [...group.files],
      runningCount: group.runningCount,
      failedCount: group.failedCount,
      status: resolveGroupStatus(group),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    toolGroups,
    thinking,
    output,
    toolCallCount,
    thinkingCount: thinking.length,
    outputCount: output.length,
    toolCallsPerMinute: recentToolCalls,
    msSinceLastToolCall: lastToolCallAt === null ? null : Math.max(0, now - lastToolCallAt),
    activeToolCalls,
  };
}

function fileBaseName(filePath: string): string {
  const trimmed = filePath.replace(/[/\\]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return base || filePath;
}

/** Compact basenames for summary rows, deduped in first-seen order. */
export function summaryFileLabels(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const file of files) {
    const label = fileBaseName(file);
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}
