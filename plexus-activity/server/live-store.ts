import { estimateTokensPerSec } from "../shared/api-types";
import {
  compareNewestFirst,
  createEmptyRecord,
  isInFlight,
  matchesScope,
  mergeRecord,
  type NormalizedRecord,
  type RecordPatch,
  toUsageRow,
} from "../shared/row-model";
import type { UsageRow } from "../shared/view";
import type { ProgressSample } from "./records";

/**
 * Bounded in-memory store for the live feed.
 *
 * Plexus never replays events, so the store is the only record of what arrived while a client was
 * disconnected. It keeps a newest-first ring of records plus a bounded journal of `(seq, requestId)`
 * mutations; a polling client sends its last `seq` and receives just the rows that changed since.
 */

export interface LiveStoreOptions {
  readonly maxRows?: number;
  readonly journalMax?: number;
  readonly clock?: () => number;
}

export interface SnapshotQuery {
  readonly scope: string | null;
  readonly since: number | null;
}

export interface StoreSnapshot {
  readonly cursor: number;
  readonly serverNow: number;
  readonly reset: boolean;
  readonly rows: UsageRow[];
}

export interface LiveStore {
  applyPatch(patch: RecordPatch): void;
  applyPatches(patches: readonly RecordPatch[]): void;
  applyProgress(requestId: string, sample: ProgressSample): void;
  snapshot(query: SnapshotQuery): StoreSnapshot;
  size(): number;
}

interface StoredEntry {
  record: NormalizedRecord;
  seq: number;
}

interface StoredProgress {
  sample: ProgressSample;
  receivedAt: number;
}

export const DEFAULT_MAX_ROWS = 250;
export const DEFAULT_JOURNAL_MAX = 400;

export function createLiveStore(options: LiveStoreOptions = {}): LiveStore {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const journalMax = options.journalMax ?? DEFAULT_JOURNAL_MAX;
  const clock = options.clock ?? Date.now;

  const entries = new Map<string, StoredEntry>();
  const progress = new Map<string, StoredProgress>();
  const journal: { seq: number; requestId: string }[] = [];
  let seq = 0;

  function recordMutation(requestId: string): number {
    seq += 1;
    journal.push({ seq, requestId });
    if (journal.length > journalMax) journal.splice(0, journal.length - journalMax);
    return seq;
  }

  function project(entry: StoredEntry): UsageRow {
    const live = progress.get(entry.record.requestId);
    const estimate = live ? estimateTokensPerSec(live.sample, entry.record) : null;
    return toUsageRow(entry.record, entry.seq, estimate);
  }

  function evictOverflow(): void {
    if (entries.size <= maxRows) return;
    const ordered = [...entries.values()].sort((left, right) =>
      compareNewestFirst(left.record, right.record),
    );
    for (const stale of ordered.slice(maxRows)) {
      entries.delete(stale.record.requestId);
      progress.delete(stale.record.requestId);
    }
  }

  function applyPatch(patch: RecordPatch): void {
    const existing = entries.get(patch.requestId);
    const base = existing
      ? existing.record
      : createEmptyRecord(patch.requestId, patch.startTime ?? clock());
    const record = mergeRecord(base, patch);

    entries.set(patch.requestId, { record, seq: recordMutation(patch.requestId) });
    if (!isInFlight(record)) progress.delete(patch.requestId);
    evictOverflow();
  }

  function applyProgress(requestId: string, sample: ProgressSample): void {
    // Progress only decorates a row that already exists; a stray frame is not a record.
    if (!entries.has(requestId)) return;
    progress.set(requestId, { sample, receivedAt: clock() });
    if (progress.size > maxRows * 2) {
      const ordered = [...progress.entries()].sort(
        (left, right) => left[1].receivedAt - right[1].receivedAt,
      );
      for (const [staleId] of ordered.slice(0, ordered.length - maxRows * 2)) {
        progress.delete(staleId);
      }
    }
  }

  function fullSnapshot(scope: string | null, serverNow: number): StoreSnapshot {
    const rows: UsageRow[] = [];
    for (const entry of entries.values()) {
      if (!matchesScope(entry.record, scope)) continue;
      rows.push(project(entry));
    }
    rows.sort(compareNewestFirst);
    return { cursor: seq, serverNow, reset: true, rows };
  }

  function deltaSnapshot(since: number, scope: string | null, serverNow: number): StoreSnapshot {
    const seen = new Set<string>();
    const rows: UsageRow[] = [];
    for (const mutation of journal) {
      if (mutation.seq <= since) continue;
      if (seen.has(mutation.requestId)) continue;
      seen.add(mutation.requestId);
      const entry = entries.get(mutation.requestId);
      if (!entry || !matchesScope(entry.record, scope)) continue;
      rows.push(project(entry));
    }
    rows.sort(compareNewestFirst);
    return { cursor: seq, serverNow, reset: false, rows };
  }

  return {
    applyPatch,
    applyPatches(patches) {
      for (const patch of patches) applyPatch(patch);
    },
    applyProgress,
    snapshot(query) {
      const serverNow = clock();

      if (query.since === null) return fullSnapshot(query.scope, serverNow);

      const oldestJournalSeq = journal[0]?.seq ?? 0;
      const evicted = journal.length > 0 && query.since < oldestJournalSeq - 1;
      // A cursor from a previous daemon process can exceed the current sequence.
      if (query.since > seq) return fullSnapshot(query.scope, serverNow);
      if (evicted) return fullSnapshot(query.scope, serverNow);

      return deltaSnapshot(query.since, query.scope, serverNow);
    },
    size() {
      return entries.size;
    },
  };
}
