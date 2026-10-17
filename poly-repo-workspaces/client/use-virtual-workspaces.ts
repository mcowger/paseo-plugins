import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  const [revision, setRevision] = useState(0);
  const transitional = useMemo(
    () => items.some((item) => TRANSITIONAL_STATES.has(item.state)),
    [items],
  );

  const refresh = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision intentionally retriggers reloads via refresh()
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = async (): Promise<void> => {
      try {
        const result = await callList({});
        if (cancelled) return;
        setItems(result.virtualWorkspaces);
        setError(null);
      } catch (unknownError) {
        if (cancelled) return;
        setError(unknownError instanceof Error ? unknownError.message : "failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [callList, revision]);

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
