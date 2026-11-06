import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef } from "react";
import { getArchiveJob, type RepoStatus } from "../shared/rpc";

export interface ArchiveResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly blocked: readonly RepoStatus[];
}

export function useArchiveJob(): (jobId: string) => Promise<ArchiveResult> {
  const callStatus = useRpc(getArchiveJob);
  const mounted = useRef(true);
  const polling = useRef(false);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; resolve: () => void } | null>(
    null,
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.resolve();
        pending.current = null;
      }
    };
  }, []);

  return useCallback(
    async (jobId: string): Promise<ArchiveResult> => {
      if (polling.current) throw new Error("An archive status check is already running");
      polling.current = true;
      try {
        while (true) {
          if (!mounted.current) throw new Error("Archive status check cancelled");
          let status: RpcOutput<typeof getArchiveJob>;
          try {
            status = await callStatus({ jobId });
          } catch (unknownError) {
            const detail = unknownError instanceof Error ? `: ${unknownError.message}` : "";
            throw new Error(
              `Could not check archive status; the job may still be running${detail}`,
            );
          }
          if (!mounted.current) throw new Error("Archive status check cancelled");
          if (status.state === "finished") return status.result;
          if (status.state === "missing")
            throw new Error("Archive job was not found; it may have expired. Refresh and retry.");
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              pending.current = null;
              resolve();
            }, 500);
            pending.current = { timer, resolve };
          });
        }
      } finally {
        polling.current = false;
      }
    },
    [callStatus],
  );
}
