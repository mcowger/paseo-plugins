import assert from "node:assert/strict";
import test from "node:test";
import {
  bindPill,
  PILL_REFRESH_MS,
  samePillView,
  type PillPreferences,
  type PillRegistration,
  type PillView,
} from "./pill";
import { createAgentSpeedStore } from "./store";
import type { TeamView } from "./team";

function defaultPrefs(overrides: Partial<PillPreferences> = {}): PillPreferences {
  return {
    liveWindowSec: 2,
    numerator: "live",
    showIdlePills: false,
    tokenFormat: "compact",
    maxPlausibleTokPerSec: 400,
    ...overrides,
  };
}

function makeHarness(opts: {
  prefs?: PillPreferences;
  team?: () => TeamView | null;
} = {}) {
  let clock = 10_000;
  let prefs = opts.prefs ?? defaultPrefs();
  let teamCalls = 0;
  const registered: PillView[] = [];
  const updates: PillView[] = [];
  let removed = 0;

  const store = createAgentSpeedStore({
    agentId: "agent-1",
    charsPerToken: () => 4,
    learnedCharsPerToken: () => undefined,
    onCalibration: () => undefined,
    cacheCounting: () => "auto",
    now: () => clock,
  });

  const register = (initial: PillView): PillRegistration => {
    registered.push(initial);
    return {
      update(patch) {
        updates.push(patch);
      },
      remove() {
        removed += 1;
      },
    };
  };

  const getTeam = () => {
    teamCalls += 1;
    return opts.team ? opts.team() : null;
  };

  const bind = () => bindPill(register, store, () => prefs, () => clock, getTeam);

  return {
    store,
    registered,
    updates,
    get removed() {
      return removed;
    },
    get teamCalls() {
      return teamCalls;
    },
    get clock() {
      return clock;
    },
    setClock(at: number) {
      clock = at;
    },
    advanceClock(ms: number) {
      clock += ms;
    },
    setPrefs(next: PillPreferences) {
      prefs = next;
    },
    bind,
  };
}

test("samePillView compares presentation fields", () => {
  const base: PillView = { label: "40", visible: true, title: "Turn speed 40 tok/s decode" };
  assert.equal(samePillView(base, { ...base }), true);
  assert.equal(samePillView(base, { ...base, label: "41" }), false);
  assert.equal(samePillView(base, { ...base, visible: false }), false);
  assert.equal(samePillView(base, { ...base, title: "Turn speed" }), false);
});

test("idle pill registers once with zero updates, no heartbeat and no team lookup", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = makeHarness();
  const handle = h.bind();

  assert.equal(h.registered.length, 1);
  assert.equal(h.registered[0].visible, false);
  assert.equal(h.updates.length, 0);
  assert.equal(h.teamCalls, 0);

  // Idle pills must stay completely silent across any number of heartbeat windows.
  for (let i = 0; i < 10; i += 1) {
    h.advanceClock(PILL_REFRESH_MS);
    t.mock.timers.tick(PILL_REFRESH_MS);
  }
  assert.equal(h.updates.length, 0);
  assert.equal(h.teamCalls, 0);

  handle.destroy();
  assert.equal(h.removed, 1);
});

test("heartbeat runs only while a turn is running and skips unchanged ticks", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = makeHarness();
  const handle = h.bind();

  // Turn starts: immediate paint and heartbeat starts.
  h.store.dispatch({ t: "turn_started", at: h.clock, turnId: "t1" });
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].visible, true);
  assert.ok(h.teamCalls >= 1);

  // Before any tokens arrive, repeated heartbeat ticks produce the same view
  // and must not call registration.update() again.
  h.advanceClock(PILL_REFRESH_MS);
  t.mock.timers.tick(PILL_REFRESH_MS);
  h.advanceClock(PILL_REFRESH_MS);
  t.mock.timers.tick(PILL_REFRESH_MS);
  assert.equal(h.updates.length, 1);

  // Streaming text changes the displayed estimate, triggering an update.
  h.store.dispatch({ t: "text", at: h.clock, key: "m1", text: "a".repeat(200) });
  h.advanceClock(PILL_REFRESH_MS);
  h.store.dispatch({ t: "text", at: h.clock, key: "m1", text: "a".repeat(400) });
  t.mock.timers.tick(PILL_REFRESH_MS);
  const updatesWhileRunning = h.updates.length;
  assert.ok(updatesWhileRunning >= 2);
  assert.match(h.updates[updatesWhileRunning - 1].label, /^\d+(?:\.\d+)?$/);
  assert.equal("icon" in h.updates[updatesWhileRunning - 1], false);

  // Turn ends: immediate final paint, heartbeat stops.
  h.advanceClock(200);
  h.store.dispatch({ t: "turn_ended", at: h.clock, kind: "completed", turnId: "t1" });
  const updatesAfterEnd = h.updates.length;
  assert.equal(updatesAfterEnd, updatesWhileRunning + 1);

  const teamCallsAfterEnd = h.teamCalls;
  for (let i = 0; i < 10; i += 1) {
    h.advanceClock(PILL_REFRESH_MS);
    t.mock.timers.tick(PILL_REFRESH_MS);
  }
  assert.equal(h.updates.length, updatesAfterEnd);
  assert.equal(h.teamCalls, teamCallsAfterEnd);

  handle.destroy();
});

test("mid-turn bind starts heartbeat immediately without a redundant mount update", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let subRunning = 1;
  const h = makeHarness({
    team: () => ({
      members: [],
      running: subRunning,
      liveTokPerSec: null,
      estTokens: 0,
      approx: true,
    }),
  });
  h.store.dispatch({ t: "turn_started", at: h.clock, turnId: "t1" });

  const handle = h.bind();
  assert.equal(h.registered.length, 1);
  assert.match(h.registered[0].title, /1 sub/);
  assert.equal(h.registered[0].label, "—");
  assert.equal(h.updates.length, 0);

  // Heartbeat picks up a change in subagent count without a store event.
  subRunning = 2;
  h.advanceClock(PILL_REFRESH_MS);
  t.mock.timers.tick(PILL_REFRESH_MS);
  assert.equal(h.updates.length, 1);
  assert.match(h.updates[0].title, /2 sub/);
  assert.equal(h.updates[0].label, "—");

  handle.destroy();
});

test("refresh repaints when preferences change the pill and skips no-op preference changes", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = makeHarness({ prefs: defaultPrefs({ showIdlePills: false }) });
  const handle = h.bind();
  assert.equal(h.registered[0].visible, false);

  // Unrelated preference change on an idle pill produces no update.
  h.setPrefs(defaultPrefs({ showIdlePills: false, numerator: "turn" }));
  handle.refresh();
  assert.equal(h.updates.length, 0);

  // Toggling showIdlePills updates the idle pill immediately.
  h.setPrefs(defaultPrefs({ showIdlePills: true }));
  handle.refresh();
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].visible, true);

  // Switching speed basis on a completed turn updates the pill immediately.
  h.store.dispatch({ t: "turn_started", at: h.clock, turnId: "t1" });
  h.advanceClock(1000);
  h.store.dispatch({ t: "text", at: h.clock, key: "m1", text: "a".repeat(400) });
  h.advanceClock(1000);
  h.store.dispatch({
    t: "usage",
    at: h.clock,
    usage: { input: 100, output: 100 },
  });
  h.advanceClock(3000);
  h.store.dispatch({ t: "turn_ended", at: h.clock, kind: "completed", turnId: "t1" });
  const beforeBasisSwitch = h.updates.length;
  const decodeLabel = h.updates[beforeBasisSwitch - 1].label;

  h.setPrefs(defaultPrefs({ showIdlePills: true, numerator: "turn" }));
  handle.refresh();
  assert.equal(h.updates.length, beforeBasisSwitch + 1);
  assert.notEqual(h.updates[h.updates.length - 1].label, decodeLabel);

  handle.destroy();
});

test("destroy stops timers and ignores later refresh or store events", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = makeHarness();
  const handle = h.bind();

  h.store.dispatch({ t: "turn_started", at: h.clock, turnId: "t1" });
  // Queue a throttled pendingTimer right after a paint.
  h.advanceClock(100);
  h.store.dispatch({ t: "text", at: h.clock, key: "m1", text: "hello world" });
  const beforeDestroy = h.updates.length;

  handle.destroy();
  handle.destroy(); // idempotent
  assert.equal(h.removed, 1);

  h.setPrefs(defaultPrefs({ showIdlePills: true }));
  handle.refresh();
  h.advanceClock(PILL_REFRESH_MS);
  t.mock.timers.tick(PILL_REFRESH_MS);
  h.store.dispatch({ t: "turn_ended", at: h.clock, kind: "completed", turnId: "t1" });
  assert.equal(h.updates.length, beforeDestroy);
});

test("a call in flight pauses the pill and says what it is waiting on", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = makeHarness();
  const handle = h.bind();

  h.store.dispatch({ t: "turn_started", at: h.clock, turnId: "t1" });

  // A tool run is identified in the accessible title rather than the label.
  h.advanceClock(PILL_REFRESH_MS);
  h.store.dispatch({ t: "tool_started", at: h.clock });
  const during = h.updates[h.updates.length - 1];
  assert.match(during.title, /tool running/);

  h.advanceClock(PILL_REFRESH_MS);
  h.store.dispatch({ t: "tool_ended", at: h.clock });
  const after = h.updates[h.updates.length - 1];
  assert.doesNotMatch(after.title, /tool running/);

  handle.destroy();
});

test("a user wait remains visible while a tool is running", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = makeHarness();
  const handle = h.bind();
  h.store.dispatch({ t: "turn_started", at: h.clock, turnId: "t1" });
  h.advanceClock(PILL_REFRESH_MS);
  h.store.dispatch({ t: "tool_started", at: h.clock });
  h.advanceClock(PILL_REFRESH_MS);
  h.store.dispatch({ t: "user_wait_started", at: h.clock });
  const view = h.updates[h.updates.length - 1];
  // Still a live turn: the label keeps the rate it parked on.
  assert.equal(view.visible, true);
  handle.destroy();
});
