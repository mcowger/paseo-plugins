import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useSyncExternalStore } from "react";
import { createAgentFeeds, openAgentFeed, type PaseoApi } from "./agent-feed";
import { createAttentionStores, EMPTY, watchPendingPermissions } from "./attention-store";
import { useForeground } from "./use-foreground";

// 本地补丁：「等你批准」的 React 端。按 Agent 的记录与 0.5.0 的实时订阅见 attention-store.ts 和 agent-feed.ts。
const attention = createAttentionStores();
const feeds = createAgentFeeds<PaseoApi>({ open: openAgentFeed });

/**
 * Which tool calls of the Agent wait for your approval. `active`: the row can show it (it is running); only those rows
 * register, so an open chat with nothing running holds no subscription.
 */
export function usePendingPermissions(agentId: string, active = true): { ids: ReadonlySet<string>; questions: ReadonlySet<string>; any: boolean; onlyQuestions: boolean } {
  const paseo = usePaseo();
  const foreground = useForeground();
  useEffect(() => {
    feeds.setForeground(foreground);
  }, [foreground]);
  useEffect(() => {
    if (!active || agentId.startsWith("provider:")) return;
    const store = attention.acquire(agentId, (subscribed) =>
      watchPendingPermissions(paseo.agents.ref(agentId), agentId, (pending) => attention.publish(subscribed, pending), (onSnapshot) => feeds.acquire(paseo, onSnapshot)));
    return () => attention.release(agentId, store);
  }, [active, agentId, paseo]);
  const ids = useSyncExternalStore(
    (listener) => attention.listen(agentId, listener),
    () => attention.snapshot(agentId)?.ids ?? EMPTY,
    () => EMPTY,
  );
  const questions = useSyncExternalStore(
    (listener) => attention.listen(agentId, listener),
    () => attention.snapshot(agentId)?.questions ?? EMPTY,
    () => EMPTY,
  );
  const any = useSyncExternalStore(
    (listener) => attention.listen(agentId, listener),
    () => attention.snapshot(agentId)?.any ?? false,
    () => false,
  );
  const onlyQuestions = useSyncExternalStore(
    (listener) => attention.listen(agentId, listener),
    () => attention.snapshot(agentId)?.onlyQuestions ?? false,
    () => false,
  );
  return { ids, questions, any, onlyQuestions };
}
