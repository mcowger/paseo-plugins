// Diff-on-touch sources (upstream `~/workspace/paseo/packages/server/src/server/agent/providers/pi/`):
// - `agent.ts` prompt/terminal correlation: `activePromptRequestId` (~1244),
//   ack correlation (~1344), `prompt_result` buffering (~2141),
//   `agent_end`/`agent_settled` handling (~2190/2288), interruption (~1252/1540).
// - Technique: paseo-omp `session-terminal.ts` pattern (authoritative keyed
//   match, ordered-evidence legacy fallback, exactly-one terminal).
// Intentional divergences (never "fix" on diff):
// - Upstream `agent_end` carries no `requestId` yet; the keyed path below is
//   forward-compatible and inert until binaries emit it. Until then the
//   legacy fallback owns unkeyed terminals.

export type TurnTerminalKind = "agent_end" | "agent_settled";

export interface TurnTerminalSignal {
  type: TurnTerminalKind;
  requestId?: string;
}

export type KeyedOwnership = "match" | "mismatch" | "ack-pending" | "unkeyed";

// Authoritative key check. Runs before any state, usage, subagent, or
// compaction transition. A mismatch is discarded; an `ack-pending` signal
// must be buffered until the prompt ack resolves the active request id.
export function checkTerminalKey(
  signalRequestId: string | undefined,
  activePromptRequestId: string | null,
): KeyedOwnership {
  if (signalRequestId === undefined) return "unkeyed";
  if (activePromptRequestId === null) return "ack-pending";
  return signalRequestId === activePromptRequestId ? "match" : "mismatch";
}

export interface LegacyTerminalEvidence {
  // A submitted user entry was captured during this turn (branch-correlated
  // via the entry-capture extension markers).
  hasFreshCapturedEntry: boolean;
  // Assistant activity (turn start, message, or tool event) was observed
  // after the captured entry during this turn.
  hasCurrentTurnActivity: boolean;
  // `getState()` reports the runtime is idle (not streaming).
  runtimeIdle: boolean;
  // `getState()` reports the runtime is compacting.
  runtimeCompacting: boolean;
  // Any conflicting work is in flight: permission question, tool call, steer
  // submission, child subagent, pending extension result, or active
  // compaction.
  hasConflictingWork: boolean;
}

export type LegacyTerminalDecision =
  | { kind: "accept" }
  | { kind: "ignore" }
  | { kind: "failTurn" };

// Ordered-evidence legacy fallback for binaries that omit `requestId`.
// Full evidence accepts; conflicting work or a busy runtime ignores
// (ambiguous-active terminals must never move turn state); a confirmed-idle
// runtime with incomplete evidence fails only the Paseo turn — the process
// stays alive.
export function decideLegacyTerminal(evidence: LegacyTerminalEvidence): LegacyTerminalDecision {
  if (evidence.hasConflictingWork || !evidence.runtimeIdle || evidence.runtimeCompacting) {
    return { kind: "ignore" };
  }
  if (evidence.hasFreshCapturedEntry && evidence.hasCurrentTurnActivity) {
    return { kind: "accept" };
  }
  return { kind: "failTurn" };
}

// `prompt_result` / ack `agentInvoked: false` stays local-only, but only when
// no contradictory native activity was observed. If the runtime already
// started the turn (agent/turn start, messages, tools), the false ack loses
// and the session waits for the real terminal.
export function shouldHonorNoTurnAck(hasNativeActivity: boolean): boolean {
  return !hasNativeActivity;
}
