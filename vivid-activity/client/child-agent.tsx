import { translator } from "../shared/i18n";
import { useI18n } from "./i18n-client";
import { t } from "../shared/text";
import { useAgent, useRpc } from "@getpaseo/plugin/client";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useRef, useState } from "react";

import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import { Button, StatusDot, type Tone } from "./kit";
import { Breathe } from "./motion";
import { useCardVisibility } from "./visibility";
import { useForeground } from "./use-foreground";
import {
  CHILD_QUIET_READ_MS,
  CHILD_REMOTE_POLL_MS,
  childFeedHold,
  childStatus,
  childFeedStart,
  childFeedStep,
  type CardVisibility,
  type ChildFeedEvent,
  type ChildFeedHold,
  type ChildFeedState,
} from "../shared/child-agent";
import type { ActivityPalette } from "../shared/presentation";
import { statusLabel } from "../shared/vivid-model";
import { childSummaryRpc, type ChildSummaryOutput, type ChildSummaryRow } from "../shared/child-summary";
import { createChildRefresh } from "./child-refresh";

type Theme = PluginTimelineItemProps["theme"];

interface ChildTimelineState {
  /** The child as the card's own handle last heard of it (a status check, a live update, a read); null: gone. */
  agent: ChildSummaryOutput["agent"];
  /** The handle has heard about the child at all; until then the app's agent list speaks for it. */
  heard: boolean;
  entries: readonly ChildSummaryRow[];
  loading: boolean;
  error: string | null;
  /** 0.6.0: the daemon could not say whether the child is loaded (its status check failed), so nothing was read. */
  unconfirmed: boolean;
  /** 0.9.1: the other host the child runs on (Paseo 0.13 connected hosts), as the server named it; null: this host. */
  host: string | null;
  /** 0.9.1: that host cannot be reached now. */
  offline: boolean;
}

const EMPTY_STATE: ChildTimelineState = {
  agent: null,
  heard: false,
  entries: [],
  loading: false,
  error: null,
  unconfirmed: false,
  host: null,
  offline: false,
};

/** 0.5.0: what the card says while it does not read on its own (shared/child-agent.ts childFeedHold). */
const ASLEEP_NOTES: Partial<Record<NonNullable<ChildFeedHold>, string>> = {
  get closed() { return t("ui.thisSubagentIsClosedUnloaded"); },
  get unknown() { return t("ui.thisSubagentIsMissingFrom"); },
};
/** 0.6.0: the status check failed (connection, timeout), so the card could not tell whether reading would load the child. */
const unconfirmedNote = () => t("ui.theSubagentSLoadedState");

export function ChildAgentTimeline({
  agentId,
  serverId,
  theme,
  palette,
  styles,
}: {
  agentId: string;
  /** The host `create_agent` reported (Paseo 0.13), so a child on another host is read there. */
  serverId?: string;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const rootRef = useRef<View>(null);
  const visibility = useCardVisibility(rootRef);
  const foreground = useForeground();
  const feed = useChildFeed(agentId, foreground, visibility, serverId);
  const entries = feed.view.entries;
  const status = feed.status;
  // 0.10: a sub-agent waiting for you, or one that failed, says so loudly on its parent's row (from the server's read).
  const waiting = status === "running" || status === "initializing" ? feed.view.agent?.waiting ?? null : null;
  const errorLine = status === "error" ? feed.view.agent?.error ?? null : null;
  const statusColor = waiting ? theme.colors.statusWarning : status ? childStatusColor(status, palette) : palette.categoryColors.agent;
  // A child this app does not list may run on another host: until its server says, it is being looked up, not missing.
  const lookingUp = !!serverId && !feed.view.heard && feed.hold === "unknown";
  const note = feed.view.offline ? t("ui.childHostOffline", { host: feed.view.host ?? "" })
    : feed.hold && !lookingUp ? ASLEEP_NOTES[feed.hold] : feed.view.unconfirmed ? unconfirmedNote() : undefined;

  return (
    <View ref={rootRef} style={styles.childTimelineSection}>
      <View style={styles.childTimelineHeader}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0 }}>
          <Text style={styles.detailLabel}>{t("ui.liveSubagentActivity")}</Text>
          {feed.view.host ? (
            <Text numberOfLines={1} style={[styles.paseoListItemMeta, { flexShrink: 1 }]}>{t("ui.childOnHost", { host: feed.view.host })}</Text>
          ) : null}
        </View>
        {waiting ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Breathe><StatusDot theme={theme} tone="warning" size={7} /></Breathe>
            <Text style={[styles.paseoListItemMeta, { color: statusColor, fontWeight: "700" }]}>
              {waiting === "question" ? t("ui.childAsks") : t("ui.childWaitsApproval")}
            </Text>
          </View>
        ) : status ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {status === "running" || status === "initializing" ? (
              <Breathe><StatusDot theme={theme} tone={childStatusTone(status)} size={7} /></Breathe>
            ) : (
              <StatusDot theme={theme} tone={childStatusTone(status)} size={7} />
            )}
            <Text style={[styles.paseoListItemMeta, { color: statusColor }]}>
              {statusLabel(status)}
            </Text>
          </View>
        ) : null}
      </View>
      {waiting ? (
        <Text style={[styles.mutedText, { color: theme.colors.statusWarning }]}>
          {waiting === "question" ? t("ui.childAsksNote") : t("ui.childWaitsApprovalNote")}
        </Text>
      ) : errorLine ? (
        <Text numberOfLines={2} style={[styles.mutedText, { color: theme.colors.statusDanger }]}>
          {t("ui.childFailedNote", { error: errorLine })}
        </Text>
      ) : null}
      {note ? (
        <View style={{ gap: 6, alignItems: "flex-start" }}>
          <Text style={styles.mutedText}>{note}</Text>
          <Button
            theme={theme}
            size="sm"
            tone="fuchsia"
            icon="Eye"
            label={entries.length > 0 ? t("ui.readOnceMore") : t("ui.viewActivity")}
            accessibilityLabel={entries.length > 0 ? t("ui.readSubagentActivityOnceMore") : t("ui.viewSubagentActivity")}
            busy={feed.view.loading}
            onPress={feed.readNow}
          />
        </View>
      ) : null}
      {feed.view.error ? (
        <Text style={styles.empty}>{t("ui.childReadFailed", { error: feed.view.error })}</Text>
      ) : feed.view.loading && entries.length === 0 ? (
        <Text style={styles.empty}>{t("ui.readingSubagentActivity")}</Text>
      ) : entries.length === 0 ? (
        note ? null : <Text style={styles.empty}>{feed.hold ? t("ui.readingSubagentActivity") : t("ui.noSubagentActivityYet")}</Text>
      ) : (
        <View style={styles.childTimelineList}>
          {entries.map((entry) => (
            <ChildTimelineRow
              key={entry.k}
              row={entry}
              palette={palette}
              styles={styles}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** Reads compact summaries, driven by the host's Agent updates; never subscribes to a child timeline. */
export function useChildFeed(agentId: string, foreground: boolean, visibility: CardVisibility, serverId?: string) {
  useI18n();
  const catalog = translator();
  const rpc = useRpc(childSummaryRpc);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  // The app already maintains these Agent records; observing them adds no list/timeline subscription.
  const listed = useAgent(agentId, (agent) => agent.status);
  const stamp = useAgent(agentId, (agent) => `${agent.status}|${agent.updatedAt}|${agent.lastActivityAt}`);
  const [view, setView] = useState<ChildTimelineState>(EMPTY_STATE);
  // 0.9.1: a child on another host is not in this app's list for this host, so its updates never arrive here: what the
  // card's own reads found stands in for them.
  const remote = view.host !== null;
  const listedSignal = remote ? null : listed;
  const stampSignal = remote ? `remote|${view.agent?.status ?? ""}` : stamp;
  const listedRef = useRef(listed);
  listedRef.current = listed;
  const status = childStatus({ heard: view.heard, agent: view.agent, listed });
  const hold = childFeedHold({ foreground, visibility, status });
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const runningRef = useRef(false);
  const dispatchRef = useRef<((event: ChildFeedEvent) => void) | null>(null);
  const previousSignal = useRef({ agentId, listed: listedSignal, stamp: stampSignal, remote });
  const previousAgent = useRef(agentId);

  useEffect(() => {
    let disposed = false;
    const start = childFeedStart(holdRef.current);
    let state: ChildFeedState = start.state;
    // A catalog change drops translated summaries, but must retain a confirmed closed/missing state.
    // The host list may still say running; forgetting that state could wake an unloaded child.
    const sameAgent = previousAgent.current === agentId;
    previousAgent.current = agentId;
    setView((current) => sameAgent
      ? { ...EMPTY_STATE, agent: current.agent, heard: current.heard, unconfirmed: current.unconfirmed, host: current.host, offline: current.offline }
      : EMPTY_STATE);
    const refresh = createChildRefresh({
      allowed: () => holdRef.current === null,
      async read(manual, statusOnly) {
        if (disposed) return;
        if (agentId.startsWith("provider:")) {
          setView({ ...EMPTY_STATE, heard: true });
          return;
        }
        const version = state.version;
        setView((current) => ({ ...current, loading: !statusOnly, error: null }));
        try {
          const response = await rpcRef.current({ agentId, manual, statusOnly, ...(serverId ? { serverId } : {}) });
          if (disposed) return;
          // A newer host update already queued a catch-up. An older closed/missing answer must not close its gate
          // before it runs. Successful previews can still be shown during a continuous stream of newer updates.
          if (version !== state.version && (response.status !== "ok" || response.agent?.status === "closed")) {
            setView((current) => ({ ...current, loading: false }));
            return;
          }
          // 0.6.0 (grok-F9, pi-F2): the daemon could not confirm the child is loaded, so the server read nothing. Not a
          // read: the next host update or hold change asks again.
          if (response.status === "unconfirmed") {
            setView((current) => ({ ...current, loading: false, unconfirmed: true }));
            return;
          }
          // 0.9.1: the child's host is out of reach: keep what was read, say so, and ask again later (the remote poll).
          if (response.status === "offline") {
            setView((current) => ({ ...current, agent: null, heard: true, loading: false, error: null, unconfirmed: false, host: response.host ?? current.host ?? serverId ?? null, offline: true }));
            return;
          }
          if (!statusOnly) state = childFeedStep(state, { type: "read", version }).state;
          setView((current) => ({
            agent: response.agent, heard: true,
            entries: statusOnly || response.status !== "ok" ? current.entries : response.rows,
            loading: false, error: null, unconfirmed: false, host: response.host ?? null, offline: false,
          }));
        } catch (error) {
          if (!disposed) setView((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }));
        }
      },
    });
    const dispatch = (event: ChildFeedEvent): void => {
      if (disposed) return;
      const step = childFeedStep(state, event);
      state = step.state;
      if (step.check) refresh.request({ statusOnly: true, immediate: event.type === "changed" && event.immediate });
      if (!step.read) return;
      const manual = event.type === "manual";
      const immediate = manual || (event.type === "changed" && event.immediate) || event.type === "hold";
      refresh.request({ manual, immediate, quiet: event.type === "quiet" });
    };
    dispatchRef.current = dispatch;
    if (start.read) refresh.request({ immediate: true });
    // 0.9.1: not in this app's list but placed on a host: ask where it runs (it may be another host) instead of giving up.
    else if (serverId && listedRef.current == null) refresh.request({ statusOnly: true, immediate: true });
    return () => { disposed = true; dispatchRef.current = null; refresh.dispose(); };
  }, [agentId, serverId, catalog.language, catalog.hash]);

  useEffect(() => {
    dispatchRef.current?.({ type: "hold", hold, running: runningRef.current });
  }, [hold]);
  useEffect(() => {
    runningRef.current = status === "running" || status === "initializing";
  }, [status]);
  // 0.6.0-local.5: host updates are the signal, but a running child need not send any (an ACP child reporting no usage
  // sends none until its turn ends), and the card would stand still. While it runs and the card may read, ten quiet
  // seconds read once more; each host update starts the quiet spell again, so a child that reports reads as before.
  // codex-vivid-merge-F1: the quiet spell is not a host update, so it leaves an answer on its way current (a 「closed」
  // that takes 11 s still closes the card), and it adds nothing while a read is on its way or queued.
  useEffect(() => {
    if (hold !== null || !(status === "running" || status === "initializing")) return;
    const timer = setInterval(() => dispatchRef.current?.({ type: "quiet" }), CHILD_QUIET_READ_MS);
    return () => clearInterval(timer);
  }, [hold, status, stampSignal]);
  // 0.9.1: a child on another host that is not running (idle, closed, or its host out of reach) may start again with no
  // word to this app. While the card is on screen, its status is asked now and then; a change reads it as usual.
  const onScreen = foreground && visibility !== "hidden" && visibility !== "pending";
  useEffect(() => {
    if (!remote || !onScreen || (hold === "unknown" && !view.offline) || status === "running" || status === "initializing") return;
    const timer = setInterval(() => dispatchRef.current?.({ type: "poll" }), CHILD_REMOTE_POLL_MS);
    return () => clearInterval(timer);
  }, [remote, onScreen, hold, status, view.offline]);
  useEffect(() => {
    const previous = previousSignal.current;
    previousSignal.current = { agentId, listed: listedSignal, stamp: stampSignal, remote };
    // Learning that the child runs elsewhere swaps the signals' source; that alone is no news about the child.
    if (previous.agentId !== agentId || previous.remote !== remote || (previous.listed === listedSignal && previous.stamp === stampSignal)) return;
    dispatchRef.current?.({ type: "changed", immediate: previous.listed !== listedSignal });
  }, [agentId, listedSignal, stampSignal, remote]);

  const readNow = useCallback(() => dispatchRef.current?.({ type: "manual" }), []);
  return { view, status, hold, readNow };
}

function ChildTimelineRow({ row, palette, styles }: { row: ChildSummaryRow; palette: ActivityPalette; styles: ActivityStyles }) {
  const color = row.c === "failed" ? palette.statusColors.failed : palette.categoryColors[row.c];
  const statusColor = row.s === "running" || row.s === "completed" || row.s === "failed" || row.s === "canceled"
    ? palette.statusColors[row.s] : color;
  return (
    <View style={styles.childTimelineItem}>
      <Icon name={row.i} color={color} size={11} />
      <Text numberOfLines={1} style={styles.childTimelineItemTitle}>{row.t}</Text>
      {row.x ? <Text numberOfLines={1} style={styles.childTimelineItemSummary}>{row.x}</Text> : null}
      {row.s ? <Text style={[styles.childTimelineItemMeta, { color: statusColor }]}>{statusLabel(row.s)}</Text> : null}
    </View>
  );
}

function childStatusColor(status: string, palette: ActivityPalette): string {
  switch (status) {
    case "running":
    case "initializing":
      return palette.statusColors.running;
    case "idle":
      return palette.statusColors.completed;
    case "error":
      return palette.statusColors.failed;
    default:
      return palette.statusColors.canceled;
  }
}

/** Running blue, idle green, error red, closed grey: the plugin's state colours. */
function childStatusTone(status: string): Tone {
  switch (status) {
    case "running":
    case "initializing":
      return "info";
    case "idle":
      return "success";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}
