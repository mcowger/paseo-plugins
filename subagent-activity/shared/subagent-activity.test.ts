import type { PaseoAgent } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import {
  formatRelativeTime,
  formatTokenCount,
  formatUsage,
  getDescendantTree,
  getLastActivityAt,
  getProviderSubagentActivities,
  getToolCallActivities,
  type AgentRecord,
  type TimelineEntry,
} from "./subagent-activity";

const PARENT_LABEL = "paseo.parent-agent-id";

function agent(id: string, parentId: string | null, updatedAt: string, archivedAt: string | null = null): AgentRecord {
  return {
    id,
    labels: parentId ? { [PARENT_LABEL]: parentId } : {},
    title: id,
    updatedAt,
    archivedAt,
  } as unknown as PaseoAgent;
}

function toolCall(
  callId: string,
  timestamp: string,
  detail: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"],
  status: "running" | "completed" | "failed" | "canceled" = "completed",
): TimelineEntry {
  const item = (
    status === "failed"
      ? {
          type: "tool_call" as const,
          callId,
          name: detail.type,
          detail,
          status: "failed" as const,
          error: "tool failed",
        }
      : status === "canceled"
        ? {
            type: "tool_call" as const,
            callId,
            name: detail.type,
            detail,
            status: "canceled" as const,
            error: null,
          }
        : status === "running"
          ? {
              type: "tool_call" as const,
              callId,
              name: detail.type,
              detail,
              status: "running" as const,
            }
          : {
              type: "tool_call" as const,
              callId,
              name: detail.type,
              detail,
              status: "completed" as const,
            }
  ) as AgentTimelineItem;

  return { item, timestamp };
}

describe("subagent-activity shared logic", () => {
  it("formats relative timestamps predictably", () => {
    const base = Date.parse("2026-08-31T05:00:00.000Z");
    expect(formatRelativeTime("2026-08-31T04:59:59.000Z", base)).toBe("just now");
    expect(formatRelativeTime("2026-08-31T04:59:45.000Z", base)).toBe("15s ago");
    expect(formatRelativeTime("2026-08-31T04:45:00.000Z", base)).toBe("15m ago");
    expect(formatRelativeTime("2026-08-31T01:00:00.000Z", base)).toBe("4h ago");
    expect(formatRelativeTime("2026-08-28T05:00:00.000Z", base)).toBe("3d ago");
    expect(formatRelativeTime("invalid-date", base)).toBe("unknown activity");
  });

  it("formats usage and token counts", () => {
    expect(formatTokenCount(900)).toBe("900");
    expect(formatTokenCount(1_200)).toBe("1.2k");
    expect(formatTokenCount(1_250_000)).toBe("1.3m");

    expect(
      formatUsage({
        inputTokens: 1200,
        outputTokens: 400,
        cachedInputTokens: 300,
        totalCostUsd: 0.05,
      }),
    ).toBe("in 1.2k · out 400 · cached 300 · $0.05");

    expect(formatUsage(null)).toBe("—");
  });

  it("builds a depth-aware descendant tree sorted by recency and title", () => {
    const parent = agent("parent", null, "2026-08-31T01:00:00.000Z");
    const childA = agent("child-a", "parent", "2026-08-31T02:00:00.000Z");
    const childB = agent("child-b", "parent", "2026-08-31T03:00:00.000Z");
    const grandchild = agent("grandchild", "child-a", "2026-08-31T04:00:00.000Z");
    const unrelated = agent("other", null, "2026-08-31T04:00:00.000Z");

    const tree = getDescendantTree([parent, childA, childB, grandchild, unrelated], "parent");

    expect(tree).toEqual([
      { agent: childB, depth: 0 },
      { agent: childA, depth: 0 },
      { agent: grandchild, depth: 1 },
    ]);
  });

  it("sorts and limits tool calls to the most recent items", () => {
    const entries: TimelineEntry[] = [
      toolCall("call-1", "2026-08-31T01:00:00.000Z", { type: "shell", command: "echo 1" }),
      toolCall("call-3", "2026-08-31T03:00:00.000Z", { type: "read", filePath: "/tmp/a" }),
      toolCall("call-2", "2026-08-31T02:00:00.000Z", { type: "search", query: "target" }),
      {
        timestamp: "2026-08-31T02:30:00.000Z",
        item: { type: "user_message", text: "hello" },
      },
    ];

    const activities = getToolCallActivities(entries, 2);
    expect(activities).toHaveLength(2);
    expect(activities[0]?.id).toBe("call-3");
    expect(activities[0]?.summary).toBe("/tmp/a");
    expect(activities[1]?.id).toBe("call-2");
    expect(activities[1]?.summary).toBe("target");
  });

  it("extracts provider subagent activities from sub_agent tool calls", () => {
    const entries: TimelineEntry[] = [
      toolCall("sub-1", "2026-08-31T03:00:00.000Z", {
        type: "sub_agent",
        description: "investigate repo",
        subAgentType: "researcher",
        childSessionId: "session-xyz",
        log: "",
        actions: [{ index: 0, toolName: "read", summary: "read package.json" }],
      }),
      toolCall("plain-1", "2026-08-31T02:00:00.000Z", { type: "shell", command: "ls -la" }),
    ];

    const activities = getToolCallActivities(entries);
    const providerActivities = getProviderSubagentActivities(activities);

    expect(providerActivities).toHaveLength(1);
    expect(providerActivities[0]).toEqual({
      id: "sub-1",
      title: "investigate repo",
      subagentType: "researcher",
      childSessionId: "session-xyz",
      status: "completed",
      timestamp: "2026-08-31T03:00:00.000Z",
      toolName: "sub_agent",
      description: "investigate repo",
      log: null,
      actions: [{ toolName: "read", summary: "read package.json" }],
    });
  });

  it("picks the latest timestamp between agent updates and timeline events", () => {
    const sampleAgent = agent("a", null, "2026-08-31T01:00:00.000Z");
    expect(getLastActivityAt(sampleAgent, "2026-08-31T02:00:00.000Z")).toBe("2026-08-31T02:00:00.000Z");
    expect(getLastActivityAt(sampleAgent, "2026-08-31T00:30:00.000Z")).toBe("2026-08-31T01:00:00.000Z");
    expect(getLastActivityAt(sampleAgent, null)).toBe("2026-08-31T01:00:00.000Z");
  });
});
