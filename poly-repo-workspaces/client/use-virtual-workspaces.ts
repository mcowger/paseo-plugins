import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listVirtualWorkspaces, type VirtualWorkspaceSummary } from "../shared/rpc";

const TRANSITIONAL_STATES: ReadonlySet<string> = new Set([
  "creating",
  "archiving",
  "teardown-blocked",
]);
const TRANSITIONAL_POLL_MS = 5000;

export interface VirtualWorkspacesResult {
  readonly transitional: boolean;
  readonly items: readonly VirtualWorkspaceSummary[];
  readonly loading: boolean;
  readonly error: string | null;
  refresh(): void;
}

export function useVirtualWorkspaces(): VirtualWorkspacesResult {
  const paseo = usePaseo();
  const callList = useRpc(listVirtualWorkspaces);
  const [items, setItems] = useState<readonly VirtualWorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const requestInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const generation = useRef(0);
  const callListRef = useRef(callList);
  callListRef.current = callList;
  const transitional = useMemo(
    () => items.some((item) => TRANSITIONAL_STATES.has(item.state)),
    [items],
  );

  const refresh = useCallback(() => {
    if (!mounted.current) return;
    if (requestInFlight.current) {
      refreshQueued.current = true;
      return;
    }
    requestInFlight.current = true;
    setLoading(true);
    void (async () => {
      do {
        refreshQueued.current = false;
        const requestGeneration = generation.current;
        try {
          const result = await callListRef.current({});
          if (mounted.current && requestGeneration === generation.current) {
            setItems(result.virtualWorkspaces);
            setError(null);
          }
        } catch (unknownError) {
          if (mounted.current && requestGeneration === generation.current) {
            setError(unknownError instanceof Error ? unknownError.message : "failed to load");
          }
        }
      } while (mounted.current && refreshQueued.current);
      requestInFlight.current = false;
      if (mounted.current) setLoading(false);
    })();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new RPC binding invalidates in-flight responses.
  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    refresh();
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [callList, refresh]);

  useEffect(() => {
    const unsubscribe = paseo.workspaces.subscribe(() => {
      refresh();
    });
    return unsubscribe;
  }, [paseo, refresh]);

  // Recovery backstop: while anything is mid-transition, poll slowly in case
  // a subscription event was missed. Steady states never poll.
  useEffect(() => {
    if (!transitional) return;
    const timer = setInterval(refresh, TRANSITIONAL_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, transitional]);

  return { items, loading, error, refresh, transitional };
}
