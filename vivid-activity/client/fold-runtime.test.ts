import { describe, expect, it } from "vitest";
import { SHOW, type FoldRole } from "../shared/fold";
import type { FoldIndexInput, FoldIndexOutput, WireRow } from "../shared/fold-index";
import { createFoldRuntime, FOLD_MEMORY, FOLD_TIMING, trimOldest } from "./fold-runtime";

/** Injected clock: every timer of the runtime runs here, never on the real one. */
function fakeClock() {
  let time = 1_000_000;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const settle = async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  };
  return {
    now: () => time,
    setTimer: (run: () => void, ms: number) => {
      const handle = ++next;
      timers.set(handle, { at: time + ms, run });
      return handle;
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    async advance(ms: number) {
      const end = time + ms;
      await settle();
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].run();
        await settle();
      }
      time = end;
      await settle();
    },
    pending: () => timers.size,
  };
}

/** A projected timeline as the plugin server reports it: rows keep their start seq, updates bump a revision seq. */
function fakeTimeline(epoch = "e1") {
  let seq = 0;
  const rows: Array<{ row: WireRow; revision: number }> = [];
  let running: boolean | null = true;
  let reset = false;
  const page = (subset: typeof rows, extra: Partial<FoldIndexOutput> = {}): FoldIndexOutput => ({
    status: "ok",
    epoch,
    rows: subset.map((entry) => entry.row),
    startCursor: rows.length ? { epoch, seq: rows[0]!.row.s } : null,
    endCursor: { epoch, seq },
    hasOlder: false,
    hasNewer: false,
    reset: false,
    running,
    ...extra,
  });
  return {
    calls: [] as FoldIndexInput[],
    append(row: Omit<WireRow, "s" | "at">) {
      const s = ++seq;
      rows.push({ row: { s, at: s * 1000, ...row } as WireRow, revision: s });
      return s;
    },
    update(s: number, patch: Partial<WireRow>) {
      const entry = rows.find((candidate) => candidate.row.s === s)!;
      entry.row = { ...entry.row, ...patch };
      entry.revision = ++seq;
    },
    setRunning(value: boolean | null) {
      running = value;
    },
    resetNext() {
      reset = true;
    },
    async rpc(this: { calls: FoldIndexInput[] }, input: FoldIndexInput): Promise<FoldIndexOutput> {
      this.calls.push(input);
      if (input.direction === "tail") return page(rows);
      if (reset) {
        reset = false;
        return page([], { reset: true });
      }
      const after = input.cursor?.seq ?? 0;
      return page(rows.filter((entry) => entry.revision > after));
    },
  };
}

const user = { k: "b", w: "user_message" } as const;
const text = { k: "b", w: "assistant_message" } as const;
const shell = (callId: string, st: WireRow["st"] = "completed") => ({ k: "t", key: `t:${callId}`, st, look: "shell" }) as const;

function setup() {
  const clock = fakeClock();
  const timeline = fakeTimeline();
  let nudges = 0;
  const runtime = createFoldRuntime();
  runtime.configure({ rpc: (input) => timeline.rpc(input), nudge: () => void nudges++, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  /** What Paseo does while projecting: ask every drawn row for its role. */
  const project = (...keys: string[]) => {
    const roles: Record<string, FoldRole["kind"]> = {};
    for (const key of keys) {
      const role = runtime.roleFor(key);
      runtime.markProjected(key, role);
      roles[key] = role.kind;
    }
    return roles;
  };
  return { clock, timeline, runtime, project, nudges: () => nudges };
}

describe("fold runtime timings", () => {
  it("estimates when each row ran, keeps unchanged timings stable, and runs on the daemon's clock", async () => {
    const { clock, timeline, runtime } = setup();
    const original = timeline.rpc.bind(timeline);
    timeline.rpc = async (input) => ({ ...(await original(input)), now: clock.now() + 7_000 });
    timeline.append(user); // s1 at 1000
    timeline.append({ k: "r", key: "r:think" }); // s2 at 2000
    const bash = timeline.append(shell("a", "running")); // s3 at 3000
    let heard = 0;
    const unsubscribe = runtime.subscribeTimings("agent-1", () => void heard++);
    runtime.acquire("agent-1");
    await clock.advance(0);
    expect(runtime.timing("agent-1", "r:think")).toEqual({ start: 1000, end: 2000, running: false, witnessed: false });
    const running = runtime.timing("agent-1", "t:a");
    expect(running).toEqual({ start: 2000, end: 3000, running: true, witnessed: true });
    expect(heard).toBe(1);
    expect(runtime.serverNow() - clock.now()).toBe(7_000);
    // The next live row starts where the last finished entry ended (the running call is not finished).
    expect(runtime.tailStart("agent-1")).toBe(2000);
    // Text arrives: the running call keeps its timing object; only the tail estimate moves.
    timeline.append(text);
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.timing("agent-1", "t:a")).toBe(running);
    expect(runtime.tailStart("agent-1")).toBe(4000);
    expect(heard).toBe(2);
    timeline.update(bash, { st: "completed", at: 9000 });
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.timing("agent-1", "t:a")).toEqual({ start: 2000, end: 9000, running: false, witnessed: true });
    expect(heard).toBe(3);
    unsubscribe();
  });
});

describe("fold runtime", () => {
  it("reads the tail when the first row mounts, folds finished runs and re-projects once", async () => {
    const { clock, timeline, runtime, project, nudges } = setup();
    timeline.append(user);
    timeline.append(shell("a"));
    timeline.append(shell("b"));
    timeline.append(shell("c"));
    timeline.append(text);
    timeline.setRunning(false);
    expect(project("t:a", "t:b", "t:c")).toEqual({ "t:a": "show", "t:b": "show", "t:c": "show" });
    runtime.acquire("agent-1");
    await clock.advance(0);
    expect(timeline.calls).toEqual([{ agentId: "agent-1", direction: "tail", limit: FOLD_TIMING.tailLimit }]);
    expect(runtime.roleFor("t:a").kind).toBe("fold");
    expect(runtime.roleFor("t:b").kind).toBe("hide");
    expect(nudges()).toBe(0);
    await clock.advance(FOLD_TIMING.delay.soon);
    expect(nudges()).toBe(1);
    // Paseo projects again with the new roles; nothing changed since, so no further re-projection.
    expect(project("t:a", "t:b", "t:c")).toEqual({ "t:a": "fold", "t:b": "hide", "t:c": "hide" });
    await clock.advance(10_000);
    expect(nudges()).toBe(1);
  });

  it("reads only the increment after rows, messages or state changes; pokes coalesce", async () => {
    const { clock, timeline, runtime } = setup();
    timeline.append(user);
    const a = timeline.append(shell("a", "running"));
    runtime.acquire("agent-1");
    await clock.advance(0);
    timeline.update(a, { st: "completed" });
    timeline.append(text);
    for (let index = 0; index < 5; index++) runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(timeline.calls.map((call) => call.direction)).toEqual(["tail", "after"]);
    expect(timeline.calls[1]!.cursor).toEqual({ epoch: "e1", seq: 2 });
    runtime.noteRow("agent-1", "t:a", "completed", 2000);
    runtime.noteRow("agent-1", "t:new", "running", 9000);
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(timeline.calls.map((call) => call.direction)).toEqual(["tail", "after", "after"]);
  });

  it("plans a repeat notice the way the transformer decided it (0.6.0-local.3)", async () => {
    const { clock, timeline, runtime, project } = setup();
    timeline.append(user);
    timeline.append(shell("a"));
    // The index kept the notice (it could not compare results); the client then saw both rows say the same.
    timeline.append({ k: "t", key: "t:n", st: "completed", look: "shell", ref: "a", fg: false });
    timeline.append(shell("b"));
    timeline.setRunning(true);
    project("t:a", "t:n", "t:b");
    runtime.acquire("agent-1");
    await clock.advance(1_000);
    expect(runtime.roleFor("t:n").kind).toBe("show");
    runtime.noteNotice("t:n", true);
    await clock.advance(1_000);
    expect(runtime.roleFor("t:n").kind).toBe("hide");
    runtime.noteNotice("t:n", false);
    await clock.advance(1_000);
    expect(runtime.roleFor("t:n").kind).toBe("show");
  });

  it("re-projects a toggle at once and remembers it", async () => {
    const { clock, timeline, runtime, project, nudges } = setup();
    timeline.append(user);
    const first = timeline.append(shell("a"));
    timeline.append(shell("b"));
    timeline.append(text);
    timeline.setRunning(false);
    project("t:a", "t:b");
    runtime.acquire("agent-1");
    await clock.advance(1_000);
    project("t:a", "t:b");
    const before = nudges();
    runtime.toggle("agent-1", String(first), true);
    await clock.advance(0);
    expect(nudges()).toBe(before + 1);
    expect(runtime.isExpanded("agent-1", String(first))).toBe(true);
    const role = runtime.roleFor("t:a");
    expect(role.kind === "fold" && role.summary.expanded).toBe(true);
    expect(runtime.roleFor("t:b")).toEqual(SHOW);
  });

  it("throttles background re-projections of a live run", async () => {
    const { clock, timeline, runtime, project, nudges } = setup();
    timeline.append(user);
    for (const id of ["a", "b", "c", "d"]) timeline.append(shell(id));
    project("t:a", "t:b", "t:c", "t:d");
    runtime.acquire("agent-1");
    await clock.advance(1_000);
    expect(nudges()).toBe(1);
    project("t:a", "t:b", "t:c", "t:d");
    // A new row arrives: one more earlier step, a background re-projection, not before the 2.5 s gap.
    timeline.append(shell("e"));
    project("t:e");
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay + 100);
    expect(nudges()).toBe(1);
    await clock.advance(FOLD_TIMING.minGap.auto);
    expect(nudges()).toBe(2);
  });

  it("restores every row when folding is turned off, and folds nothing in 关闭", async () => {
    const { clock, timeline, runtime, project, nudges } = setup();
    timeline.append(user);
    timeline.append(shell("a"));
    timeline.append(shell("b"));
    timeline.append(text);
    timeline.setRunning(false);
    project("t:a", "t:b");
    runtime.acquire("agent-1");
    await clock.advance(1_000);
    project("t:a", "t:b");
    const before = nudges();
    runtime.setSettings({ enabled: false });
    await clock.advance(0);
    expect(runtime.roleFor("t:a")).toEqual(SHOW);
    expect(nudges()).toBe(before + 1);
    runtime.setSettings({ enabled: true, scope: "off" });
    expect(runtime.roleFor("t:a")).toEqual(SHOW);
    runtime.setSettings({ scope: "all" });
    expect(runtime.roleFor("t:a").kind).toBe("fold");
  });

  it("plans around a key two agents see differently, so neither loses its summary", async () => {
    const clock = fakeClock();
    const one = fakeTimeline("e1");
    const two = fakeTimeline("e2");
    const runtime = createFoldRuntime();
    runtime.configure({
      rpc: (input) => (input.agentId === "one" ? one.rpc(input) : two.rpc(input)),
      nudge: () => undefined,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const shared = { k: "r", key: "r:same" } as const;
    for (const timeline of [one, two]) {
      timeline.append(user);
      timeline.append(shared);
      timeline.setRunning(false);
    }
    one.append(shell("a"));
    one.append(text);
    two.append(shell("x"));
    two.append(shell("y"));
    two.append(text);
    for (const key of ["r:same", "t:a", "t:x", "t:y"]) runtime.markProjected(key, SHOW);
    runtime.acquire("one");
    runtime.acquire("two");
    await clock.advance(1_000);
    expect(runtime.roleFor("r:same")).toEqual(SHOW);
    expect(runtime.roleFor("t:a")).toEqual(SHOW);
    expect(runtime.roleFor("t:x").kind).toBe("fold");
    expect(runtime.roleFor("t:y").kind).toBe("hide");
  });

  it("retries a failed read (2 s, 5 s, 15 s) and re-reads the tail after a reset", async () => {
    const { clock, timeline, runtime } = setup();
    let fail = 2;
    const original = timeline.rpc.bind(timeline);
    timeline.rpc = async (input) => {
      if (fail-- > 0) {
        timeline.calls.push(input);
        throw new Error("offline");
      }
      return original(input);
    };
    timeline.append(user);
    runtime.acquire("agent-1");
    await clock.advance(0);
    expect(timeline.calls.length).toBe(1);
    await clock.advance(1_999);
    expect(timeline.calls.length).toBe(1);
    await clock.advance(1);
    expect(timeline.calls.length).toBe(2);
    await clock.advance(5_000);
    expect(timeline.calls.length).toBe(3);
    expect(runtime.debugAgent("agent-1")?.loaded).toBe(true);
    timeline.resetNext();
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(timeline.calls.slice(-2).map((call) => call.direction)).toEqual(["after", "tail"]);
  });

  it("checks rows that mounted before the first read, and stops polling after the last row leaves", async () => {
    const { clock, timeline, runtime } = setup();
    timeline.append(user);
    runtime.acquire("agent-1");
    runtime.noteRow("agent-1", "t:later", "running", 5_000);
    await clock.advance(0);
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(timeline.calls.map((call) => call.direction)).toEqual(["tail", "after"]);
    await clock.advance(FOLD_TIMING.pollMs);
    expect(timeline.calls.length).toBe(3);
    runtime.release("agent-1");
    await clock.advance(FOLD_TIMING.releaseGraceMs + FOLD_TIMING.pollMs * 2);
    const settled = timeline.calls.length;
    await clock.advance(FOLD_TIMING.pollMs * 4);
    expect(timeline.calls.length).toBe(settled);
    runtime.acquire("agent-1");
    await clock.advance(0);
    expect(timeline.calls.at(-1)?.direction).toBe("after");
  });

  it("forgets an Agent's index and roles once none of its rows has been on screen for forgetMs (0.4.1)", async () => {
    const { clock, timeline, runtime, project, nudges } = setup();
    timeline.append(user);
    timeline.append(shell("a"));
    timeline.append(shell("b"));
    timeline.append(text);
    timeline.setRunning(false);
    project("t:a", "t:b");
    runtime.acquire("agent-1");
    await clock.advance(1_000);
    expect(project("t:a", "t:b")).toEqual({ "t:a": "fold", "t:b": "hide" });
    const nudged = nudges();
    runtime.release("agent-1");
    // Coming back within the window finds the folds in place: no flash of unfolded rows, only an incremental read.
    await clock.advance(FOLD_TIMING.forgetMs - 1);
    expect(runtime.debugAgent("agent-1")).not.toBeNull();
    expect(runtime.roleFor("t:b").kind).toBe("hide");
    await clock.advance(1);
    expect(runtime.debugAgent("agent-1")).toBeNull();
    expect(runtime.roleFor("t:a")).toEqual(SHOW);
    expect(runtime.roleFor("t:b")).toEqual(SHOW);
    // Nothing of it is on screen, so nothing is drawn again, and no timer is left behind.
    expect(nudges()).toBe(nudged);
    expect(clock.pending()).toBe(0);
    // Back again: a fresh tail read folds it as before.
    runtime.acquire("agent-1");
    await clock.advance(0);
    expect(timeline.calls.at(-1)?.direction).toBe("tail");
    expect(runtime.roleFor("t:b").kind).toBe("hide");
  });

  it("tells onForget listeners which Agent it forgot, once, and not after they stop listening (0.5.0)", async () => {
    const { clock, timeline, runtime } = setup();
    timeline.append(user);
    timeline.append(shell("a"));
    timeline.setRunning(false);
    const forgotten: string[] = [];
    const stop = runtime.onForget((agentId) => void forgotten.push(agentId));
    runtime.onForget(() => {
      throw new Error("a failing listener does not keep the others from hearing");
    });
    const late: string[] = [];
    const stopLate = runtime.onForget((agentId) => void late.push(agentId));
    runtime.acquire("agent-1");
    await clock.advance(1_000);
    runtime.release("agent-1");
    await clock.advance(FOLD_TIMING.forgetMs - 1);
    expect(forgotten).toEqual([]);
    await clock.advance(1);
    expect(forgotten).toEqual(["agent-1"]);
    expect(late).toEqual(["agent-1"]);
    stop();
    stopLate();
    runtime.acquire("agent-1");
    await clock.advance(1_000);
    runtime.release("agent-1");
    await clock.advance(FOLD_TIMING.forgetMs);
    expect(forgotten).toEqual(["agent-1"]);
  });

  it("keeps an Agent that comes back in time, and one whose read is still running (0.4.1)", async () => {
    const { clock, timeline, runtime } = setup();
    timeline.append(user);
    timeline.append(shell("a"));
    runtime.acquire("agent-1");
    await clock.advance(0);
    runtime.release("agent-1");
    await clock.advance(FOLD_TIMING.forgetMs / 2);
    runtime.acquire("agent-1");
    await clock.advance(0);
    expect(timeline.calls.at(-1)?.direction).toBe("after");
    runtime.release("agent-1");
    await clock.advance(FOLD_TIMING.forgetMs / 2 + 1);
    expect(runtime.debugAgent("agent-1")).not.toBeNull();
    // A read that hangs past the window: the Agent is forgotten only after it has settled.
    let finish: () => void = () => {};
    const original = timeline.rpc.bind(timeline);
    timeline.rpc = (input) => new Promise((resolve) => {
      finish = () => void original(input).then(resolve);
    });
    runtime.acquire("agent-1");
    await clock.advance(0);
    runtime.release("agent-1");
    await clock.advance(FOLD_TIMING.forgetMs);
    expect(runtime.debugAgent("agent-1")).not.toBeNull();
    finish();
    await clock.advance(FOLD_TIMING.releaseGraceMs);
    expect(runtime.debugAgent("agent-1")).toBeNull();
  });

  it("starts a live row of an autonomous turn at that turn's start, not at the last turn's reply (0.3.0-local.3)", async () => {
    const { clock, runtime } = setup();
    const HOUR = 3_600_000;
    let active: FoldIndexOutput["active"] = null;
    let rows: WireRow[] = [
      { s: 1, at: 10_000, k: "b", w: "user_message", u: 0 },
      { s: 2, at: 12_000, k: "r", key: "r:a", u: 0 },
      { s: 3, at: 30_000, k: "b", w: "assistant_message", u: 0 },
    ];
    let turns: NonNullable<FoldIndexOutput["turns"]> = [{ id: "foreground-turn-31", at: null }];
    const calls: string[] = [];
    runtime.configure({
      rpc: async (input) => {
        calls.push(input.direction);
        return { status: "ok", epoch: "e1", rows, startCursor: { epoch: "e1", seq: 1 }, endCursor: { epoch: "e1", seq: rows.length }, hasOlder: false, hasNewer: false, reset: false, running: active !== null, now: clock.now(), turns, active };
      },
      nudge: () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    runtime.acquire("agent-1");
    await clock.advance(0);
    // Idle: no running turn, so nothing to time a live row from.
    expect(runtime.tailStart("agent-1")).toBeNull();
    // An hour later Claude Code wakes up by itself: the read reports the running turn and its start.
    active = { id: "autonomous-turn-32", at: HOUR + 29_000 };
    runtime.setRunning("agent-1", true);
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.tailStart("agent-1")).toBe(HOUR + 29_000);
    // Its first reasoning lands: the next row starts when that ended, and the reasoning starts at the turn's start.
    rows = [...rows, { s: 4, at: HOUR + 33_000, k: "r", key: "r:b", u: 1 }];
    turns = [{ id: "foreground-turn-31", at: null }, { id: "autonomous-turn-32", at: HOUR + 29_000 }];
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.timing("agent-1", "r:b")).toMatchObject({ start: HOUR + 29_000, end: HOUR + 33_000 });
    expect(runtime.tailStart("agent-1")).toBe(HOUR + 33_000);
    expect(calls[0]).toBe("tail");
  });

  it("stops asking about an Agent the daemon does not have (a provider subagent's own view)", async () => {
    const { clock, runtime } = setup();
    const calls: string[] = [];
    runtime.configure({
      rpc: async (input) => {
        calls.push(input.direction);
        return { status: "missing", epoch: "", rows: [], startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, reset: false, running: null };
      },
      nudge: () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const subagent = "provider:6f1c2d3e:toolu_01";
    runtime.acquire(subagent);
    runtime.noteRow(subagent, "t:x", "running", 1_000);
    await clock.advance(0);
    await clock.advance(FOLD_TIMING.pollMs * 6);
    runtime.poke();
    runtime.setRunning(subagent, true);
    runtime.noteRow(subagent, "t:y", "completed", 2_000);
    await clock.advance(FOLD_TIMING.pollMs * 6);
    expect(calls).toEqual([]);
    expect(runtime.roleFor("t:x")).toBe(SHOW);
    expect(runtime.timing(subagent, "t:x")).toBeNull();
  });
});

describe("fold runtime memory over a long session (0.5.0)", () => {
  /** A runtime whose single Agent answers with `page()`; `epoch` and the rows can change between reads. */
  function scripted() {
    const clock = fakeClock();
    const runtime = createFoldRuntime();
    let nudges = 0;
    const state = {
      epoch: "e1",
      rows: [] as WireRow[],
      turns: [] as NonNullable<FoldIndexOutput["turns"]>,
      active: null as FoldIndexOutput["active"],
      reset: false,
      tok: undefined as FoldIndexOutput["tok"],
    };
    runtime.configure({
      rpc: async (input) => {
        const reset = state.reset && input.direction !== "tail";
        if (reset) state.reset = false;
        return {
          status: "ok", epoch: state.epoch, rows: reset ? [] : state.rows, startCursor: { epoch: state.epoch, seq: 1 },
          endCursor: { epoch: state.epoch, seq: state.rows.length + 1 }, hasOlder: false, hasNewer: false, reset,
          running: true, turns: state.turns, active: state.active, ...(state.tok ? { tok: state.tok } : {}),
        };
      },
      nudge: () => void nudges++,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    return { clock, runtime, state, nudges: () => nudges };
  }

  it("trims the older half of a set or map once it is full, like seen", () => {
    const set = new Set(Array.from({ length: 11 }, (_, index) => index));
    expect(trimOldest(set, 10)).toBe(true);
    expect([...set]).toEqual([5, 6, 7, 8, 9, 10]);
    const map = new Map([["a", 1], ["b", 2]]);
    expect(trimOldest(map, 2)).toBe(false);
    expect([...map.keys()]).toEqual(["a", "b"]);
  });

  it("caps the rows seen running and the turn starts of one Agent, and drops what a fresh tail no longer needs", async () => {
    const { clock, runtime, state } = scripted();
    const many = FOLD_MEMORY.witnessed + 500;
    state.rows = Array.from({ length: many }, (_, index) => ({ s: index + 1, at: 1000 + index, k: "t", key: `t:c${index}`, st: "running", look: "shell", u: index % 3000 }) as WireRow);
    state.turns = Array.from({ length: 3000 }, (_, index) => ({ id: `turn-${index}`, at: 500 + index }));
    runtime.acquire("agent-1");
    await clock.advance(0);
    expect(runtime.debugMemory("agent-1").witnessed).toBeLessThanOrEqual(FOLD_MEMORY.witnessed);
    expect(runtime.debugMemory("agent-1").turnStarts).toBeLessThanOrEqual(FOLD_MEMORY.turnStarts);
    // The newest are kept: the row running now still reads as seen running.
    expect(runtime.timing("agent-1", `t:c${many - 1}`)?.witnessed).toBe(true);
    // The history is read again from a short tail (same epoch): only its rows' running marks and turns stay.
    state.rows = [{ s: 1, at: 1000, k: "t", key: `t:c${many - 1}`, st: "running", look: "shell", u: 0 }];
    state.turns = [{ id: "turn-0", at: 500 }];
    state.reset = true;
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.debugMemory("agent-1")).toMatchObject({ witnessed: 1, turnStarts: 1 });
  });

  it("forgets turn ids and opened folds of an old history when the epoch changes", async () => {
    const { clock, runtime, state } = scripted();
    state.rows = [
      { s: 1, at: 1000, k: "b", w: "user_message", u: 0 },
      { s: 2, at: 2000, k: "t", key: "t:a", st: "completed", look: "shell", u: 0 },
      { s: 3, at: 3000, k: "t", key: "t:b", st: "completed", look: "shell", u: 0 },
    ];
    state.turns = [{ id: "foreground-turn-1", at: 900 }];
    runtime.acquire("agent-1");
    await clock.advance(0);
    runtime.toggle("agent-1", "2", true);
    expect(runtime.isExpanded("agent-1", "2")).toBe(true);
    // A reopened session counts turns from the start again: same id, a different turn without a known start.
    state.epoch = "e2";
    state.turns = [{ id: "foreground-turn-1", at: null }];
    state.reset = true;
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.debugMemory("agent-1")).toMatchObject({ turnStarts: 0, expanded: 0 });
    expect(runtime.isExpanded("agent-1", "2")).toBeUndefined();
    expect(runtime.timing("agent-1", "t:a")?.start).toBe(1000);
  });

  it("drops the tokens of an old history's turn ids when the epoch changes (0.8.0)", async () => {
    const { clock, runtime, state } = scripted();
    state.rows = [{ s: 1, at: 1000, k: "b", w: "user_message", u: 0 }, { s: 2, at: 2000, k: "t", key: "t:a", st: "completed", look: "shell", u: 0 }];
    state.turns = [{ id: "foreground-turn-1", at: 900 }];
    state.tok = [{ id: "foreground-turn-1", i: 6, c: 900, o: 40 }];
    runtime.acquire("agent-1");
    await clock.advance(0);
    expect(runtime.turnTokens("agent-1", "foreground-turn-1")).toMatchObject({ i: 6, o: 40 });
    let heard = 0;
    const unsubscribe = runtime.subscribeTokens("agent-1", () => void heard++);
    // Reloaded: the same id is a new turn the server has no figures for.
    state.epoch = "e2";
    state.tok = undefined;
    state.reset = true;
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.turnTokens("agent-1", "foreground-turn-1")).toBeNull();
    expect(heard).toBeGreaterThan(0);
    unsubscribe();
  });

  it("caps the folds one Agent remembers and drops them when the Agent is forgotten", async () => {
    const { clock, runtime, state } = scripted();
    state.rows = [{ s: 1, at: 1000, k: "b", w: "user_message" }];
    runtime.acquire("agent-1");
    await clock.advance(0);
    for (let index = 0; index < FOLD_MEMORY.expanded + 100; index++) runtime.toggle("agent-1", `seg-${index}`, index % 2 === 0);
    expect(runtime.debugMemory("agent-1").expanded).toBeLessThanOrEqual(FOLD_MEMORY.expanded);
    // The newest choice survives; the oldest went first.
    expect(runtime.isExpanded("agent-1", `seg-${FOLD_MEMORY.expanded + 98}`)).toBe(true);
    expect(runtime.isExpanded("agent-1", "seg-0")).toBeUndefined();
    // A toggle for an Agent the runtime does not know keeps nothing.
    runtime.toggle("stranger", "1", true);
    expect(runtime.debugMemory().expandedAgents).toBe(1);
    runtime.release("agent-1");
    await clock.advance(FOLD_TIMING.forgetMs);
    expect(runtime.debugAgent("agent-1")).toBeNull();
    expect(runtime.debugMemory()).toMatchObject({ agents: 0, expandedAgents: 0 });
  });

  it("caps the rows it asked about in vain", async () => {
    const { clock, runtime, state } = scripted();
    state.rows = [{ s: 1, at: 1000, k: "b", w: "user_message" }];
    runtime.acquire("agent-1");
    await clock.advance(0);
    for (let index = 0; index < FOLD_MEMORY.misses + 300; index++) runtime.noteRow("agent-1", `t:ghost-${index}`, "completed", 1000);
    expect(runtime.debugMemory("agent-1").misses).toBeLessThanOrEqual(FOLD_MEMORY.misses);
  });

  it("drops a contested key once no Agent left has it", async () => {
    const clock = fakeClock();
    const one = fakeTimeline("e1");
    const two = fakeTimeline("e2");
    const runtime = createFoldRuntime();
    runtime.configure({ rpc: (input) => (input.agentId === "one" ? one.rpc(input) : two.rpc(input)), nudge: () => undefined, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    for (const timeline of [one, two]) {
      timeline.append(user);
      timeline.append({ k: "r", key: "r:same" });
      timeline.setRunning(false);
    }
    one.append(shell("a"));
    one.append(text);
    two.append(shell("x"));
    two.append(shell("y"));
    two.append(text);
    for (const key of ["r:same", "t:a", "t:x", "t:y"]) runtime.markProjected(key, SHOW);
    runtime.acquire("one");
    runtime.acquire("two");
    await clock.advance(1_000);
    expect(runtime.debugMemory().contested).toBe(1);
    runtime.release("one");
    await clock.advance(FOLD_TIMING.forgetMs);
    // Still in the other Agent's index: still contested there.
    expect(runtime.debugMemory().contested).toBe(1);
    runtime.release("two");
    await clock.advance(FOLD_TIMING.forgetMs);
    expect(runtime.debugMemory()).toMatchObject({ agents: 0, contested: 0 });
  });

  it("re-projects after the drawn keys were trimmed, so rows on screen are recorded again", () => {
    const { runtime, nudges, clock } = scripted();
    for (let index = 0; index <= FOLD_TIMING.seenLimit; index++) runtime.markProjected(`t:k${index}`, SHOW);
    expect(runtime.debugMemory().seen).toBeLessThanOrEqual(FOLD_TIMING.seenLimit);
    return clock.advance(FOLD_TIMING.minGap.auto + FOLD_TIMING.delay.auto).then(() => expect(nudges()).toBe(1));
  });
});

describe("pinned question (0.6.0, grok-B2)", () => {
  it("pins the question above the newest drawn stretch, tells its rows when it moves, and drops it with the takeover", async () => {
    const { clock, timeline, runtime, project } = setup();
    timeline.append(user); // s1
    // Three rounds of 「做一段、说一句」: six blocks, about a screen (shared/prompt-pin.ts).
    for (const id of ["a", "b", "x"]) {
      timeline.append(shell(id));
      timeline.append({ ...text, ln: 3 });
    }
    const c = timeline.append(shell("c", "running")); // s8
    project("t:a", "t:b", "t:x", "t:c");
    let heard = 0;
    const stop = runtime.subscribePin("agent-1", () => void (heard += 1));
    runtime.acquire("agent-1");
    await clock.advance(0);
    expect(runtime.pin("agent-1")).toEqual({ key: "t:c", segment: String(c), fold: false, promptSeq: 1, sameTurn: false, turn: null });
    expect(runtime.epoch("agent-1")).toBe("e1");
    expect(heard).toBe(1);
    // It appeared (the chat opened): no entrance.
    expect(runtime.pinMovedAt("agent-1")).toBe(0);
    // Reading again without news keeps the same pin object, and nobody is told.
    const first = runtime.pin("agent-1");
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.pin("agent-1")).toBe(first);
    expect(heard).toBe(1);

    // The Agent reports back and starts a new stretch: the pin moves down to it.
    timeline.update(c, { st: "completed" });
    timeline.append(text);
    const d = timeline.append(shell("d", "running"));
    project("t:d");
    runtime.noteRow("agent-1", "t:d", "running", d * 1000);
    const asked = clock.now();
    // Reads of a running Agent stay at least `pokeDelay` apart (0.6.0-local.5, the lazy release's fold traffic budget).
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.pin("agent-1")).toMatchObject({ key: "t:d", segment: String(d), promptSeq: 1 });
    expect(heard).toBe(2);
    // Moved while you watch: the strip comes in with an entrance.
    expect(runtime.pinMovedAt("agent-1")).toBeGreaterThanOrEqual(asked);
    expect(runtime.pinMovedAt("agent-1")).toBeLessThanOrEqual(clock.now());

    // A new question: nothing to pin until the Agent is well into it.
    timeline.append(user);
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.pin("agent-1")).toBeNull();
    expect(heard).toBe(3);

    // 关闭接管: the plugin draws no rows, so nothing to pin.
    runtime.setSettings({ scope: "off" });
    expect(runtime.pin("agent-1")).toBeNull();
    stop();
  });
});

describe("fold request traffic", () => {
  it("keeps running reads at least two seconds apart even when new rows arrive rapidly", async () => {
    const { clock, timeline, runtime } = setup();
    timeline.append(user);
    const times: number[] = [];
    const read = timeline.rpc.bind(timeline);
    timeline.rpc = async (input) => { times.push(clock.now()); return read(input); };
    runtime.acquire("throttled");
    await clock.advance(0);
    for (let n = 0; n < 30; n++) {
      runtime.noteRow("throttled", `t:new-${n}`, "running", clock.now());
      runtime.poke();
      await clock.advance(100);
    }
    await clock.advance(2_000);
    expect(times.length).toBeGreaterThan(1);
    for (let n = 1; n < times.length; n++) expect(times[n]! - times[n - 1]!).toBeGreaterThanOrEqual(2_000);
  });

  it("does not let streaming pokes or new rows bypass an RPC failure backoff", async () => {
    const { clock, timeline, runtime } = setup();
    timeline.append(user);
    runtime.acquire("retry");
    await clock.advance(0);
    const times: number[] = [];
    timeline.rpc = async () => { times.push(clock.now()); throw new Error("Plugin is not available"); };
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    for (let n = 0; n < 90; n++) {
      runtime.poke();
      runtime.noteRow("retry", `t:retry-${n}`, "running", clock.now());
      await clock.advance(100);
    }
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBe(2_000);
    expect(times[2]! - times[1]!).toBe(5_000);
  });
});

describe("0.8.0: what a run changed and the turn's tokens", () => {
  it("keeps the tokens each answer reports, tells the rows showing them, and keeps the same object while they hold", async () => {
    const { clock, timeline, runtime } = setup();
    const original = timeline.rpc.bind(timeline);
    let tok: FoldIndexOutput["tok"] = [{ id: "turn-1", i: 10, c: 100, o: 5, live: true }];
    timeline.rpc = async (input) => ({ ...(await original(input)), tok });
    timeline.append(user);
    timeline.append(shell("a"));
    let heard = 0;
    const unsubscribe = runtime.subscribeTokens("agent-1", () => void heard++);
    runtime.acquire("agent-1");
    await clock.advance(0);
    const first = runtime.turnTokens("agent-1", "turn-1");
    expect(first).toEqual({ id: "turn-1", i: 10, c: 100, o: 5, live: true });
    expect(heard).toBe(1);
    // The same figures again: nothing to redraw.
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.turnTokens("agent-1", "turn-1")).toBe(first);
    expect(heard).toBe(1);
    // The sum grew, then froze when the turn ended.
    tok = [{ id: "turn-1", i: 12, c: 180, o: 9 }];
    timeline.append(text);
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.turnTokens("agent-1", "turn-1")).toEqual({ id: "turn-1", i: 12, c: 180, o: 9 });
    expect(heard).toBe(2);
    expect(runtime.turnTokens("agent-1", "turn-2")).toBeNull();
    unsubscribe();
  });

  it("plans again when a row's changed lines or exit code arrive, so the summary shows them", async () => {
    const { clock, timeline, runtime, project } = setup();
    timeline.append(user);
    const edit = timeline.append({ k: "t", key: "t:e", st: "completed", look: "edit" });
    timeline.append(shell("b", "failed"));
    timeline.append(text);
    timeline.setRunning(false);
    project("t:e", "t:b");
    runtime.acquire("agent-1");
    await clock.advance(0);
    const before = runtime.roleFor("t:e");
    expect(before.kind === "fold" && before.summary).toMatchObject({ files: 0, fails: [{ key: "t:b", exit: null }] });
    timeline.update(edit, { ch: [["f1", 4, 2]] });
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    const after = runtime.roleFor("t:e");
    expect(after.kind === "fold" && after.summary).toMatchObject({ files: 1, added: 4, removed: 2, changed: [{ key: "t:e", file: "f1", added: 4, removed: 2 }] });
  });
});
