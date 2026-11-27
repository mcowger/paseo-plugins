import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { foldActivityUpdate } from "../shared/row-model";
import { activityStreamSubscription, keysRpc, snapshotRpc } from "../shared/rpc";
import type { ActivityUpdate, ConnectionStatus, KeysOutput, UsageRow } from "../shared/view";

/**
 * Activity feed for the panel. The server pushes every change on `activityStreamSubscription`; each
 * push is folded into the row list by `requestId`, keeping whichever copy has the newer `updatedSeq`.
 *
 * A snapshot RPC runs on mount, scope change, resume from pause, and every `BACKSTOP_MS`; it recovers
 * a subscription that dropped without an error reaching the client. In-flight durations tick locally
 * at `TICK_MS` between pushes.
 */

const BACKSTOP_MS = 60_000;
const TICK_MS = 400;

const INITIAL_STATUS: ConnectionStatus = {
  configured: false,
  connection: "unconfigured",
  lastEventAt: null,
  lastError: null,
  retryInMs: null,
};

export interface ActivityFeed {
  readonly rows: UsageRow[];
  readonly status: ConnectionStatus;
  readonly error: string | null;
  /** Skew-corrected clock used for live durations. */
  readonly now: number;
  readonly paused: boolean;
  readonly hasPending: boolean;
  /** False until the first update lands; the panel shows a neutral loading state before that. */
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
  const [epoch, setEpoch] = useState(0);

  const cursorRef = useRef<number | null>(null);
  const offsetRef = useRef(0);
  const pausedRef = useRef(paused);
  const scopeRef = useRef(scope);

  const hasPending = rows.some((row) => row.status === "pending");

  const togglePause = useCallback(() => setPaused((value) => !value), []);
  const refresh = useCallback(() => {
    cursorRef.current = null;
    setEpoch((value) => value + 1);
  }, []);

  const apply = useCallback((update: ActivityUpdate, receivedAt: number) => {
    // A snapshot answer can land after a newer push; a stale non-reset update must not rewind the cursor.
    if (!update.reset && cursorRef.current !== null && update.cursor < cursorRef.current) return;
    cursorRef.current = update.cursor;
    offsetRef.current = update.serverNow - receivedAt;
    setStatus(update.status);
    setError(null);
    setLoaded(true);
    setRows((previous) => foldActivityUpdate(previous, update));
    setNow(receivedAt + offsetRef.current);
  }, []);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    if (scopeRef.current !== scope) {
      scopeRef.current = scope;
      cursorRef.current = null;
    }
  }, [scope]);

  const subscriptionInput = useMemo(() => ({ scope, epoch }), [scope, epoch]);
  useSubscription(activityStreamSubscription, subscriptionInput, (update) => {
    if (pausedRef.current) return;
    apply(update, Date.now());
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch restarts the snapshot on refresh
  useEffect(() => {
    if (paused) return;

    let cancelled = false;

    const sync = (): void => {
      const receivedAt = Date.now();
      callSnapshot({ scope, since: cursorRef.current })
        .then((update) => {
          if (!cancelled) apply(update, receivedAt);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          setError(caught instanceof Error ? caught.message : "Activity service unreachable");
        });
    };

    sync();
    const timer = setInterval(sync, BACKSTOP_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [callSnapshot, scope, paused, epoch, apply]);

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
