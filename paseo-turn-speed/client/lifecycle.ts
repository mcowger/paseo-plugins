/**
 * How a turn becomes known to the plugin and how it ends.
 *
 * A turn arrives either as a live `turn_started` stream event or as an agent
 * snapshot taken while the plugin attaches mid-turn. Its clock must start at an
 * instant the daemon observed, never at a cached handle field: `ref()`
 * snapshots update on the agent channel while turn events arrive on the
 * timeline channel, so reading `handle.activeTurn` right after `turn_started`
 * can still hold the previous turn's start, charging that whole turn to this
 * one (a 2s turn reported as 63s, `whole turn` collapsing toward 0).
 *
 * It ends either as a terminal stream event (authoritative) or, when that event
 * is lost, as a snapshot that says the agent is no longer working. The snapshot
 * only knows that work stopped: it cannot tell a completed turn from a failed
 * or canceled one, so the end it produces is provisional and a later terminal
 * event for the same turn replaces it.
 */

import { reduceMeter, type MeterAction, type MeterState } from "./meter";

export type TurnStartSource = "event" | "snapshot" | "arrival";

export interface TurnStart {
  /** Epoch milliseconds the meter should count from. */
  at: number;
  /** Where `at` came from; `arrival` means the timestamp was unusable. */
  source: TurnStartSource;
}

/** The daemon usually shares the app's clock; allow a little skew before
 * declaring a timestamp unreal. */
const MAX_CLOCK_SKEW_MS = 5_000;

/** The part of an agent snapshot the meter needs, kept structural so the rules
 * stay testable without the SDK. */
export interface AgentTurnSnapshot {
  status?: string | null;
  activeTurn?: { turnId?: string | null; startedAt?: string | null } | null;
  /** Absent means "no information"; present-and-empty means "nothing open". */
  pendingPermissions?: readonly { id: string | null }[] | null;
}

export interface Reconciliation {
  /** Actions to dispatch, in order. */
  actions: MeterAction[];
  /** Open permission/question ids, or null when the snapshot carries none. */
  pendingWaits: string[] | null;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Epoch milliseconds carried by a stream message, or null when it carries none.
 * Exposed so callers can compare the daemon's clock with their own anchor. */
export const timestampMs = parseTimestamp;

/** Anchor a live `turn_started` to the daemon timestamp carried by the stream
 * message, clamped so the clock never starts in the future. Events arrive in
 * order on one subscription, so the timestamp of the latest one is the turn
 * being announced; there is no age limit to guess at. */
export function turnStartFromEvent(
  timestamp: string | null | undefined,
  arrivedAt: number,
): TurnStart {
  const parsed = parseTimestamp(timestamp);
  if (parsed === null) return { at: arrivedAt, source: "arrival" };
  if (parsed - arrivedAt > MAX_CLOCK_SKEW_MS) return { at: arrivedAt, source: "arrival" };
  return { at: Math.min(parsed, arrivedAt), source: "event" };
}

/** Anchor a turn recovered from an agent snapshot read after the timeline
 * subscription is established. The snapshot's `startedAt` is the daemon's
 * accepted-turn boundary, so it is exact for a mid-turn attach. */
export function turnStartFromSnapshot(
  startedAt: string | null | undefined,
  observedAt: number,
): TurnStart {
  const parsed = parseTimestamp(startedAt);
  if (parsed === null) return { at: observedAt, source: "arrival" };
  if (parsed - observedAt > MAX_CLOCK_SKEW_MS) return { at: observedAt, source: "arrival" };
  return { at: Math.min(parsed, observedAt), source: "snapshot" };
}

/**
 * Fold one agent snapshot into meter actions, in the order the meter needs.
 *
 * The order is the point: a turn is established before the wait and delegation
 * state that only applies to a running turn, so attaching while the agent is
 * blocked on a permission prompt does not silently charge that wait to the
 * model. Everything is evaluated against the state produced by the previous
 * action, not against the state the caller passed in.
 */
export function reconcileSnapshot(
  state: MeterState,
  snapshot: AgentTurnSnapshot,
  now: number,
  options: { seed: boolean },
): Reconciliation {
  const actions: MeterAction[] = [];
  let current = state;
  const push = (action: MeterAction): void => {
    actions.push(action);
    current = reduceMeter(current, action);
  };

  // 1. A turn that was already running when the plugin attached.
  if (options.seed && current.phase === "idle" && snapshot.status === "running" && snapshot.activeTurn) {
    const start = turnStartFromSnapshot(snapshot.activeTurn.startedAt, now);
    push({
      t: "turn_started",
      at: start.at,
      turnId: snapshot.activeTurn.turnId || null,
      // The turn is only observed from here on: the meter must not turn its
      // real boundary into a denominator for tokens it never saw.
      observedFrom: now,
    });
  }

  // 2. Requests the model is blocked on: that interval is not work.
  const pendingPermissions = snapshot.pendingPermissions;
  const pendingWaits = pendingPermissions
    ? pendingPermissions
        .map((request) => request.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    : null;
  if (pendingWaits) {
    push({ t: pendingWaits.length > 0 ? "user_wait_started" : "user_wait_ended", at: now });
  }

  // 3. A turn whose terminal event never arrived: stop the clock, keep the
  //    outcome open for the real terminal event.
  if (shouldCloseMissedTurn(current, snapshot)) {
    push({ t: "turn_ended", at: now, kind: "completed", turnId: current.turnId, provisional: true });
  }

  return { actions, pendingWaits };
}

/**
 * The snapshot is an independent source of truth for "this agent is not
 * working". A snapshot without a status is partial, not idle, and a snapshot
 * that still describes a different turn says nothing about this one.
 */
export function shouldCloseMissedTurn(
  state: MeterState,
  snapshot: AgentTurnSnapshot,
): boolean {
  if (state.phase !== "running") return false;
  const status = snapshot.status;
  if (typeof status !== "string" || status === "" || status === "running") return false;
  const turnId = snapshot.activeTurn?.turnId || null;
  return turnId === null || state.turnId === null || turnId === state.turnId;
}
