import { describe, expect, it } from "vitest";
import {
  childTimelineEntryKey,
  extractPaseoChildAgentId,
  recentChildTimelineEntries,
} from "./child-agent";

describe("child agent presentation", () => {
  it("extracts the child agent ID from a create_agent result", () => {
    expect(extractPaseoChildAgentId({ agentId: "agent-child" })).toBe("agent-child");
    expect(extractPaseoChildAgentId({ agentId: "" })).toBeUndefined();
    expect(extractPaseoChildAgentId({ id: "agent-child" })).toBeUndefined();
  });

  it("keeps the latest child timeline entries in sequence order", () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      seqStart: 10 - index,
      seqEnd: 10 - index,
    }));
    const recent = recentChildTimelineEntries(entries);

    expect(recent).toHaveLength(8);
    expect(recent[0]?.seqStart).toBe(3);
    expect(recent.at(-1)?.seqStart).toBe(10);
    expect(childTimelineEntryKey(recent[0]!)).toBe("3-3");
  });
});
