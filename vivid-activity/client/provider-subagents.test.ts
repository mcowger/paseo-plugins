import { describe, expect, it, vi } from "vitest";
vi.mock("react", () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));
import { startProviderSubagents, useProviderSubagents } from "./provider-subagents";

function harness() {
  let onUpdate: ((message: unknown) => void) | undefined;
  const unsubscribe = vi.fn();
  const release = vi.fn(async () => undefined);
  const observeEvents = vi.fn(() => ({
    subscribe(observer: { update(message: unknown): void }) {
      onUpdate = observer.update;
      return unsubscribe;
    },
    release,
  }));
  return {
    paseo: { observeEvents },
    emit(message: unknown) { onUpdate?.(message); },
    observeEvents,
    unsubscribe,
    release,
  };
}


describe("provider subagent event observer", () => {
  it("shows only matching running children for a wait and excludes finished work", () => {
    const fake = harness();
    const stop = startProviderSubagents(fake.paseo);
    fake.emit({ type: "agent.provider_subagents.update", payload: { kind: "upsert", subagent: { id: "Scout", parentAgentId: "parent", toolCallId: "call", title: "scout", status: "running" } } });
    fake.emit({ type: "agent.provider_subagents.update", payload: { kind: "upsert", subagent: { id: "Other", parentAgentId: "parent", toolCallId: "other", title: "scout", status: "running" } } });
    fake.emit({ type: "agent.provider_subagents.update", payload: { kind: "timeline", parentAgentId: "parent", subagentId: "Scout", seq: 1, item: { type: "tool_call", name: "read", detail: { command: "file.ts" } } } });
    expect(useProviderSubagents("parent", "Scout")).toMatchObject([{ id: "Scout", activity: [{ title: "read", summary: "file.ts" }] }]);
    expect(useProviderSubagents("parent", undefined)).toHaveLength(2);
    expect(useProviderSubagents("parent", "missing")).toEqual([]);
    fake.emit({ type: "agent.provider_subagents.update", payload: { kind: "upsert", subagent: { id: "Scout", parentAgentId: "parent", toolCallId: "call", title: "scout", status: "completed" } } });
    expect(useProviderSubagents("parent", "Scout")).toEqual([]);
    stop();
  });

});

