import assert from "node:assert/strict";
import test from "node:test";
import { initialMeterState, reduceMeter, type MeterState } from "./meter";
import {
  reconcileSnapshot,
  turnStartFromEvent,
  turnStartFromSnapshot,
  type AgentTurnSnapshot,
} from "./lifecycle";

const T0 = Date.parse("2026-11-02T09:12:31.195Z");

/** Fold the reconciled actions the way the plugin dispatches them. */
function apply(state: MeterState, actions: ReturnType<typeof reconcileSnapshot>["actions"]): MeterState {
  return actions.reduce(reduceMeter, state);
}

function runningTurn(at = T0, turnId = "t1"): MeterState {
  return reduceMeter(initialMeterState(), { t: "turn_started", at, turnId });
}

function snapshot(overrides: AgentTurnSnapshot = {}): AgentTurnSnapshot {
  return { status: "running", activeTurn: { turnId: "t1", startedAt: new Date(T0).toISOString() }, ...overrides };
}

test("event start uses the daemon timestamp carried by the stream message", () => {
  assert.deepEqual(turnStartFromEvent("2026-11-02T09:12:31.195Z", T0 + 3), {
    at: T0,
    source: "event",
  });
});

test("event start never begins in the future", () => {
  assert.equal(turnStartFromEvent("2026-11-02T09:12:31.195Z", T0 - 2).at, T0 - 2);
});

test("event start ignores a timestamp too far ahead to be clock skew", () => {
  const arrivedAt = T0 - 30_000;
  assert.deepEqual(turnStartFromEvent("2026-11-02T09:12:31.195Z", arrivedAt), {
    at: arrivedAt,
    source: "arrival",
  });
});

test("event start falls back to arrival when there is no usable timestamp", () => {
  const arrivedAt = T0 + 120_000;
  for (const timestamp of [null, undefined, "", "not a date"]) {
    assert.deepEqual(turnStartFromEvent(timestamp, arrivedAt), {
      at: arrivedAt,
      source: "arrival",
    });
  }
});

test("snapshot start anchors a mid-turn attach to the accepted-turn boundary", () => {
  assert.deepEqual(turnStartFromSnapshot("2026-11-02T09:12:31.195Z", T0 + 5_000), {
    at: T0,
    source: "snapshot",
  });
});

test("snapshot start is clamped when the snapshot has no usable timestamp", () => {
  const observedAt = T0 + 2_000;
  assert.deepEqual(turnStartFromSnapshot(null, observedAt), { at: observedAt, source: "arrival" });
  assert.deepEqual(turnStartFromSnapshot("garbage", observedAt), {
    at: observedAt,
    source: "arrival",
  });
  assert.deepEqual(turnStartFromSnapshot("2026-11-02T09:12:41.195Z", observedAt), {
    at: observedAt,
    source: "arrival",
  });
});

test("attaching mid-turn establishes the turn before restoring its wait", () => {
  const result = reconcileSnapshot(
    initialMeterState(),
    snapshot({ pendingPermissions: [{ id: "req-1" }] }),
    T0 + 2_000,
    { seed: true },
  );
  assert.deepEqual(
    result.actions.map((action) => action.t),
    ["turn_started", "user_wait_started"],
  );
  const state = apply(initialMeterState(), result.actions);
  assert.equal(state.phase, "running");
  assert.equal(state.turnId, "t1");
  // The clock starts at the turn's real boundary while the observed stretch
  // begins at the attach, so turn totals never claim the unseen part.
  assert.equal(state.startedAt, T0);
  assert.equal(state.seededFrom, T0 + 2_000);
  // The pause is attached to the turn, not dropped as "no turn yet".
  assert.equal(state.pausedAt, T0 + 2_000);
  assert.deepEqual(result.pendingWaits, ["req-1"]);
});

test("a turn announced while the plugin already watches it is not partly observed", () => {
  const live = reduceMeter(initialMeterState(), { t: "turn_started", at: T0, turnId: "t1" });
  assert.equal(live.seededFrom, null);
  const next = reconcileSnapshot(live, snapshot(), T0 + 2_000, { seed: true });
  assert.deepEqual(next.actions.filter((a) => a.t === "turn_started"), []);
  assert.equal(apply(live, next.actions).seededFrom, null);
});

test("seeding waits for the subscription and only seeds a running snapshot", () => {
  const beforeReady = reconcileSnapshot(initialMeterState(), snapshot(), T0 + 2_000, { seed: false });
  assert.deepEqual(beforeReady.actions, []);
  const idle = reconcileSnapshot(
    initialMeterState(),
    snapshot({ status: "idle", activeTurn: null }),
    T0 + 2_000,
    { seed: true },
  );
  assert.deepEqual(idle.actions, []);
});

test("an answered permission closes the wait on the running turn", () => {
  const state = reduceMeter(runningTurn(), { t: "user_wait_started", at: T0 + 1_000 });
  const result = reconcileSnapshot(state, snapshot({ pendingPermissions: [] }), T0 + 3_000, {
    seed: true,
  });
  assert.deepEqual(result.actions.map((action) => action.t), ["user_wait_ended"]);
  const next = apply(state, result.actions);
  assert.equal(next.pausedAt, null);
  assert.deepEqual(next.userWaits, [{ start: T0 + 1_000, end: T0 + 3_000 }]);
});

test("a snapshot without wait information leaves the wait alone", () => {
  const state = reduceMeter(runningTurn(), { t: "user_wait_started", at: T0 + 1_000 });
  const result = reconcileSnapshot(state, snapshot(), T0 + 3_000, { seed: true });
  assert.deepEqual(result.actions, []);
  assert.equal(result.pendingWaits, null);
});

test("a turn whose terminal event was lost is closed provisionally", () => {
  const state = reduceMeter(runningTurn(), { t: "text", at: T0 + 500, key: "m", text: "hi" });
  const result = reconcileSnapshot(
    state,
    { status: "idle", activeTurn: null },
    T0 + 4_000,
    { seed: true },
  );
  assert.deepEqual(result.actions, [
    { t: "turn_ended", at: T0 + 4_000, kind: "completed", turnId: "t1", provisional: true },
  ]);
  const next = apply(state, result.actions);
  assert.equal(next.phase, "completed");
  assert.equal(next.provisional, true);
  assert.equal(next.endedAt, T0 + 4_000);
});

test("a running agent keeps its clock, and an idle meter has nothing to close", () => {
  assert.deepEqual(reconcileSnapshot(runningTurn(), snapshot(), T0 + 4_000, { seed: true }).actions, []);
  assert.deepEqual(
    reconcileSnapshot(initialMeterState(), { status: "idle", activeTurn: null }, T0, { seed: true })
      .actions,
    [],
  );
});

test("a snapshot describing another turn never closes this one", () => {
  const result = reconcileSnapshot(
    runningTurn(T0, "t1"),
    { status: "idle", activeTurn: { turnId: "t2", startedAt: null } },
    T0 + 4_000,
    { seed: true },
  );
  assert.deepEqual(result.actions, []);
});

test("a partial snapshot without a status never closes a turn", () => {
  for (const status of [null, undefined, ""]) {
    assert.deepEqual(
      reconcileSnapshot(runningTurn(), { status, activeTurn: null }, T0 + 4_000, { seed: true })
        .actions,
      [],
    );
  }
});

test("a seeded turn parks the delegation of children that are already running", () => {
  // The parent attaches after its children: the snapshot establishes the turn,
  // and the delegation that follows it is parked instead of charged as work.
  const result = reconcileSnapshot(initialMeterState(), snapshot(), T0 + 2_000, { seed: true });
  let state = apply(initialMeterState(), result.actions);
  state = reduceMeter(state, { t: "delegated_started", at: T0 + 2_000 });
  assert.equal(state.delegatedAt, T0 + 2_000);
  // Delegation before the turn exists is a no-op, which is why the order
  // matters: the reconciliation has to establish the turn first.
  const early = reduceMeter(initialMeterState(), { t: "delegated_started", at: T0 + 2_000 });
  assert.equal(early.delegatedAt, null);
});

test("an empty turn id in a snapshot is no id", () => {
  const result = reconcileSnapshot(
    initialMeterState(),
    { status: "running", activeTurn: { turnId: "", startedAt: new Date(T0).toISOString() } },
    T0 + 2_000,
    { seed: true },
  );
  assert.deepEqual(result.actions, [
    // `observedFrom` marks the attach instant: the turn is only watched from here.
    { t: "turn_started", at: T0, turnId: null, observedFrom: T0 + 2_000 },
  ]);
});
