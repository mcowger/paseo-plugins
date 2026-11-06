import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { compareNewestFirst } from "../shared/row-model";
import { keysRpc, snapshotRpc } from "../shared/rpc";
import type { ConnectionStatus, KeysOutput, SnapshotOutput, UsageRow } from "../shared/view";

/**
 * Polls the plugin server for activity deltas.
 *
 * 0.12.0 exposes no server-to-client push, so this is the transport. The interval is short only while
 * something is in flight; in-flight durations are ticked locally at 4 Hz between polls, which is what
 * makes the feed look continuous.
 */

const POLL_ACTIVE_MS = 1_500;
const POLL_IDLE_MS = 5_000;
const TICK_MS = 400;
const MAX_CLIENT_ROWS = 250;

const INITIAL_STATUS: ConnectionStatus = {
  configured: false,
  connection: "unconfigured",
  lastEventAt: null,
  lastError: null,
  retryInMs: null,
};

function sortAndCap(rows: readonly UsageRow[]): UsageRow[] {
  const sorted = [...rows].sort(compareNewestFirst);
  return sorted.length > MAX_CLIENT_ROWS ? sorted.slice(0, MAX_CLIENT_ROWS) : sorted;
}

function applySnapshot(previous: UsageRow[], result: SnapshotOutput): UsageRow[] {
  if (result.reset) return sortAndCap(result.rows);
  if (result.rows.length === 0) return previous;
  const byId = new Map(previous.map((row) => [row.requestId, row]));
  for (const row of result.rows) byId.set(row.requestId, row);
  return sortAndCap([...byId.values()]);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Could not reach the Plexus activity service";
}

export interface ActivityFeed {
  readonly rows: UsageRow[];
  readonly status: ConnectionStatus;
  readonly error: string | null;
  /** Skew-corrected clock used for live durations. */
  readonly now: number;
  readonly paused: boolean;
  readonly hasPending: boolean;
  /** False until the first snapshot lands; the panel shows a neutral loading state before that. */
  readonly loaded: boolean;
  togglePause(): void;
  refresh(): void;
}

export function useActivityFeed(scope: string | null): ActivityFeed {
  const callSnapshot = useRpc(snapshotRpc);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>(INITIAL_STATUS);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);

  const sinceRef = useRef<number | null>(null);
  const offsetRef = useRef(0);
  const scopeRef = useRef<string | null>(null);
  const pendingRef = useRef(false);

  const hasPending = rows.some((row) => row.status === "pending");

  const togglePause = useCallback(() => setPaused((value) => !value), []);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    pendingRef.current = hasPending;
  }, [hasPending]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and paused only restart the poll loop
  useEffect(() => {
    if (scopeRef.current !== scope) {
      scopeRef.current = scope;
      sinceRef.current = null;
    }
    if (paused) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      const receivedAt = Date.now();
      try {
        const result = await callSnapshot({ scope, since: sinceRef.current });
        if (cancelled) return;
        sinceRef.current = result.cursor;
        offsetRef.current = result.serverNow - receivedAt;
        setStatus(result.status);
        setError(null);
        setLoaded(true);
        setRows((previous) => applySnapshot(previous, result));
        setNow(receivedAt + offsetRef.current);
      } catch (caught) {
        if (!cancelled) setError(errorText(caught));
      }
      if (cancelled) return;
      timer = setTimeout(() => void poll(), pendingRef.current ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [callSnapshot, scope, paused, revision]);

  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => setNow(Date.now() + offsetRef.current), TICK_MS);
    return () => clearInterval(timer);
  }, [hasPending]);

  return { rows, status, error, now, paused, hasPending, loaded, togglePause, refresh };
}

export interface PlexusKeys extends KeysOutput {
  reload(): void;
}

const INITIAL_KEYS: KeysOutput = { status: "unavailable", role: null, keys: [] };

/** Key names for the scope selector. Names only: the endpoint returns decrypted secrets. */
export function usePlexusKeys(): PlexusKeys {
  const callKeys = useRpc(keysRpc);
  const [state, setState] = useState<KeysOutput>(INITIAL_KEYS);
  const [revision, setRevision] = useState(0);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    void callKeys({ refresh: revision > 0 })
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch(() => {
        if (!cancelled) setState(INITIAL_KEYS);
      });
    return () => {
      cancelled = true;
    };
  }, [callKeys, revision]);

  return { ...state, reload };
}
