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
} from "./subagent-activity.shared";

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
  const item = status === "failed"
    ? {
        type: "tool_call" as const,
        callId,
        name: detail.type,
        detail,
        status,
        error: "failed",
      }
    : {
        type: "tool_call" as const,
        callId,
        name: detail.type,
        detail,
        status,
        error: null,
      };
  return {
    timestamp,
    item,
  };
}

describe("subagent activity selectors", () => {
  it("builds a depth-first tree from managed-agent parent labels", () => {
    const nodes = getDescendantTree(
      [
        agent("grandchild", "child", "2026-08-31T03:00:00.000Z"),
        agent("child", "parent", "2026-08-31T02:00:00.000Z"),
        agent("sibling", "parent", "2026-08-31T01:00:00.000Z"),
        agent("unrelated", "other", "2026-08-31T04:00:00.000Z"),
      ],
      "parent",
    );

    expect(nodes.map(({ agent: item, depth }) => [item.id, depth])).toEqual([
      ["child", 0],
      ["grandchild", 1],
      ["sibling", 0],
    ]);
  });

  it("avoids loops in malformed parent relationships", () => {
    const nodes = getDescendantTree(
      [agent("a", "b", "2026-08-31T01:00:00.000Z"), agent("b", "a", "2026-08-31T02:00:00.000Z")],
      "a",
    );
    expect(nodes.map(({ agent: item }) => item.id)).toEqual(["b"]);
  });

  it("orders tool calls newest first and caps the result", () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      toolCall(
        String(index),
        `2026-08-31T00:${String(index).padStart(2, "0")}:00.000Z`,
        { type: "shell", command: `command-${index}` },
      ),
    );

    expect(getToolCallActivities(entries).map(({ id }) => id)).toEqual([
      "11",
      "10",
      "9",
      "8",
      "7",
      "6",
      "5",
      "4",
      "3",
      "2",
    ]);
  });

  it("extracts provider subagent cards without inventing missing metadata", () => {
    const calls = getToolCallActivities([
      toolCall("native-1", "2026-08-31T01:00:00.000Z", {
        type: "sub_agent",
        subAgentType: "explore",
        description: "Inspect the repository",
        childSessionId: "child-session",
        log: "Reading files",
        actions: [{ index: 0, toolName: "read", summary: "package.json" }],
      }, "running"),
    ]);

    expect(getProviderSubagentActivities(calls)).toEqual([
      {
        id: "native-1",
        title: "Inspect the repository",
        subagentType: "explore",
        childSessionId: "child-session",
        status: "running",
        timestamp: "2026-08-31T01:00:00.000Z",
        toolName: "sub_agent",
        description: "Inspect the repository",
        log: "Reading files",
        actions: [{ toolName: "read", summary: "package.json" }],
      },
    ]);
  });

  it("formats provider-reported usage and leaves missing values empty", () => {
    expect(formatUsage({ inputTokens: 12_500, outputTokens: 3_000, cachedInputTokens: 1_000 })).toBe(
      "in 12.5k · out 3k · cached 1k",
    );
    expect(formatUsage(undefined)).toBe("—");
    expect(formatTokenCount(1_000_000)).toBe("1m");
  });

  it("selects the most recent activity and formats relative times", () => {
    const agentSnapshot = agent("child", "parent", "2026-08-31T01:00:00.000Z");
    expect(getLastActivityAt(agentSnapshot, "2026-08-31T02:00:00.000Z")).toBe("2026-08-31T02:00:00.000Z");
    expect(formatRelativeTime("2026-08-31T00:00:00.000Z", Date.parse("2026-08-31T00:01:05.000Z"))).toBe("1m ago");
  });
});
