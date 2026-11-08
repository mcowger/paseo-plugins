import { describe, expect, it } from "vitest";
import {
  CHILD_EVENT_READ_DELAY_MS,
  CHILD_TIMELINE_PAGE_SIZE,
  childFeedDirty,
  childLoaded,
  childReadable,
  childStatus,
  childFeedHold,
  childFeedStart,
  childFeedStep,
  childTimelineEntryKey,
  extractPaseoChildAgentId,
  MAX_VISIBLE_CHILD_ACTIVITY_ENTRIES,
  recentChildTimelineEntries,
  type ChildFeedEvent,
  type ChildFeedHold,
  type ChildFeedState,
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

describe("child agent card reads (0.5.0)", () => {
  it("reads 8 entries, which always fill the 3 rows it shows", () => {
    expect(CHILD_TIMELINE_PAGE_SIZE).toBeLessThanOrEqual(12);
    expect(CHILD_TIMELINE_PAGE_SIZE).toBeGreaterThanOrEqual(MAX_VISIBLE_CHILD_ACTIVITY_ENTRIES);
    // A tail page of every kind of entry: none is filtered out, so the newest three are shown.
    const types = ["user_message", "reasoning", "tool_call", "assistant_message", "todo", "error", "notification", "compaction"];
    const page = types.map((type, index) => ({ seqStart: 100 + index, seqEnd: 100 + index, item: { type } }));
    const shown = recentChildTimelineEntries(page).slice(-MAX_VISIBLE_CHILD_ACTIVITY_ENTRIES);
    expect(shown.map((entry) => entry.item.type)).toEqual(["error", "notification", "compaction"]);
  });

  it("holds reads for a child that is not loaded or not known, in the background, and off screen", () => {
    const hold = (status: string | null, foreground = true, visibility: Parameters<typeof childFeedHold>[0]["visibility"] = "visible") =>
      childFeedHold({ status, foreground, visibility });
    expect(hold("running")).toBeNull();
    expect(hold("idle")).toBeNull();
    expect(hold("initializing")).toBeNull();
    expect(hold("error")).toBeNull();
    // 0.11: closed = not loaded; reading its timeline would load it.
    expect(hold("closed")).toBe("closed");
    expect(hold(null)).toBe("unknown");
    expect(hold("archived")).toBe("unknown");
    expect(hold("running", false)).toBe("background");
    expect(hold("running", true, "hidden")).toBe("offscreen");
    // Web says nothing until the browser has answered; native cannot tell and goes by foreground only.
    expect(hold("running", true, "pending")).toBe("offscreen");
    expect(hold("running", true, "unsupported")).toBeNull();
    // Not loaded wins over everything else, so the card can say why.
    expect(hold("closed", false, "hidden")).toBe("closed");
  });

  /** Runs events through the state machine and counts the reads it asks for; reads finish at once unless `pending`. */
  function run(hold: ChildFeedHold, events: Array<ChildFeedEvent | "finish">, pending = false) {
    const start = childFeedStart(hold);
    let state: ChildFeedState = start.state;
    let reads = start.read ? 1 : 0;
    let inFlight: number | null = start.read ? state.version : null;
    if (start.read && !pending) {
      state = childFeedStep(state, { type: "read", version: inFlight! }).state;
      inFlight = null;
    }
    for (const event of events) {
      if (event === "finish") {
        if (inFlight !== null) state = childFeedStep(state, { type: "read", version: inFlight }).state;
        inFlight = null;
        continue;
      }
      const step = childFeedStep(state, event);
      state = step.state;
      if (!step.read) continue;
      reads += 1;
      inFlight = state.version;
      if (!pending) {
        state = childFeedStep(state, { type: "read", version: inFlight }).state;
        inFlight = null;
      }
    }
    return { reads, state, dirty: childFeedDirty(state) };
  }

  it("reads at once when it may, and on every live event while it listens", () => {
    expect(run(null, []).reads).toBe(1);
    expect(run(null, [{ type: "event" }, { type: "event" }]).reads).toBe(3);
    // Host Agent updates now drive refreshes without a child timeline subscription.
    expect(run(null, [{ type: "changed" }]).reads).toBe(2);
  });

  it("never reads a closed child by itself, only when the user asks, and then once", () => {
    const closed = run("closed", [{ type: "changed" }, { type: "event" }, { type: "hold", hold: "closed", running: false }]);
    expect(closed.reads).toBe(0);
    expect(run("closed", [{ type: "manual" }]).reads).toBe(1);
    expect(run("unknown", [{ type: "manual" }]).reads).toBe(1);
    // Read on request, the child is loaded now: the card starts listening without reading again.
    expect(run("closed", [{ type: "manual" }, { type: "hold", hold: null, running: false }]).reads).toBe(1);
  });

  it("catches up once after the background or off screen if the child kept running", () => {
    const result = run(null, [
      { type: "hold", hold: "background", running: true },
      { type: "changed" },
      { type: "hold", hold: "offscreen", running: true },
      { type: "hold", hold: null, running: true },
    ]);
    expect(result.reads).toBe(2);
    expect(result.dirty).toBe(false);
  });

  it("does not read again on return when nothing changed while it was away", () => {
    expect(run(null, [{ type: "hold", hold: "offscreen", running: false }, { type: "hold", hold: null, running: false }]).reads).toBe(1);
    // ...but does when the app's copy of the child changed meanwhile (it finished, say).
    expect(run(null, [{ type: "hold", hold: "background", running: false }, { type: "changed" }, { type: "hold", hold: null, running: false }]).reads).toBe(2);
  });

  it("waits for the screen before the first read", () => {
    const result = run("offscreen", [{ type: "event" }, { type: "hold", hold: null, running: false }]);
    expect(result.reads).toBe(1);
  });

  it("trusts its own status check over the app's agent list when it says the child is gone or closed", () => {
    // Before the card has checked, the list speaks.
    expect(childStatus({ heard: false, agent: null, listed: "running" })).toBe("running");
    expect(childStatus({ heard: false, agent: null, listed: null })).toBeNull();
    // Archived while the card was open: the list keeps a stale "running" copy; the daemon does not know it any more...
    expect(childStatus({ heard: true, agent: null, listed: "running" })).toBeNull();
    // ...or has it archived (closed, whatever status the record carries) or closed.
    expect(childStatus({ heard: true, agent: { status: "idle", archivedAt: "2026-01-01T00:00:00.000Z" }, listed: "running" })).toBe("closed");
    expect(childStatus({ heard: true, agent: { status: "closed", archivedAt: null }, listed: "idle" })).toBe("closed");
    // A loaded child: the list is live, so its newer status wins.
    expect(childStatus({ heard: true, agent: { status: "running", archivedAt: null }, listed: "idle" })).toBe("idle");
    expect(childStatus({ heard: true, agent: { status: "running", archivedAt: null }, listed: null })).toBe("running");
    // 0.6.0 (codex-F18): the server's summary reports a child the daemon has not loaded as closed (childLoaded below), and
    // that wins over the list's stale running.
    expect(childStatus({ heard: true, agent: { status: "closed" }, listed: "running" })).toBe("closed");
    expect(childReadable("idle")).toBe(true);
    expect(childReadable("closed")).toBe(false);
    expect(childReadable(null)).toBe(false);
  });

  it("counts only a live record as loaded (0.6.0, codex-F18)", () => {
    expect(childLoaded({ status: "idle", activeTurn: null })).toBe(true);
    expect(childLoaded({ status: "running", activeTurn: { turnId: "t1", startedAt: null } })).toBe(true);
    expect(childLoaded({ status: "running" })).toBe(false);
    expect(childLoaded(null)).toBe(false);
    expect(childLoaded(undefined)).toBe(false);
  });

  it("checks with the daemon before every read it starts by itself, not before a read the user asked for", () => {
    expect(childFeedStart(null)).toMatchObject({ read: true, verify: true });
    const away = childFeedStep(childFeedStart(null).state, { type: "hold", hold: "background", running: true });
    expect(childFeedStep(away.state, { type: "hold", hold: null, running: true })).toMatchObject({ read: true, verify: true });
    // Live events too: a child archived while the card listens still sends its last ones.
    expect(childFeedStep(childFeedStart(null).state, { type: "event" })).toMatchObject({ read: true, verify: true });
    expect(childFeedStep(childFeedStart("closed").state, { type: "manual" })).toMatchObject({ read: true, verify: false });
    // Bursts of live events are read together.
    expect(CHILD_EVENT_READ_DELAY_MS).toBeGreaterThan(0);
    expect(CHILD_EVENT_READ_DELAY_MS).toBeGreaterThanOrEqual(5000);
  });

  it("only asks for the status of a closed or unknown child whose copy in the app changed", () => {
    expect(childFeedStep(childFeedStart("closed").state, { type: "changed" })).toMatchObject({ read: false, check: true });
    expect(childFeedStep(childFeedStart("unknown").state, { type: "changed" })).toMatchObject({ read: false, check: true });
    expect(childFeedStep(childFeedStart("background").state, { type: "changed" })).toMatchObject({ read: false, check: false });
    expect(childFeedStep(childFeedStart(null).state, { type: "changed" })).toMatchObject({ read: true, check: false });
  });

  it("keeps news that came in while a read was on its way", () => {
    // The read starts, the card goes off screen with the child running, then the read lands: still behind.
    const result = run(null, [{ type: "hold", hold: "offscreen", running: true }, "finish"], true);
    expect(result.dirty).toBe(true);
    expect(run(null, [{ type: "hold", hold: "offscreen", running: true }, "finish", { type: "hold", hold: null, running: true }], true).reads).toBe(2);
  });
});
