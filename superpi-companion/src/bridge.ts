import {
  CHILD_NOTIFY_PREFIX,
  type ChildForward,
  type SubagentBridgeRecord,
  SUBAGENT_BRIDGE_VERSION,
} from "./protocol.ts";

/**
 * Ordered, terminal-sticky fold over owned-subagent bridge records.
 *
 * The root companion subscribes to the pi-subagents bridge bus and forwards
 * each accepted record to the provider. The tracker keeps the forwarding
 * honest:
 * - a run must start with a `created` record before activity or terminal;
 * - per-run `sequence` must increase, so duplicated or replayed records are
 *   dropped instead of forwarded twice;
 * - the terminal record is sticky, so a late result collection cannot reopen a
 *   finished child;
 * - `activeChildren` counts runs that have not reached a terminal record and is
 *   the rewind guard.
 */
export interface SubagentBridgeTracker {
  /** Return the forward envelope for an accepted record, or undefined when dropped. */
  accept(record: SubagentBridgeRecord): ChildForward | undefined;
  /** Number of runs that have not reached a terminal record. */
  activeChildren(): number;
  reset(): void;
}

export function createSubagentBridgeTracker(sessionKey: string): SubagentBridgeTracker {
  const runs = new Map<string, { sequence: number; terminal: boolean }>();

  function commit(record: SubagentBridgeRecord): ChildForward {
    return { version: SUBAGENT_BRIDGE_VERSION, sessionKey, record };
  }

  return {
    accept(record) {
      const existing = runs.get(record.runId);
      if (existing) {
        if (existing.terminal) return undefined;
        if (record.sequence <= existing.sequence) return undefined;
        existing.sequence = record.sequence;
        if (record.type === "terminal") existing.terminal = true;
      } else {
        if (record.type !== "created") return undefined;
        runs.set(record.runId, { sequence: record.sequence, terminal: false });
      }
      return commit(record);
    },
    activeChildren() {
      let count = 0;
      for (const run of runs.values()) {
        if (!run.terminal) count += 1;
      }
      return count;
    },
    reset() {
      runs.clear();
    },
  };
}

/** Serialize a forward envelope as the `superpi:child:v1:<json>` notification payload. */
export function formatChildForward(forward: ChildForward): string {
  return `${CHILD_NOTIFY_PREFIX}${JSON.stringify(forward)}`;
}
