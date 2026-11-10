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
  it("associates live child activity with its originating task and removes it", () => {
    const fake = harness();
    const stop = startProviderSubagents(fake.paseo);
    fake.emit({ type: "agent.provider_subagents.update", payload: { kind: "upsert", subagent: { id: "child", parentAgentId: "parent", toolCallId: "call", title: "Scout", status: "running" } } });
    fake.emit({ type: "agent.provider_subagents.update", payload: { kind: "timeline", parentAgentId: "parent", subagentId: "child", seq: 1, item: { type: "tool_call", name: "read", detail: { command: "file.ts" } } } });
    expect(useProviderSubagents("parent", "call")).toMatchObject([{ title: "Scout", status: "running", activity: [{ title: "read", summary: "file.ts" }] }]);
    expect(useProviderSubagents("parent", "other")).toEqual([]);
    fake.emit({ type: "agent.provider_subagents.update", payload: { kind: "remove", parentAgentId: "parent", subagentId: "child" } });
    expect(useProviderSubagents("parent", "call")).toEqual([]);
    stop();
  });

});

