import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import { usePaseo } from "@getpaseo/plugin";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { useEffect, useMemo, useState } from "react";
import { reduceTimeline, type SessionSummary } from "../shared/summary";

const TIMELINE_PAGE_SIZE = 200;
const MAX_TIMELINE_ENTRIES = 2_000;
const REFRESH_DEBOUNCE_MS = 250;

export interface SummaryDataState {
  readonly loading: boolean;
  readonly error: string | null;
  readonly summary: SessionSummary | null;
  readonly historyTruncated: boolean;
}

const EMPTY_STATE: SummaryDataState = {
  loading: true,
  error: null,
  summary: null,
  historyTruncated: false,
};

async function fetchTimeline(agentTimeline: PaseoAgentTimelineHandle): Promise<{
  items: AgentTimelineItem[];
  historyTruncated: boolean;
}> {
  let response = await agentTimeline.refetch({
    direction: "tail",
    limit: TIMELINE_PAGE_SIZE,
    projection: "projected",
  });
  if (response.error) throw new Error(response.error);

  let items = response.entries.map((entry) => entry.item);
  const visitedCursors = new Set<string>();
  while (response.hasOlder && response.startCursor && items.length < MAX_TIMELINE_ENTRIES) {
    const cursorKey = `${response.startCursor.epoch}:${response.startCursor.seq}`;
    if (visitedCursors.has(cursorKey)) break;
    visitedCursors.add(cursorKey);
    response = await agentTimeline.refetch({
      direction: "before",
      cursor: response.startCursor,
      limit: Math.min(TIMELINE_PAGE_SIZE, MAX_TIMELINE_ENTRIES - items.length),
      projection: "projected",
    });
    if (response.error) throw new Error(response.error);
    items = [...response.entries.map((entry) => entry.item), ...items];
  }

  return { items, historyTruncated: response.hasOlder };
}

export function useSummaryData(agentId: string): SummaryDataState {
  const paseo = usePaseo();
  const agentTimeline = useMemo(() => paseo.agents.ref(agentId).timeline, [agentId, paseo]);
  const [state, setState] = useState<SummaryDataState>(EMPTY_STATE);

  useEffect(() => {
    let stopped = false;
    let refreshing = false;
    let refreshQueued = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const refresh = async () => {
      if (stopped || refreshing) {
        refreshQueued = !stopped;
        return;
      }
      refreshing = true;
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const timeline = await fetchTimeline(agentTimeline);
        if (!stopped) {
          setState({
            loading: false,
            error: null,
            summary: reduceTimeline(timeline.items),
            historyTruncated: timeline.historyTruncated,
          });
        }
      } catch (error) {
        if (!stopped) {
          setState((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      } finally {
        refreshing = false;
        if (!stopped && refreshQueued) {
          refreshQueued = false;
          void refresh();
        }
      }
    };
    const scheduleRefresh = () => {
      if (stopped || refreshTimer !== null) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, REFRESH_DEBOUNCE_MS);
    };
    const unsubscribe = agentTimeline.subscribe(scheduleRefresh);
    void refresh();

    return () => {
      stopped = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [agentTimeline]);

  return state;
}
