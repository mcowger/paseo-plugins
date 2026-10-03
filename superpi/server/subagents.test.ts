import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProviderEventSchema,
  type ProviderEvent,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import {
  SUBPI_CHILD_CHANNEL_PREFIX,
  SUBPI_SUBSESSION_CAPABILITY,
  parseSubpiChildEnvelope,
  type SubpiBridgeRecord,
} from "../shared/subagents.js";
import { createSubagentObserver, type SubagentObserver } from "./subagents.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

interface Harness {
  directory: string;
  events: ProviderEvent[];
  observer: SubagentObserver;
}

async function harness(
  restore = false,
  directory?: string,
  rootCwd?: string,
): Promise<Harness> {
  const resolved =
    directory ?? (await fs.mkdtemp(path.join(os.tmpdir(), "superpi-subagents-")));
  if (!directory) directories.push(resolved);
  const events: ProviderEvent[] = [];
  const observer = await createSubagentObserver({
    rootSessionId: "root-1",
    sessionKey: "session-key-1",
    directory: resolved,
    emit: (event) => events.push(event),
    restore,
    ...(rootCwd !== undefined ? { rootCwd } : {}),
  });
  return { directory: resolved, events, observer };
}

function created(runId: string, extra: Partial<SubpiBridgeRecord> = {}): SubpiBridgeRecord {
  return { version: 1, runId, sequence: 1, type: "created", ...extra };
}

function activity(
  runId: string,
  sequence: number,
  record: unknown,
): SubpiBridgeRecord {
  return { version: 1, runId, sequence, type: "activity", record };
}

function terminal(
  runId: string,
  sequence: number,
  extra: Partial<SubpiBridgeRecord> = {},
): SubpiBridgeRecord {
  return { version: 1, runId, sequence, type: "terminal", ...extra };
}

function opened(events: ProviderEvent[], sessionId: string) {
  const event = events.find(
    (candidate) => candidate.type === "session.opened" && candidate.sessionId === sessionId,
  );
  if (!event || event.type !== "session.opened") throw new Error(`Missing opened ${sessionId}`);
  return event;
}

function timelineItems(events: ProviderEvent[], sessionId: string): ProviderTimelineItem[] {
  return events
    .filter(
      (event) => event.type === "timeline.item" && event.sessionId === sessionId,
    )
    .map((event) => (event.type === "timeline.item" ? event.item : undefined))
    .filter((item): item is ProviderTimelineItem => Boolean(item));
}

function turnStates(events: ProviderEvent[], sessionId: string) {
  return events
    .filter((event) => event.type === "session.turn" && event.sessionId === sessionId)
    .map((event) => (event.type === "session.turn" ? event.state : undefined));
}

function notices(events: ProviderEvent[], sessionId: string) {
  return events
    .filter((event) => event.type === "session.notice" && event.sessionId === sessionId)
    .map((event) => (event.type === "session.notice" ? event.notice : undefined))
    .filter((notice): notice is NonNullable<typeof notice> => Boolean(notice));
}

function expectValidEvents(events: readonly ProviderEvent[]) {
  for (const event of events) {
    const parsed = ProviderEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error(`Invalid ProviderEvent ${JSON.stringify(event)}: ${parsed.error.message}`);
    }
  }
}

describe("subagent observer", () => {
  it("opens a read-only child and folds tool activity into full snapshots", async () => {
    const { events, observer } = await harness();
    await observer.accept(
      created("run-a", {
        toolCallId: "spawn-a",
        title: "Research worker",
        cwd: "/workspace/project",
        transcriptPath: "/workspace/project/subagents/run-a/session.jsonl",
      }),
    );
    await observer.accept(
      activity("run-a", 2, {
        kind: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "/workspace/project/file.ts" },
      }),
    );
    await observer.accept(
      activity("run-a", 3, {
        kind: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: "file contents",
      }),
    );

    const child = opened(events, "superpi-child:run-a");
    expect(child.parentSessionId).toBe("root-1");
    expect(child.toolCallId).toBe("spawn-a");
    expect(child.title).toBe("Research worker");
    expect(child.restoration).toBe("parent");
    expect(child.capabilities).toContain(SUBPI_SUBSESSION_CAPABILITY);
    // The bridge-supplied working directory wins over the transcript path.
    expect(child.cwd).toBe("/workspace/project");

    expect(turnStates(events, "superpi-child:run-a")).toEqual(["started"]);
    const items = timelineItems(events, "superpi-child:run-a");
    const toolItems = items.filter((item) => item.type === "tool_call");
    expect(toolItems.map((item) => item.status)).toEqual(["running", "completed"]);
    expect(toolItems.map((item) => item.id)).toEqual(["tool:tool-1", "tool:tool-1"]);
    expect(observer.activeCount()).toBe(1);
    expectValidEvents(events);
    await observer.close();
  });

  it("deduplicates repeated and out-of-order sequences and interleaved runs", async () => {
    const { events, observer } = await harness();
    await observer.accept(created("run-a"));
    await observer.accept(created("run-a"));
    await observer.accept(created("run-b"));
    await observer.accept(activity("run-a", 3, { kind: "turn_start" }));
    await observer.accept(activity("run-a", 2, { kind: "turn_end" }));
    await observer.accept(activity("run-a", 3, { kind: "turn_start" }));
    await observer.accept(activity("run-b", 2, { kind: "turn_start" }));

    expect(
      events.filter((event) => event.type === "session.opened"),
    ).toHaveLength(2);
    expect(turnStates(events, "superpi-child:run-a")).toEqual(["started"]);
    // run-b's higher sequence still applies after run-a's interleaved record.
    expect(turnStates(events, "superpi-child:run-b")).toEqual(["started"]);
    expect(observer.activeCount()).toBe(2);
    expectValidEvents(events);
    await observer.close();
  });

  it("keeps a terminal outcome sticky when late results arrive", async () => {
    const { events, observer } = await harness();
    await observer.accept(created("run-a"));
    await observer.accept(
      activity("run-a", 2, { kind: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" }),
    );
    await observer.accept(
      terminal("run-a", 3, { outcome: "canceled", reason: "parent stopped the child" }),
    );
    await observer.accept(
      activity("run-a", 4, {
        kind: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        result: "late result collection",
      }),
    );
    await observer.accept(terminal("run-a", 5, { outcome: "completed" }));

    expect(turnStates(events, "superpi-child:run-a")).toEqual(["started", "canceled"]);
    expect(observer.activeCount()).toBe(0);
    const childNotices = notices(events, "superpi-child:run-a");
    expect(childNotices.map((notice) => notice.description)).toContain(
      "parent stopped the child",
    );
    // The late tool result is never published.
    const items = timelineItems(events, "superpi-child:run-a");
    expect(items.filter((item) => item.type === "tool_call")).toHaveLength(1);
    expectValidEvents(events);
    await observer.close();
  });

  it("reports a steered run as completed and preserves the native reason", async () => {
    const { events, observer } = await harness();
    await observer.accept(created("run-a"));
    await observer.accept(terminal("run-a", 2, { outcome: "steered", reason: "soft turn limit" }));

    expect(turnStates(events, "superpi-child:run-a")).toEqual(["started", "completed"]);
    const childNotices = notices(events, "superpi-child:run-a");
    expect(childNotices.some((notice) => notice.description === "soft turn limit")).toBe(true);
    expectValidEvents(events);
    await observer.close();
  });

  it("preserves grandchild ancestry through the direct parent run", async () => {
    const { events, observer } = await harness();
    await observer.accept(created("run-parent", { toolCallId: "spawn-parent" }));
    await observer.accept(
      created("run-grandchild", { parentRunId: "run-parent", toolCallId: "spawn-grandchild" }),
    );

    const grandchild = opened(events, "superpi-child:run-grandchild");
    expect(grandchild.parentSessionId).toBe("superpi-child:run-parent");
    expect(grandchild.toolCallId).toBe("spawn-grandchild");
    expect(opened(events, "superpi-child:run-parent").capabilities).toContain(
      SUBPI_SUBSESSION_CAPABILITY,
    );
    expect(observer.activeCount()).toBe(2);
    expectValidEvents(events);
    await observer.close();
  });

  it("restores stable child ids and marks unfinished runs interrupted", async () => {
    const first = await harness();
    await first.observer.accept(created("run-done", { toolCallId: "spawn-done" }));
    await first.observer.accept(
      activity("run-done", 2, {
        kind: "message_end",
        message: { role: "assistant", timestamp: 1000, content: [{ type: "text", text: "done" }] },
      }),
    );
    await first.observer.accept(terminal("run-done", 3, { outcome: "completed", result: { ok: true } }));
    await first.observer.accept(created("run-lost", { toolCallId: "spawn-lost" }));
    await first.observer.accept(
      activity("run-lost", 2, { kind: "tool_execution_start", toolCallId: "tool-lost", toolName: "bash" }),
    );
    await first.observer.close();

    const second = await harness(true, first.directory);
    const doneId = "superpi-child:run-done";
    expect(opened(second.events, doneId).parentSessionId).toBe("root-1");
    expect(timelineItems(second.events, doneId).some((item) => item.type === "assistant_message")).toBe(
      true,
    );
    expect(turnStates(second.events, doneId)).toEqual(["started", "completed"]);

    const lostId = "superpi-child:run-lost";
    expect(opened(second.events, lostId).parentSessionId).toBe("root-1");
    expect(turnStates(second.events, lostId)).toEqual(["started", "failed"]);
    expect(
      notices(second.events, lostId).some((notice) => /interrupted/i.test(notice.title)),
    ).toBe(true);
    expect(second.observer.activeCount()).toBe(0);
    expectValidEvents(second.events);
    await second.observer.close();
  });

  it("restores more than 200 items and two megabytes without losing the tail", async () => {
    const first = await harness();
    await first.observer.accept(created("run-big", { toolCallId: "spawn-big" }));
    const text = "z".repeat(12 * 1024);
    let sequence = 2;
    for (let index = 0; index < 220; index += 1) {
      await first.observer.accept(
        activity("run-big", sequence, {
          kind: "message_end",
          message: {
            role: "assistant",
            timestamp: 2000 + index,
            content: [{ type: "text", text }],
          },
        }),
      );
      sequence += 1;
    }
    await first.observer.accept(terminal("run-big", sequence, { outcome: "completed" }));
    await first.observer.close();
    expect(
      (await fs.stat(path.join(first.directory, "child-journal.jsonl"))).size,
    ).toBeGreaterThan(2 * 1024 * 1024);

    const second = await harness(true, first.directory);
    const childId = "superpi-child:run-big";
    const items = timelineItems(second.events, childId);
    const assistant = items.filter((item) => item.type === "assistant_message");
    expect(assistant.length).toBeGreaterThan(200);
    // The final assistant snapshot is retained, proving no prefix cutoff.
    expect(assistant[assistant.length - 1]?.id).toBe("assistant:2219");
    expect(turnStates(second.events, childId)).toEqual(["started", "completed"]);
    expect(
      notices(second.events, childId).some((notice) => /truncated/i.test(notice.title)),
    ).toBe(true);
    expectValidEvents(second.events);
    await second.observer.close();
  });

  it("parses only exact child envelopes and leaves session-key filtering to the caller", () => {
    const record = created("run-a");
    const message = `${SUBPI_CHILD_CHANNEL_PREFIX}${JSON.stringify({
      version: 1,
      sessionKey: "other-session",
      record,
    })}`;
    const parsed = parseSubpiChildEnvelope(message);
    expect(parsed?.sessionKey).toBe("other-session");
    expect(parsed?.record.runId).toBe("run-a");
    expect(parseSubpiChildEnvelope("ordinary notification")).toBeUndefined();
    expect(parseSubpiChildEnvelope(`${SUBPI_CHILD_CHANNEL_PREFIX}not-json`)).toBeUndefined();
    expect(
      parseSubpiChildEnvelope(
        `${SUBPI_CHILD_CHANNEL_PREFIX}${JSON.stringify({ version: 2, sessionKey: "s", record })}`,
      ),
    ).toBeUndefined();
  });

  it("falls back to the root working directory when a record omits cwd", async () => {
    const { events, observer } = await harness(false, undefined, "/srv/root-work");
    await observer.accept(created("run-fallback", { toolCallId: "spawn-fallback" }));
    expect(opened(events, "superpi-child:run-fallback").cwd).toBe("/srv/root-work");
    expectValidEvents(events);
    await observer.close();
  });

  it("folds serialized streaming bridge activity into progressive text with no phantom calls", async () => {
    const { events, observer } = await harness();
    const childId = "superpi-child:run-stream";
    const deliver = async (record: SubpiBridgeRecord): Promise<void> => {
      const message = `${SUBPI_CHILD_CHANNEL_PREFIX}${JSON.stringify({
        version: 1,
        sessionKey: "session-key-1",
        record,
      })}`;
      const envelope = parseSubpiChildEnvelope(message);
      expect(envelope).toBeDefined();
      if (!envelope) throw new Error("envelope was rejected");
      await observer.accept(envelope.record);
    };

    await deliver({
      version: 1,
      runId: "run-stream",
      sequence: 1,
      type: "created",
      toolCallId: "spawn-stream",
      cwd: "/srv/worktree",
      transcriptPath: "/store/run-stream/session.jsonl",
    });
    await deliver(
      activity("run-stream", 2, {
        kind: "message_start",
        message: { role: "assistant", timestamp: 7, content: [] },
      }),
    );
    await deliver(
      activity("run-stream", 3, {
        kind: "message_update",
        usage: { input: 10, output: 0 },
        message: { role: "assistant", timestamp: 7, content: [] },
        assistantMessageEvent: {
          type: "text_start",
          contentIndex: 0,
          partial: { role: "assistant", timestamp: 7, content: [{ type: "text", text: "" }] },
        },
      }),
    );
    await deliver(
      activity("run-stream", 4, {
        kind: "message_update",
        message: { role: "assistant", timestamp: 7, content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Hel",
          partial: { role: "assistant", timestamp: 7, content: [{ type: "text", text: "Hel" }] },
        },
      }),
    );
    await deliver(
      activity("run-stream", 5, {
        kind: "message_update",
        message: { role: "assistant", timestamp: 7, content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "lo",
          partial: { role: "assistant", timestamp: 7, content: [{ type: "text", text: "Hello" }] },
        },
      }),
    );
    // A toolcall_start whose partial does not yet carry the block must not
    // publish a provisional row.
    await deliver(
      activity("run-stream", 6, {
        kind: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          partial: { role: "assistant", timestamp: 7, content: [] },
        },
      }),
    );
    await deliver(
      activity("run-stream", 7, {
        kind: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: { id: "call-1", name: "read", arguments: { path: "/a.ts" } },
          partial: {
            role: "assistant",
            timestamp: 7,
            content: [
              { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/a.ts" } },
            ],
          },
        },
      }),
    );
    await deliver(
      activity("run-stream", 8, {
        kind: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "read",
        partialResult: "half",
      }),
    );
    await deliver(
      activity("run-stream", 9, {
        kind: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: "file contents",
      }),
    );

    expect(opened(events, childId).cwd).toBe("/srv/worktree");
    const items = timelineItems(events, childId);
    const assistant = items.filter((item) => item.type === "assistant_message");
    expect(assistant.map((item) => item.text)).toEqual(["Hel", "Hello"]);
    const tools = items.filter((item) => item.type === "tool_call");
    expect(tools.map((item) => item.id)).toEqual([
      "tool:call-1",
      "tool:call-1",
      "tool:call-1",
    ]);
    expect(tools.map((item) => item.status)).toEqual([
      "running",
      "running",
      "completed",
    ]);
    // The provisional toolcall_start never published a phantom row of its own.
    expect(tools).toHaveLength(3);
    expect(observer.activeCount()).toBe(1);
    expectValidEvents(events);
    await observer.close();
  });

  it("warns instead of claiming full data when a record was omitted", async () => {
    const { events, observer } = await harness();
    await observer.accept(created("run-omit", { toolCallId: "spawn-omit" }));
    await observer.accept({
      version: 1,
      runId: "run-omit",
      sequence: 2,
      type: "activity",
      omitted: true,
      omittedBytes: 9_000_000,
      transcriptPath: "/store/run-omit/session.jsonl",
    });
    const childNotices = notices(events, "superpi-child:run-omit");
    expect(childNotices.some((notice) => /omitted/i.test(notice.title))).toBe(true);
    expect(
      timelineItems(events, "superpi-child:run-omit").filter(
        (item) => item.type === "tool_call",
      ),
    ).toHaveLength(0);
    expectValidEvents(events);
    await observer.close();
  });

  it("ignores malformed records without throwing", async () => {
    const { events, observer } = await harness();
    await observer.accept({ version: 1, runId: "", sequence: 0, type: "activity" });
    await observer.accept(null);
    expect(events).toEqual([]);
    expect(observer.activeCount()).toBe(0);
    await observer.close();
  });

  it("journals streaming deltas live-only so the journal grows with the reply, not the delta count", async () => {
    const { directory, events, observer } = await harness();
    const childId = "superpi-child:run-deltas";
    await observer.accept(created("run-deltas", { toolCallId: "spawn-deltas" }));

    // Every message_update carries the full cumulative message, matching the
    // real bridge. Journaling each one would grow quadratically; only the final
    // message_end is authoritative for recovery.
    const chunk = "d".repeat(10);
    const deltas = 2_000;
    let text = "";
    let sequence = 2;
    for (let index = 0; index < deltas; index += 1) {
      text += chunk;
      await observer.accept(
        activity("run-deltas", sequence, {
          kind: "message_update",
          message: { role: "assistant", timestamp: 5, content: [{ type: "text", text }] },
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: chunk,
            partial: {
              role: "assistant",
              timestamp: 5,
              content: [{ type: "text", text }],
            },
          },
        }),
      );
      sequence += 1;
    }
    expect(text.length).toBe(20_000);
    await observer.accept(
      activity("run-deltas", sequence, {
        kind: "message_end",
        message: { role: "assistant", timestamp: 5, content: [{ type: "text", text }] },
      }),
    );
    sequence += 1;
    await observer.accept(
      terminal("run-deltas", sequence, { outcome: "completed", result: text }),
    );

    // The accumulated deltas alone would exceed 20 MiB; the finalized journal is
    // linear in the final reply size.
    const journalBytes = (await fs.stat(path.join(directory, "child-journal.jsonl"))).size;
    expect(journalBytes).toBeLessThan(64 * 1024);
    expect(observer.activeCount()).toBe(0);
    expectValidEvents(events);
    await observer.close();

    const restored = await harness(true, directory);
    const assistant = timelineItems(restored.events, childId).filter(
      (item) => item.type === "assistant_message",
    );
    expect(assistant[assistant.length - 1]?.text).toBe(text);
    expect(turnStates(restored.events, childId)).toEqual(["started", "completed"]);
    expectValidEvents(restored.events);
    await restored.observer.close();
  });

  it("surfaces a result-only child's terminal result as a visible notice", async () => {
    const { events, observer } = await harness();
    await observer.accept(created("run-result-only", { toolCallId: "spawn-result" }));
    await observer.accept(
      terminal("run-result-only", 2, {
        outcome: "completed",
        result: "SYNTHETIC_HISTORY_END",
      }),
    );
    const childNotices = notices(events, "superpi-child:run-result-only");
    expect(
      childNotices.some((notice) => notice.description === "SYNTHETIC_HISTORY_END"),
    ).toBe(true);
    expectValidEvents(events);
    await observer.close();
  });

  it("does not duplicate a terminal result already present as the last assistant text", async () => {
    const { events, observer } = await harness();
    await observer.accept(created("run-dedupe"));
    await observer.accept(
      activity("run-dedupe", 2, {
        kind: "message_end",
        message: {
          role: "assistant",
          timestamp: 9,
          content: [{ type: "text", text: "final answer" }],
        },
      }),
    );
    await observer.accept(
      terminal("run-dedupe", 3, { outcome: "completed", result: "final answer" }),
    );
    const childNotices = notices(events, "superpi-child:run-dedupe");
    expect(childNotices.some((notice) => notice.id === "child-terminal-result:run-dedupe")).toBe(
      false,
    );
    expectValidEvents(events);
    await observer.close();
  });

  it("retains a distinct terminal result after a large restored prefix", async () => {
    const first = await harness();
    await first.observer.accept(created("run-large-result"));
    const text = "z".repeat(12 * 1024);
    let sequence = 2;
    for (let index = 0; index < 220; index += 1) {
      await first.observer.accept(
        activity("run-large-result", sequence, {
          kind: "message_end",
          message: {
            role: "assistant",
            timestamp: 3000 + index,
            content: [{ type: "text", text }],
          },
        }),
      );
      sequence += 1;
    }
    await first.observer.accept(
      terminal("run-large-result", sequence, {
        outcome: "completed",
        result: "SYNTHETIC_HISTORY_END",
      }),
    );
    await first.observer.close();

    const second = await harness(true, first.directory);
    const childId = "superpi-child:run-large-result";
    expect(
      notices(second.events, childId).some(
        (notice) => notice.description === "SYNTHETIC_HISTORY_END",
      ),
    ).toBe(true);
    expect(turnStates(second.events, childId)).toEqual(["started", "completed"]);
    expectValidEvents(second.events);
    await second.observer.close();
  });

  it("counts depth-2 runs and cancels each without flattening ancestry", async () => {
    const { events, observer } = await harness();
    await observer.accept(created("run-parent", { toolCallId: "spawn-parent" }));
    await observer.accept(
      created("run-grandchild", { parentRunId: "run-parent", toolCallId: "spawn-grandchild" }),
    );
    expect(observer.activeCount()).toBe(2);

    await observer.accept(
      terminal("run-grandchild", 2, { outcome: "canceled", reason: "grandchild stopped" }),
    );
    expect(observer.activeCount()).toBe(1);
    expect(turnStates(events, "superpi-child:run-grandchild")).toEqual(["started", "canceled"]);
    // The grandchild keeps its direct parent run; it is never flattened to root.
    expect(opened(events, "superpi-child:run-grandchild").parentSessionId).toBe(
      "superpi-child:run-parent",
    );
    expect(opened(events, "superpi-child:run-parent").parentSessionId).toBe("root-1");

    await observer.accept(terminal("run-parent", 3, { outcome: "completed" }));
    expect(observer.activeCount()).toBe(0);
    expectValidEvents(events);
    await observer.close();
  });
});
