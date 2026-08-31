import type { PaseoAgent } from "@getpaseo/client";
import type {
  AgentTimelineItem,
  AgentUsage,
  ToolCallTimelineItem,
} from "@getpaseo/protocol/agent-types";

export const MAX_RECENT_TOOL_CALLS = 10;

const DISPLAY_NAME_FALLBACK = "Unnamed subagent";
const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
const TOOL_SUMMARY_LIMIT = 160;

export type AgentRecord = PaseoAgent;
export type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

export interface TimelineEntry {
  readonly item: AgentTimelineItem;
  readonly timestamp: string;
}

export interface ToolCallActivity {
  readonly id: string;
  readonly name: string;
  readonly status: ToolCallTimelineItem["status"];
  readonly timestamp: string;
  readonly detailType: ToolCallItem["detail"]["type"];
  readonly summary: string;
  readonly providerSubagent: ProviderSubagentActivity | null;
}

export interface ProviderSubagentActivity {
  readonly id: string;
  readonly title: string;
  readonly subagentType: string | null;
  readonly childSessionId: string | null;
  readonly status: ToolCallTimelineItem["status"];
  readonly timestamp: string;
  readonly toolName: string;
  readonly description: string | null;
  readonly log: string | null;
  readonly actions: readonly { toolName: string; summary: string | null }[];
}

export interface AgentTreeNode {
  readonly agent: AgentRecord;
  readonly depth: number;
}

export function getParentId(agent: AgentRecord): string | null {
  const value = agent.labels?.[PARENT_AGENT_ID_LABEL];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isArchived(agent: AgentRecord): boolean {
  return agent.archivedAt != null;
}

export function getAgentDisplayName(agent: AgentRecord): string {
  return agent.title?.trim() || DISPLAY_NAME_FALLBACK;
}

export function getDescendantTree(
  agents: readonly AgentRecord[],
  parentId: string,
): readonly AgentTreeNode[] {
  const children = new Map<string, AgentRecord[]>();
  for (const agent of agents) {
    const parentIdForAgent = getParentId(agent);
    if (!parentIdForAgent) continue;
    const siblings = children.get(parentIdForAgent) ?? [];
    siblings.push(agent);
    children.set(parentIdForAgent, siblings);
  }

  for (const siblings of children.values()) siblings.sort(compareAgents);

  const result: AgentTreeNode[] = [];
  const visited = new Set<string>([parentId]);
  const visit = (ancestorId: string, depth: number) => {
    for (const agent of children.get(ancestorId) ?? []) {
      if (visited.has(agent.id)) continue;
      visited.add(agent.id);
      result.push({ agent, depth });
      visit(agent.id, depth + 1);
    }
  };
  visit(parentId, 0);
  return result;
}

export function compareAgents(left: AgentRecord, right: AgentRecord): number {
  const leftActivity = timestampValue(left.updatedAt);
  const rightActivity = timestampValue(right.updatedAt);
  if (leftActivity !== rightActivity) return rightActivity - leftActivity;
  return getAgentDisplayName(left).localeCompare(getAgentDisplayName(right));
}

export function isToolCall(item: AgentTimelineItem): item is ToolCallItem {
  return item.type === "tool_call";
}

export function getToolCallActivities(
  entries: readonly TimelineEntry[],
  limit = MAX_RECENT_TOOL_CALLS,
): readonly ToolCallActivity[] {
  return entries
    .filter(
    (entry): entry is TimelineEntry & { readonly item: ToolCallItem } => isToolCall(entry.item),
    )
    .map((entry) => toToolCallActivity(entry.item, entry.timestamp))
    .sort((left, right) => timestampValue(right.timestamp) - timestampValue(left.timestamp))
    .slice(0, limit);
}

export function getLatestTimelineTimestamp(entries: readonly TimelineEntry[]): string | null {
  return (
    entries
      .map((entry) => entry.timestamp)
      .filter((timestamp) => !Number.isNaN(Date.parse(timestamp)))
      .sort((left, right) => timestampValue(right) - timestampValue(left))[0] ?? null
  );
}

export function getLastActivityAt(
  agent: AgentRecord,
  timelineTimestamp: string | null,
): string {
  const timestamps = [agent.updatedAt, agent.lastUserMessageAt, timelineTimestamp].filter(
    (timestamp): timestamp is string => timestamp !== null,
  );
  return timestamps.sort((left, right) => timestampValue(right) - timestampValue(left))[0] ?? agent.updatedAt;
}

export function toToolCallActivity(item: ToolCallItem, timestamp: string): ToolCallActivity {
  return {
    id: item.callId,
    name: item.name,
    status: item.status,
    timestamp,
    detailType: item.detail.type,
    summary: getToolSummary(item),
    providerSubagent: getProviderSubagentActivity(item, timestamp),
  };
}

export function getProviderSubagentActivities(
  toolCalls: readonly ToolCallActivity[],
): readonly ProviderSubagentActivity[] {
  return toolCalls
    .map((toolCall) => toolCall.providerSubagent)
    .filter((activity): activity is ProviderSubagentActivity => activity !== null);
}

export function formatUsage(usage: AgentUsage | null | undefined): string {
  if (!usage) return "—";
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in ${formatTokenCount(usage.inputTokens)}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${formatTokenCount(usage.outputTokens)}`);
  if (usage.cachedInputTokens !== undefined) {
    parts.push(`cached ${formatTokenCount(usage.cachedInputTokens)}`);
  }
  if (usage.totalCostUsd !== undefined) parts.push(`$${usage.totalCostUsd.toFixed(2)}`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trimNumber(value / 1_000)}k`;
  return String(Math.round(value));
}

export function formatRelativeTime(timestamp: string, now = Date.now()): string {
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return "unknown activity";
  const seconds = Math.max(0, Math.floor((now - time) / 1_000));
  if (seconds < 60) return seconds <= 1 ? "just now" : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function toToolCallActivityDetail(
  item: ToolCallItem,
  timestamp: string,
): ProviderSubagentActivity | null {
  if (item.detail.type !== "sub_agent") return null;
  return {
    id: item.callId,
    title: item.detail.description?.trim() || item.detail.subAgentType?.trim() || item.name,
    subagentType: item.detail.subAgentType?.trim() || null,
    childSessionId: item.detail.childSessionId ?? null,
    status: item.status,
    timestamp,
    toolName: item.name,
    description: item.detail.description?.trim() || null,
    log: item.detail.log ? truncate(item.detail.log, TOOL_SUMMARY_LIMIT) : null,
    actions: (item.detail.actions ?? []).map((action) => ({
      toolName: action.toolName,
      summary: action.summary ? truncate(action.summary, TOOL_SUMMARY_LIMIT) : null,
    })),
  };
}

function getProviderSubagentActivity(
  item: ToolCallItem,
  timestamp: string,
): ProviderSubagentActivity | null {
  return toToolCallActivityDetail(item, timestamp);
}

function getToolSummary(item: ToolCallItem): string {
  const detail = item.detail;
  switch (detail.type) {
    case "shell":
      return truncate(detail.command, TOOL_SUMMARY_LIMIT);
    case "read":
    case "edit":
    case "write":
      return detail.filePath;
    case "search":
      return truncate(detail.query, TOOL_SUMMARY_LIMIT);
    case "fetch":
      return truncate(detail.url, TOOL_SUMMARY_LIMIT);
    case "worktree_setup":
      return `${detail.branchName} · ${detail.worktreePath}`;
    case "sub_agent":
      return truncate(detail.description || detail.subAgentType || "provider subagent", TOOL_SUMMARY_LIMIT);
    case "plain_text":
      return truncate(detail.label || "message", TOOL_SUMMARY_LIMIT);
    case "plan":
      return truncate(detail.text, TOOL_SUMMARY_LIMIT);
    case "unknown":
      return "tool result";
  }
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function trimNumber(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function timestampValue(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? Number.MIN_SAFE_INTEGER : value;
}
