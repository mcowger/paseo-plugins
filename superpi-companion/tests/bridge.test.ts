import { describe, expect, it } from "vitest";
import { createSubagentBridgeTracker, formatChildForward } from "../src/bridge.ts";
import {
  createCompanion,
  ROOT_SIGNAL_CHANNEL,
  ROOT_SIGNAL_VERSION,
} from "../src/companion.ts";
import {
  CHILD_NOTIFY_PREFIX,
  ChildForwardSchema,
  ROLE_ENV,
  SUBAGENT_BRIDGE_CHANNEL,
  SubagentBridgeRecordSchema,
  type SubagentBridgeRecord,
} from "../src/protocol.ts";
import { createFakeContext, createFakePi, type FakeNotify } from "./harness.ts";

const KEY = "key-1";

function bridgeRecord(overrides: Record<string, unknown> = {}): SubagentBridgeRecord {
  return {
    version: 1,
    runId: "run-1",
    sequence: 1,
    type: "created",
    childSessionId: "child-1",
    ...overrides,
  } as SubagentBridgeRecord;
}

function childNotifies(notifies: FakeNotify[]): Array<Record<string, unknown>> {
  return notifies
    .filter((notify) => notify.message.startsWith(CHILD_NOTIFY_PREFIX))
    .map((notify) => JSON.parse(notify.message.slice(CHILD_NOTIFY_PREFIX.length)) as Record<string, unknown>);
}

describe("subagent bridge tracker", () => {
  it("accepts ordered created/activity/terminal and counts active runs", () => {
    const tracker = createSubagentBridgeTracker(KEY);
    expect(tracker.accept(bridgeRecord())).toBeDefined();
    expect(tracker.activeChildren()).toBe(1);
    expect(
      tracker.accept(bridgeRecord({ sequence: 2, type: "activity", record: { kind: "message_start" } })),
    ).toBeDefined();
    expect(tracker.activeChildren()).toBe(1);
    expect(tracker.accept(bridgeRecord({ sequence: 3, type: "terminal", outcome: "completed" }))).toBeDefined();
    expect(tracker.activeChildren()).toBe(0);
  });

  it("drops activity before a created record and stale or duplicate sequences", () => {
    const tracker = createSubagentBridgeTracker(KEY);
    expect(tracker.accept(bridgeRecord({ type: "activity" }))).toBeUndefined();
    expect(tracker.accept(bridgeRecord())).toBeDefined();
    expect(tracker.accept(bridgeRecord({ sequence: 1, type: "activity" }))).toBeUndefined();
    expect(tracker.accept(bridgeRecord({ sequence: 0, type: "activity" }))).toBeUndefined();
  });

  it("keeps the terminal record sticky", () => {
    const tracker = createSubagentBridgeTracker(KEY);
    tracker.accept(bridgeRecord());
    tracker.accept(bridgeRecord({ sequence: 2, type: "terminal", outcome: "failed" }));
    expect(tracker.accept(bridgeRecord({ sequence: 3, type: "activity" }))).toBeUndefined();
    expect(tracker.accept(bridgeRecord({ sequence: 4, type: "terminal", outcome: "completed" }))).toBeUndefined();
    expect(tracker.activeChildren()).toBe(0);
  });

  it("formats the forward envelope with the child prefix", () => {
    const forward = { version: 1 as const, sessionKey: KEY, record: bridgeRecord() };
    const text = formatChildForward(forward);
    expect(text.startsWith(CHILD_NOTIFY_PREFIX)).toBe(true);
    expect(ChildForwardSchema.parse(JSON.parse(text.slice(CHILD_NOTIFY_PREFIX.length)))).toEqual(forward);
  });

  it("accepts streaming activity, cwd, and omission fields", () => {
    expect(SubagentBridgeRecordSchema.safeParse(bridgeRecord({ cwd: "/srv/child" })).success).toBe(true);
    const stream = SubagentBridgeRecordSchema.parse(
      bridgeRecord({
        sequence: 2,
        type: "activity",
        record: {
          kind: "message_update",
          usage: { input: 1, output: 0 },
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "Hi",
            partial: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
          },
        },
      }),
    );
    expect(stream.record).toMatchObject({ kind: "message_update" });
    const toolUpdate = SubagentBridgeRecordSchema.parse(
      bridgeRecord({
        sequence: 3,
        type: "activity",
        record: {
          kind: "tool_execution_update",
          toolCallId: "t1",
          toolName: "bash",
          args: { command: "ls" },
          partialResult: { output: "half" },
        },
      }),
    );
    expect(toolUpdate.record).toMatchObject({ kind: "tool_execution_update" });
    const omitted = SubagentBridgeRecordSchema.parse(
      bridgeRecord({ sequence: 4, type: "activity", omitted: true, omittedBytes: 9_000_000 }),
    );
    expect(omitted.omitted).toBe(true);
    expect(omitted.omittedBytes).toBe(9_000_000);
  });
});

function setupRoot() {
  const pi = createFakePi();
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY });
  const fake = createFakeContext({ branch: [] });
  return { pi, companion, ...fake };
}

describe("root companion bridge subscription", () => {
  it("subscribes only after session_start and forwards validated records", () => {
    const { pi, ctx, notifies } = setupRoot();
    pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord());
    expect(childNotifies(notifies)).toHaveLength(0);

    pi.handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord());
    pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord({ version: 2 }));
    pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord({ runId: "run-2", sequence: 5, surprise: true }));

    const forwarded = childNotifies(notifies);
    expect(forwarded).toHaveLength(1);
    const first = forwarded[0];
    expect(first).toMatchObject({ version: 1, sessionKey: KEY });
    const record = first?.record as Record<string, unknown> | undefined;
    expect(record?.runId).toBe("run-1");
  });

  it("tracks active children and clears them on terminal records", () => {
    const { pi, companion, ctx } = setupRoot();
    pi.handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord({ runId: "run-a" }));
    pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord({ runId: "run-b" }));
    expect(companion.activeChildren()).toBe(2);
    pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord({ runId: "run-a", sequence: 2, type: "terminal" }));
    expect(companion.activeChildren()).toBe(1);
  });

  it("disposes the subscription on session_shutdown", () => {
    const { pi, ctx, notifies } = setupRoot();
    pi.handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord());
    expect(childNotifies(notifies)).toHaveLength(1);

    pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
    pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord({ sequence: 2, type: "terminal" }));
    expect(childNotifies(notifies)).toHaveLength(1);
  });
});

// The tracker count is observable through the companion handle in rewind tests;
// terminal records clear active runs through the same handle.

describe("child companion bridge ownership", () => {
  it("does not subscribe when the companion is not the root owner", () => {
    const pi = createFakePi();
    const companion = createCompanion(pi.api, { origin: "child", sessionKey: KEY });
    const { ctx, notifies } = createFakeContext({ branch: [] });
    pi.handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord());
    expect(childNotifies(notifies)).toHaveLength(0);
    expect(companion.activeChildren()).toBe(0);
  });
});

function collectRootSignals(pi: ReturnType<typeof createFakePi>): Array<Record<string, unknown>> {
  const signals: Array<Record<string, unknown>> = [];
  pi.api.events.on(ROOT_SIGNAL_CHANNEL, (data) => {
    signals.push(data as Record<string, unknown>);
  });
  return signals;
}

describe("root session signal", () => {
  it("emits the root session id after session_start only for the flag root", () => {
    const pi = createFakePi();
    createCompanion(pi.api, { origin: "root", sessionKey: KEY });
    const signals = collectRootSignals(pi);
    const { ctx } = createFakeContext({ sessionId: "root-session-1", branch: [] });

    expect(signals).toHaveLength(0);
    pi.handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
    expect(signals).toEqual([
      { version: ROOT_SIGNAL_VERSION, sessionId: "root-session-1" },
    ]);
  });

  it("does not signal for a child or an environment-only root", () => {
    const childPi = createFakePi();
    createCompanion(childPi.api, { origin: "child", sessionKey: KEY });
    const childSignals = collectRootSignals(childPi);
    const { ctx: childCtx } = createFakeContext({ sessionId: "child-session-1", branch: [] });
    childPi.handlers.get("session_start")?.[0]?.({ type: "session_start" }, childCtx);
    expect(childSignals).toHaveLength(0);

    const previousRole = process.env[ROLE_ENV];
    process.env[ROLE_ENV] = "root";
    try {
      const envPi = createFakePi();
      createCompanion(envPi.api, { sessionKey: KEY });
      const envSignals = collectRootSignals(envPi);
      const { ctx: envCtx } = createFakeContext({ sessionId: "env-session-1", branch: [] });
      envPi.handlers.get("session_start")?.[0]?.({ type: "session_start" }, envCtx);
      expect(envSignals).toHaveLength(0);
    } finally {
      if (previousRole === undefined) delete process.env[ROLE_ENV];
      else process.env[ROLE_ENV] = previousRole;
    }
  });
});
