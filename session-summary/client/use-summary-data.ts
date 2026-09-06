import type { PaseoAgentHandle, PaseoAgentTimelineHandle } from "@getpaseo/client";
import { usePaseo } from "@getpaseo/plugin";
import type { AgentStreamEvent, AgentUsage } from "@getpaseo/protocol/agent-types";
import { useEffect, useMemo, useState } from "react";
import {
  EMPTY_SESSION_STATS,
  lastTurnDuration,
  usageChanged,
  usageForTurn,
  reduceTimeline,
  type SessionStats,
  type SummaryTimelineEntry,
  type SessionSummary,
} from "../shared/summary";

const TIMELINE_PAGE_SIZE = 200;
const MAX_TIMELINE_ENTRIES = 2_000;
const REFRESH_DEBOUNCE_MS = 250;
const UNKNOWN_TIMELINE_SEQUENCE = Number.MAX_SAFE_INTEGER;

export interface SummaryDataState {
  readonly loading: boolean;
  readonly error: string | null;
  readonly summary: SessionSummary | null;
  readonly historyTruncated: boolean;
  readonly stats: SessionStats;
}

const EMPTY_STATE: SummaryDataState = {
  loading: true,
  error: null,
  summary: null,
  historyTruncated: false,
  stats: EMPTY_SESSION_STATS,
};

async function fetchTimeline(agentTimeline: PaseoAgentTimelineHandle): Promise<{
  entries: SummaryTimelineEntry[];
  historyTruncated: boolean;
}> {
  let response = await agentTimeline.refetch({
    direction: "tail",
    limit: TIMELINE_PAGE_SIZE,
    projection: "projected",
  });
  if (response.error) throw new Error(response.error);

  let entries = response.entries.map((entry) => ({
    item: entry.item,
    timestamp: entry.timestamp,
    ...(entry.turnId ? { turnId: entry.turnId } : {}),
    seq: entry.seqStart,
  }));
  const visitedCursors = new Set<string>();
  while (response.hasOlder && response.startCursor && entries.length < MAX_TIMELINE_ENTRIES) {
    const cursorKey = `${response.startCursor.epoch}:${response.startCursor.seq}`;
    if (visitedCursors.has(cursorKey)) break;
    visitedCursors.add(cursorKey);
    response = await agentTimeline.refetch({
      direction: "before",
      cursor: response.startCursor,
      limit: Math.min(TIMELINE_PAGE_SIZE, MAX_TIMELINE_ENTRIES - entries.length),
      projection: "projected",
    });
    if (response.error) throw new Error(response.error);
    entries = [
      ...response.entries.map((entry) => ({
        item: entry.item,
        timestamp: entry.timestamp,
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
        seq: entry.seqStart,
      })),
      ...entries,
    ];
  }

  return { entries, historyTruncated: response.hasOlder };
}

function timelineEntryKey(entry: SummaryTimelineEntry): string {
  if (entry.seq !== undefined) return `seq:${entry.seq}`;
  return `${entry.timestamp}:${entry.turnId ?? ""}:${entry.item.type}:${JSON.stringify(entry.item)}`;
}

function mergeTimelineEntries(
  first: readonly SummaryTimelineEntry[],
  second: readonly SummaryTimelineEntry[],
): SummaryTimelineEntry[] {
  const merged = new Map<string, SummaryTimelineEntry>();
  for (const entry of [...first, ...second]) merged.set(timelineEntryKey(entry), entry);
  return [...merged.values()]
    .sort(
      (left, right) => (left.seq ?? UNKNOWN_TIMELINE_SEQUENCE) - (right.seq ?? UNKNOWN_TIMELINE_SEQUENCE),
    )
    .slice(-MAX_TIMELINE_ENTRIES);
}

export function useSummaryData(agentId: string): SummaryDataState {
  const paseo = usePaseo();
  const agentHandle = useMemo<PaseoAgentHandle>(() => paseo.agents.ref(agentId), [agentId, paseo]);
  const agentTimeline = agentHandle.timeline;
  const [state, setState] = useState<SummaryDataState>(EMPTY_STATE);

  useEffect(() => {
    let stopped = false;
    let refreshing = false;
    let refreshQueued = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let timelineEntries: SummaryTimelineEntry[] = [];
    let stats: SessionStats = EMPTY_SESSION_STATS;
    let previousUsage: AgentUsage | null = null;
    let activeTurnId: string | null = null;
    let turnBaselineUsage: AgentUsage | null = null;
    let completedTurnId: string | null = null;
    let completedTurnBaseline: AgentUsage | null = null;

    const publishStats = () => setState((current) => ({ ...current, stats }));
    const updateAgentStats = () => {
      const agent = agentHandle.current();
      const usage = agent?.lastUsage ?? null;
      const activeTurn = agent?.activeTurn ?? null;

      if (usage && stats.totalUsage === null) {
        stats = {
          ...stats,
          totalUsage: usage,
          lastTurnUsage: activeTurn ? null : stats.lastTurnUsage,
        };
      }

      if (activeTurn && activeTurn.turnId !== activeTurnId) {
        if (activeTurn.turnId !== completedTurnId) {
          activeTurnId = activeTurn.turnId;
          turnBaselineUsage = usage ?? previousUsage ?? {};
          completedTurnId = null;
          completedTurnBaseline = null;
        }
      }

      if (completedTurnId && usageChanged(usage, completedTurnBaseline)) {
        stats = {
          ...stats,
          lastTurnUsage: usageForTurn(usage, completedTurnBaseline) ?? usage,
        };
        completedTurnBaseline = null;
      }

      if (!activeTurn && activeTurnId && agent && agent.status !== "running") {
        const finalUsage = usage ?? previousUsage;
        const completedUsage = usageChanged(finalUsage, turnBaselineUsage)
          ? usageForTurn(finalUsage, turnBaselineUsage)
          : null;
        stats = {
          ...stats,
          lastTurnUsage: completedTurnId === activeTurnId
            ? stats.lastTurnUsage ?? completedUsage
            : completedUsage ?? stats.lastTurnUsage,
          lastTurnDurationMs: lastTurnDuration(timelineEntries, activeTurnId),
          currentTurnStartedAt: null,
        };
        activeTurnId = null;
        turnBaselineUsage = null;
        completedTurnId = null;
        completedTurnBaseline = null;
      }

      if (usage && usage !== previousUsage) {
        stats = { ...stats, totalUsage: usage };
        previousUsage = usage;
      }
      stats = {
        ...stats,
        currentTurnStartedAt: activeTurn?.turnId === completedTurnId
          ? null
          : activeTurn?.startedAt ?? stats.currentTurnStartedAt,
      };
      publishStats();
    };

    const applyStreamEvent = (event: AgentStreamEvent, timestamp: string) => {
      if (event.type === "turn_started") {
        activeTurnId = event.turnId ?? activeTurnId;
        turnBaselineUsage = agentHandle.current()?.lastUsage ?? previousUsage ?? {};
        completedTurnId = null;
        completedTurnBaseline = null;
        stats = { ...stats, currentTurnStartedAt: timestamp };
        publishStats();
        return;
      }
      if (
        event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_canceled"
      ) {
        const finishedTurnId = event.turnId ?? activeTurnId;
        const currentUsage = agentHandle.current()?.lastUsage ?? null;
        const eventUsage = event.type === "turn_completed" ? event.usage ?? null : null;
        completedTurnId = finishedTurnId;
        completedTurnBaseline = turnBaselineUsage;
        const resolvedEventUsage = eventUsage
          ?? (usageChanged(currentUsage, turnBaselineUsage) ? currentUsage : null);
        stats = {
          ...stats,
          ...(resolvedEventUsage
            ? { lastTurnUsage: usageForTurn(resolvedEventUsage, turnBaselineUsage) ?? resolvedEventUsage }
            : {}),
          lastTurnDurationMs: lastTurnDuration(timelineEntries, finishedTurnId),
          currentTurnStartedAt: null,
        };
        if (resolvedEventUsage) completedTurnBaseline = null;
        publishStats();
        return;
      }
      updateAgentStats();
    };

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
          timelineEntries = mergeTimelineEntries(timeline.entries, timelineEntries);
          updateAgentStats();
          if (stats.lastTurnDurationMs === null) {
            stats = {
              ...stats,
              lastTurnDurationMs: lastTurnDuration(timelineEntries, activeTurnId),
            };
          }
          setState({
            loading: false,
            error: null,
            summary: reduceTimeline(timelineEntries.map((entry) => entry.item)),
            historyTruncated: timeline.historyTruncated,
            stats,
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
    const unsubscribeAgent = agentHandle.subscribe(updateAgentStats);
    const unsubscribe = agentTimeline.subscribe((stream) => {
      if (stream.event.type === "timeline") {
        timelineEntries = [
          ...timelineEntries,
          {
            item: stream.event.item,
            timestamp: stream.timestamp,
            ...(stream.event.turnId ? { turnId: stream.event.turnId } : {}),
            ...(stream.seq !== undefined ? { seq: stream.seq } : {}),
          },
        ];
        setState((current) => ({
          ...current,
          summary: timelineEntries.length > 0
            ? reduceTimeline(timelineEntries.map((entry) => entry.item))
            : current.summary,
        }));
      }
      applyStreamEvent(stream.event, stream.timestamp);
      scheduleRefresh();
    });
    void refresh();

    return () => {
      stopped = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      unsubscribeAgent();
      unsubscribe();
    };
  }, [agentHandle, agentTimeline]);

  return state;
}
