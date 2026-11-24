import type { PluginClientContext } from "@getpaseo/plugin/client";
import { settingsRpc } from "@getpaseo/plugin";
import { createAgentSpeedStore, type AgentSpeedStore } from "./client/store";
import { bindPill, type PillRegistrationHandle } from "./client/pill";
import { createComposerItems } from "./client/composer-item";
import { makeSpeedDetails } from "./client/details";
import { parentAgentIdOf } from "./client/links";
import {
  reconcileSnapshot,
  timestampMs,
  turnStartFromEvent,
} from "./client/lifecycle";
import { summarizeTeam, type TeamMemberInput } from "./client/team";
import { makeSettingsScreen } from "./client/settings";
import {
  DEFAULT_METER_STATE,
  DEFAULT_PREFERENCES,
  meterState,
  preferences,
  type MeterStateDoc,
  type Preferences,
} from "./shared/preferences";
import { DEFAULT_CHARS_PER_TOKEN, CAL_MAX } from "./client/meter";

// Structural type derivation keeps `@getpaseo/client` out of the client
// bundle: only types provided through the plugin context are used.
type AgentsApi = PluginClientContext["paseo"]["agents"];type AgentHandle = ReturnType<AgentsApi["ref"]>;
type TimelineEvent = Parameters<Parameters<AgentHandle["timeline"]["subscribe"]>[0]>[0];
type StreamEvent = TimelineEvent["event"];
type AgentUpdate = Parameters<Parameters<AgentHandle["subscribe"]>[0]>[0];
type AgentSnapshot = Extract<AgentUpdate, { kind: "upsert" }>["agent"];
type AgentListResult = Awaited<ReturnType<AgentsApi["list"]>>;
type AgentEntry = AgentListResult["entries"][number];

interface Attachment {
  store: AgentSpeedStore;
  refreshPill(): void;
  detach(): void;
}

/** Every preference is a primitive, so the compared keys come from the schema
 * defaults: a field added to `preferences.schema` is diffed without touching
 * this function, instead of silently reading as "no change" forever. */
function samePreferences(a: Preferences, b: Preferences): boolean {
  const keys = Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[];
  return keys.every((key) => a[key] === b[key]);
}

/** Paseo normalizes subagent-spawning tool calls to the name "subagent";
 * providers that map them richly use the `sub_agent` detail type instead.
 * (Measured on Paseo 0.12 + OpenCode: name="subagent", detail.type="unknown".) */
const SUB_AGENT_TOOL_NAME = /^sub[-_. ]?agent$/i;

function isSubAgentCall(item: { name: string; detail: { type?: string } }): boolean {
  return item.detail.type === "sub_agent" || SUB_AGENT_TOOL_NAME.test(item.name);
}

/** Open calls of one attached agent, with the callbacks that re-derive the
 * meter's parked intervals whenever a set changes. */
interface OpenCalls {
  /** Running subagent calls: the parent's own model is delegated. */
  subCalls: Set<string>;
  /** Running tool calls (shell, edit, fetch, …): the model waits for a result. */
  toolCalls: Set<string>;
  onSubChange(): void;
  onToolChange(): void;
}

const CAL_FLUSH_MS = 2000;

export default function contribute(client: PluginClientContext) {
  const composerItems = createComposerItems();
  const lifetime = new AbortController();
  const attached = new Map<string, Attachment>();
  const calibration = new Map<string, number>();
  const pendingCalibration = new Map<string, number>();
  // Subagent topology, fed by the agent-list subscription: the latest
  // snapshot per agent, which agent is whose child, which provider session
  // id belongs to which agent, and each attachment's team-change callback.
  const snapshots = new Map<string, AgentSnapshot>();
  const childParents = new Map<string, string>();
  const sessionOwners = new Map<string, string>();
  const teamWatchers = new Map<string, Set<() => void>>();
  let prefs: Preferences = DEFAULT_PREFERENCES;
  let calFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let listSubscription: { release(): Promise<void> } | null = null;

  const aborted = () => lifetime.signal.aborted;
  const logError = (...args: unknown[]) => {
    if (!aborted()) console.error("turn-speed:", ...args);
  };
  /** A terminal event for a turn this meter never followed (its start was
   * lost) must not close the current turn, replace its outcome, or clear the
   * waits and tool calls that belong to it. An empty id is no id: the reducer
   * treats it the same way. */
  const belongsToCurrentTurn = (
    store: AgentSpeedStore,
    turnId: string | null | undefined,
  ): boolean => {
    const id = turnId || null;
    if (id === null) return true;
    const current = store.state.turnId;
    return current === null || current === id;
  };

  const notifyTeam = (parentId: string): void => {
    for (const listener of teamWatchers.get(parentId) ?? []) {
      try {
        listener();
      } catch (error) {
        logError(`team update failed for ${parentId}`, error);
      }
    }
  };

  const linkChild = (childId: string, parentId: string): void => {
    if (childId === parentId) return;
    const current = childParents.get(childId);
    if (current === parentId) return;
    childParents.set(childId, parentId);
    console.log(`turn-speed: linked child ${childId.slice(0, 8)} -> parent ${parentId.slice(0, 8)}`);
    notifyTeam(parentId);
    if (current) notifyTeam(current);
  };

  /** Fold a fresh agent snapshot into the topology maps. */
  const remember = (agent: AgentSnapshot): void => {
    const previous = snapshots.get(agent.id);
    snapshots.set(agent.id, agent);
    const sessionId = agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId ?? null;
    if (sessionId) sessionOwners.set(sessionId, agent.id);
    const parent = parentAgentIdOf(agent);
    if (parent) linkChild(agent.id, parent);
    // A child starting or finishing its turn changes the parent's team even
    // when the link itself did not change. Deferred one microtask so the
    // calling handler finishes seeding the child's own store first.
    if (
      parent &&
      previous &&
      (previous.status !== agent.status || previous.archivedAt !== agent.archivedAt)
    ) {
      queueMicrotask(() => notifyTeam(parent));
    }
  };

  /** Live attached children of `parentId`, for the team view. */
  const teamMembers = (parentId: string): TeamMemberInput[] => {
    const members: TeamMemberInput[] = [];
    for (const [childId, pid] of childParents) {
      if (pid !== parentId) continue;
      const attachment = attached.get(childId);
      const snapshot = snapshots.get(childId);
      if (!attachment || !snapshot) continue;
      if (snapshot.archivedAt || snapshot.status === "closed") continue;
      members.push({
        id: childId,
        title: snapshot.title ?? null,
        model: snapshot.model ?? null,
        store: attachment.store,
      });
    }
    return members;
  };

  const effectiveCpt = (model: string | null): number => {
    if (prefs.manualCharsPerToken !== null) return prefs.manualCharsPerToken;
    if (model) {
      const learned = calibration.get(model);
      if (learned !== undefined) return learned;
    }
    return DEFAULT_CHARS_PER_TOKEN;
  };

  const refreshPrefs = async (): Promise<void> => {
    try {
      const read = await client.rpc(settingsRpc(preferences.id).read, {});
      if (read.status === "ready") {
        const parsed = preferences.schema.safeParse(read.values);
        if (parsed.success) {
          const changed = !samePreferences(prefs, parsed.data);
          prefs = parsed.data;
          if (changed) {
            for (const attachment of attached.values()) attachment.refreshPill();
          }
        }
      }
    } catch (error) {
      logError("reading preferences failed", error);
    }
  };

  const refreshCalibration = async (): Promise<void> => {
    try {
      const read = await client.rpc(settingsRpc(meterState.id).read, {});
      if (read.status === "ready") {
        const parsed = meterState.schema.safeParse(read.values);
        if (parsed.success) {
          calibration.clear();
          const saturated: string[] = [];
          for (const [model, cpt] of Object.entries(parsed.data.calibration)) {
            // Entries pinned at CAL_MAX were produced by the pre-1.2 bug
            // that charged reasoning characters against reasoning-free
            // output tokens: drop them and let them relearn cleanly.
            if (cpt >= CAL_MAX) saturated.push(model);
            else calibration.set(model, cpt);
          }
          if (saturated.length > 0) {
            void mutateDoc(meterState, (doc) => {
              const next = { ...doc.calibration };
              for (const model of saturated) delete next[model];
              return { calibration: next };
            });
          }
        }
      }
    } catch (error) {
      logError("reading calibration failed", error);
    }
  };

  /** Read-modify-write a settings document; one retry on revision conflict. */
  const mutateDoc = async (
    def: typeof meterState,
    mutate: (values: MeterStateDoc) => MeterStateDoc,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const read = await client.rpc(settingsRpc(def.id).read, {});
        if (read.status !== "ready") return;
        const parsed = def.schema.safeParse(read.values);
        const current = parsed.success ? parsed.data : DEFAULT_METER_STATE;
        const next = mutate(current);
        const write = await client.rpc(settingsRpc(def.id).write, {
          revision: read.revision,
          values: JSON.parse(JSON.stringify(next)),
        });
        if (write.status === "saved") return;
        if (write.status !== "conflict") return;
      } catch (error) {
        logError("settings write failed", error);
        return;
      }
    }
  };

  const flushCalibration = (): void => {
    calFlushTimer = null;
    if (aborted() || pendingCalibration.size === 0) return;
    const batch = Object.fromEntries(pendingCalibration);
    pendingCalibration.clear();
    void mutateDoc(meterState, (doc) => ({
      calibration: { ...doc.calibration, ...batch },
    })).then(refreshPrefs);
  };

  const onCalibration = (model: string, charsPerToken: number): void => {
    calibration.set(model, charsPerToken);
    pendingCalibration.set(model, charsPerToken);
    if (calFlushTimer === null) calFlushTimer = setTimeout(flushCalibration, CAL_FLUSH_MS);
  };

  function mapUsage(usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    contextWindowMaxTokens?: number;
    contextWindowUsedTokens?: number;
  }) {
    return {
      input: usage.inputTokens,
      cached: usage.cachedInputTokens,
      output: usage.outputTokens,
      ctxMax: usage.contextWindowMaxTokens,
      ctxUsed: usage.contextWindowUsedTokens,
    };
  }

  function onStreamEvent(
    store: AgentSpeedStore,
    event: StreamEvent,
    eventTimestamp: string | null | undefined,
    reseed: () => void,
    waits: Set<string>,
    agentId: string,
    calls: OpenCalls,
  ): void {
    const at = Date.now();
    switch (event.type) {
      case "turn_started": {
        waits.clear();
        calls.subCalls.clear();
        calls.toolCalls.clear();
        // Anchor to the daemon's timestamp from this very message: a ref()
        // snapshot updates on another channel and can still hold the previous
        // turn's start, which would charge that whole turn to this one.
        const start = turnStartFromEvent(eventTimestamp, at);
        // Paseo's own turn footer counts from the user's message row. When the
        // daemon announces `turn_started` later than that row, this meter's
        // clock is short by the difference, so log the anchor it chose and how
        // long this message took to arrive.
        console.log(
          `turn-speed: turn started [${agentId.slice(0, 8)}]` +
            ` anchor ${start.source}` +
            ` lead ${((at - start.at) / 1000).toFixed(1)}s`,
        );
        store.dispatch({
          t: "turn_started",
          at: start.at,
          turnId: event.turnId || null,
        });
        calls.onSubChange();
        calls.onToolChange();
        break;
      }
      case "turn_completed":
        if (!belongsToCurrentTurn(store, event.turnId)) break;
        waits.clear();
        calls.subCalls.clear();
        calls.toolCalls.clear();
        store.dispatch({
          t: "turn_ended",
          at,
          kind: "completed",
          turnId: event.turnId || null,
          usage: event.usage ? mapUsage(event.usage) : undefined,
          maxTokPerSec: prefs.maxPlausibleTokPerSec,
        });
        calls.onSubChange();
        calls.onToolChange();
        void refreshPrefs();
        break;
      case "turn_failed":
        if (!belongsToCurrentTurn(store, event.turnId)) break;
        waits.clear();
        calls.subCalls.clear();
        calls.toolCalls.clear();
        store.dispatch({
          t: "turn_ended",
          at,
          kind: "failed",
          turnId: event.turnId || null,
          note: event.error,
        });
        calls.onSubChange();
        calls.onToolChange();
        break;
      case "turn_canceled":
        if (!belongsToCurrentTurn(store, event.turnId)) break;
        waits.clear();
        calls.subCalls.clear();
        calls.toolCalls.clear();
        store.dispatch({
          t: "turn_ended",
          at,
          kind: "canceled",
          turnId: event.turnId || null,
          note: event.reason,
        });
        calls.onSubChange();
        calls.onToolChange();
        break;
      case "permission_requested":
      case "permission_resolved": {
        // Any request (question, tool approval, plan) means the model is
        // asleep until the user answers; pause the meter for the whole set
        // of open requests, not per request.
        if (event.type === "permission_requested") {
          const requestId = event.request?.id;
          if (!requestId) break;
          const wasIdle = waits.size === 0;
          waits.add(requestId);
          if (wasIdle) store.dispatch({ t: "user_wait_started", at });
        } else if (waits.delete(event.requestId) && waits.size === 0) {
          store.dispatch({ t: "user_wait_ended", at });
        }
        break;
      }
      case "timeline": {
        const item = event.item;
        if (item.type === "assistant_message") {
          store.dispatch({ t: "text", at, key: item.messageId ?? "assistant", text: item.text });
        } else if (item.type === "reasoning") {
          // Per-turn key: text tails survive turn boundaries, and each turn's
          // reasoning block starts fresh.
          store.dispatch({
            t: "text",
            at,
            key: `reasoning:${event.turnId ?? "current"}`,
            text: item.text,
            kind: "reasoning",
          });
        } else if (item.type === "compaction") {
          store.dispatch({ t: "compaction", at });
        } else if (item.type === "user_message") {
          composerItems.sent(agentId, item.text);
          // The other half of the comparison: Paseo's turn footer opens the
          // turn at this row, so log how far the row sits from this meter's
          // anchor. `empty` marks the row that opened the turn; without it the
          // row is a steer, which Paseo still counts inside the same turn.
          const sentAt = timestampMs(eventTimestamp);
          const opening = store.state.steps.length === 0 && store.state.totalChars === 0;
          console.log(
            `turn-speed: prompt row [${agentId.slice(0, 8)}]` +
              ` ${
                sentAt === null
                  ? "no timestamp"
                  : `${((((store.state.startedAt ?? at) - sentAt) / 1000).toFixed(1))}s before the clock`
              }` +
              ` phase ${store.state.phase}${opening ? " empty" : ""}`,
          );
        } else if (item.type === "tool_call" && isSubAgentCall(item)) {
          // A subagent call: running/closed drives the parent's delegation
          // interval, and its child session id (when the provider reports
          // one) links the child agent to this parent for the team view.
          const detail = item.detail;
          console.log(
            `turn-speed: subagent call [${agentId.slice(0, 8)}]` +
              ` ${String(item.callId).slice(0, 8)} ${item.status}`,
          );
          const childId = detail.type === "sub_agent" && detail.childSessionId
            ? sessionOwners.get(detail.childSessionId)
            : undefined;
          if (childId) linkChild(childId, agentId);
          if (item.callId) {
            if (item.status === "running") {
              if (!calls.subCalls.has(item.callId)) {
                calls.subCalls.add(item.callId);
                calls.onSubChange();
              }
            } else if (calls.subCalls.delete(item.callId)) {
              calls.onSubChange();
            }
          }
        } else if (item.type === "tool_call") {
          // Any other call (shell, edit, fetch, …): the model generates
          // nothing while it runs, and providers land the step's usage after
          // the result — so without parking the stretch, a two-minute build
          // is billed to the decode window as if it were slow decoding.
          // Subagent calls stay out of this set: they park the parent as
          // delegation, and counting them here would subtract them twice.
          if (item.callId) {
            if (item.status === "running") {
              if (!calls.toolCalls.has(item.callId)) {
                calls.toolCalls.add(item.callId);
                calls.onToolChange();
              }
            } else if (calls.toolCalls.delete(item.callId)) {
              calls.onToolChange();
            }
          }
        }
        break;
      }
      case "replacement":
      case "subscription_restored":
        // Do not replay history we never saw; the live window is local anyway.
        waits.clear();
        calls.subCalls.clear();
        calls.toolCalls.clear();
        store.dispatch({ t: "reset" });
        calls.onSubChange();
        calls.onToolChange();
        // Provider counters kept moving while we were blind: re-read them so
        // the next delta is the new work, not the whole unseen gap.
        reseed();
        break;
      case "error":
        logError(`timeline subscription error for ${event.error}`);
        break;
      default:
        break;
    }
  }

  function attach(agent: AgentSnapshot): void {
    if (aborted() || attached.has(agent.id)) return;
    remember(agent);
    const handle = client.paseo.agents.ref(agent.id);
    const store = createAgentSpeedStore({
      agentId: agent.id,
      charsPerToken: (model) => effectiveCpt(model),
      learnedCharsPerToken: (model) => calibration.get(model),
      onCalibration,
      cacheCounting: () => prefs.cacheCounting,
      now: () => Date.now(),
    });
    store.setIdentity(agent.provider, agent.model ?? null);
    // The daemon folds provider usage into the agent snapshot: every model
    // call bumps `lastUsage` and pushes an agent_update. Track changes there.
    let lastUsageSig: string | null = null;
    const observeUsage = (usage: Parameters<typeof mapUsage>[0] | null): void => {
      if (!usage) return;
      const mapped = mapUsage(usage);
      const sig = [mapped.output, mapped.input, mapped.cached, mapped.ctxUsed, mapped.ctxMax]
        .map((v) => (v === undefined ? "" : String(v)))
        .join("|");
      if (sig === lastUsageSig) return;
      lastUsageSig = sig;
      store.dispatch({
        t: "usage",
        at: Date.now(),
        usage: mapped,
        maxTokPerSec: prefs.maxPlausibleTokPerSec,
      });
    };
    // Seed the cumulative baseline synchronously from the snapshot that
    // triggered the attach, then from the handle when it is populated.
    observeUsage(agent.lastUsage ?? null);
    observeUsage(handle.lastUsage);
    // Open permission/question requests, tracked so stream events do not
    // dispatch the same transition twice.
    const pendingWaits = new Set<string>();
    // Live events are only delivered after the timeline subscription is
    // established, and the daemon keeps no replay: anything that happens
    // before `ready` is invisible. Seeding a turn before then is what leaves
    // a turn that ends inside that window running forever, so seeding waits
    // for `ready` and takes its snapshot afterwards.
    let listening = false;

    // Delegation: open sub_agent tool calls (or linked children that are
    // running) mean the agent's own model is idle while subagents work, so
    // the meter parks that time like a user wait. `subCalls` survives
    // snapshot re-delivery of the same running tool item.
    const subCalls = new Set<string>();
    let delegatedNow = false;
    const syncDelegated = (): void => {
      let should = subCalls.size > 0;
      if (!should) {
        for (const member of teamMembers(agent.id)) {
          if (member.store.isRunning()) {
            should = true;
            break;
          }
        }
      }
      if (store.state.phase !== "running") {
        // Outside a turn there is no interval to open or close; drop the
        // flag so the next turn re-evaluates from scratch.
        delegatedNow = false;
        return;
      }
      if (should === delegatedNow) return;
      delegatedNow = should;
      console.log(`turn-speed: delegation ${should ? "on" : "off"} [${agent.id.slice(0, 8)}]`);
      store.dispatch({ t: should ? "delegated_started" : "delegated_ended", at: Date.now() });
    };
    // Tools: while any call is open the agent's own model produces nothing, so
    // the meter parks that stretch out of the decode windows and the turn rate.
    // Concurrent calls share one interval, and a `running` item the host
    // re-delivers must not open a second one.
    const toolCalls = new Set<string>();
    let toolingNow = false;
    const syncToolWaits = (): void => {
      const should = toolCalls.size > 0;
      if (store.state.phase !== "running") {
        // Outside a turn there is no interval to open or close; drop the flag
        // so the next turn re-evaluates from scratch.
        toolingNow = false;
        return;
      }
      if (should === toolingNow) return;
      toolingNow = should;
      console.log(`turn-speed: tool ${should ? "running" : "idle"} [${agent.id.slice(0, 8)}]`);
      store.dispatch({ t: should ? "tool_started" : "tool_ended", at: Date.now() });
    };
    const calls: OpenCalls = {
      subCalls,
      toolCalls,
      onSubChange: syncDelegated,
      onToolChange: syncToolWaits,
    };
    // One snapshot, one ordered set of actions: identify the turn, restore the
    // waits that belong to it, then end a turn whose terminal event was lost.
    // The last step is provisional, so a real terminal event still decides the
    // outcome.
    function reconcile(snapshot: AgentSnapshot): void {
      const result = reconcileSnapshot(store.state, snapshot, Date.now(), { seed: listening });
      if (result.pendingWaits) {
        pendingWaits.clear();
        for (const requestId of result.pendingWaits) pendingWaits.add(requestId);
      }
      for (const action of result.actions) {
        store.dispatch(action);
        if (action.t === "turn_ended" && action.provisional) {
          subCalls.clear();
          toolCalls.clear();
          void refreshPrefs();
        }
      }
      // Re-evaluate the delegation after the snapshot: it may have just
      // established the turn, and children that are already running must park
      // that time instead of charging it to the parent. Without this, a parent
      // that attaches after its children would count their work as its own
      // until the next child event.
      syncDelegated();
      // A call whose `running` item landed while this agent was attaching
      // found no turn to park; re-check now that the snapshot has established
      // one. A call that started before the subscription stays unparked: items
      // carry no start timestamp to reconstruct it from.
      syncToolWaits();
    }
    // A ref() handle starts empty: without a real snapshot, the first usage
    // event after a reload would count the session-cumulative counters as
    // one giant step. Fetch the truth for that case.
    function reseed(): void {
      void handle
        .refresh()
        .then((result) => {
          const snapshot = result?.agent;
          if (!snapshot || attached.get(agent.id)?.store !== store) return;
          store.setIdentity(snapshot.provider, snapshot.model ?? null);
          observeUsage(snapshot.lastUsage ?? null);
          reconcile(snapshot);
        })
        .catch((error) => logError(`usage reseed failed for ${agent.id}`, error));
    }
    const team = () => {
      const view = summarizeTeam(
        teamMembers(agent.id),
        prefs.liveWindowSec,
        Date.now(),
        prefs.maxPlausibleTokPerSec,
      );
      // Open sub_agent tool calls count too: on provider subagents (no
      // linked Paseo child) they are the only running signal.
      const running = Math.max(view.running, subCalls.size);
      if (view.members.length === 0 && running === 0) return null;
      if (view.members.length === 0) {
        return { members: [], running, liveTokPerSec: null, estTokens: 0, approx: true };
      }
      return { ...view, running };
    };
    const teamWatchersForParent = teamWatchers.get(agent.id) ?? new Set<() => void>();
    teamWatchersForParent.add(syncDelegated);
    teamWatchers.set(agent.id, teamWatchersForParent);

    const details = makeSpeedDetails(
      store,
      () => prefs,
      () => effectiveCpt(store.model),
      () => {
        void refreshPrefs();
      },
      team,
    );
    let pillHandle: PillRegistrationHandle | null = null;
    try {
      pillHandle = bindPill(
        (initial) => composerItems.register(agent.id, initial, details),
        store,
        () => prefs,
        () => Date.now(),
        team,
      );
    } catch (error) {
      logError(`pill registration failed for agent ${agent.id}`, error);
    }

    const releaseAgentUpdates = handle.subscribe((update) => {
      if (update.kind === "remove") {
        detach(agent.id);
        return;
      }
      const snapshot = update.agent;
      remember(snapshot);
      store.setIdentity(snapshot.provider, snapshot.model ?? null);
      observeUsage(snapshot.lastUsage ?? null);
      reconcile(snapshot);
      if (snapshot.archivedAt || snapshot.status === "closed") detach(agent.id);
    });

    const timelineSub = handle.timeline.subscribe((event) => {
      try {
        onStreamEvent(
          store,
          event.event,
          "timestamp" in event ? event.timestamp : null,
          reseed,
          pendingWaits,
          agent.id,
          calls,
        );
      } catch (error) {
        logError(`timeline event failed for ${agent.id}`, error);
      }
    });
    void timelineSub.ready
      .then(() => {
        if (aborted() || attached.get(agent.id)?.store !== store) return;
        listening = true;
        // Live delivery is guaranteed from here on, and a fresh snapshot
        // recovers whatever happened before it: start and terminal events can
        // no longer fall into an uncovered window.
        reseed();
      })
      .catch((error) => logError(`timeline subscribe failed for ${agent.id}`, error));

    attached.set(agent.id, {
      store,
      refreshPill() {
        pillHandle?.refresh();
      },
      detach() {
        storeTeamWatch?.();
        storeTeamWatch = null;
        teamWatchersForParent.delete(syncDelegated);
        pillHandle?.destroy();
        releaseAgentUpdates();
        void timelineSub.release().catch(() => undefined);
      },
    });
    // A child's phase turning running/idle may not coincide with any agent
    // status update, so the parent re-evaluates delegation on every change
    // of this store too. The lookup is dynamic: links learned after attach
    // (e.g. from a sub_agent tool item) are covered as well.
    let storeTeamWatch: (() => void) | null = store.subscribe(() => {
      const parentLink = childParents.get(agent.id);
      if (parentLink) notifyTeam(parentLink);
    });
    // Children may already run (attach raced a reload): pick that up now.
    syncDelegated();
  }

  function detach(agentId: string): void {
    const attachment = attached.get(agentId);
    if (!attachment) return;
    attached.delete(agentId);
    const snapshot = snapshots.get(agentId);
    snapshots.delete(agentId);
    teamWatchers.delete(agentId);
    const parent = childParents.get(agentId);
    childParents.delete(agentId);
    if (parent) notifyTeam(parent);
    const sessionId = snapshot?.runtimeInfo?.sessionId ?? snapshot?.persistence?.sessionId ?? null;
    if (sessionId && sessionOwners.get(sessionId) === agentId) sessionOwners.delete(sessionId);
    try {
      attachment.detach();
    } catch (error) {
      logError(`detach failed for ${agentId}`, error);
    }
  }

  function syncAgents(entries: readonly AgentEntry[]): void {
    for (const entry of entries) {
      const agent = entry.agent;
      if (agent.archivedAt || agent.status === "closed") detach(agent.id);
      else {
        remember(agent);
        attach(agent);
      }
    }
  }

  async function boot(): Promise<void> {
    try {
      await Promise.all([refreshPrefs(), refreshCalibration()]);
      if (aborted()) return;
      const list = await client.paseo.agents.list({
        subscribe: {},
        page: { limit: 200 },
        signal: lifetime.signal,
      });
      if (aborted()) {
        void list.subscription.release().catch(() => undefined);
        return;
      }
      listSubscription = list.subscription;
      const releaseObserver = list.subscription.subscribe({
        snapshot: (snapshot) => syncAgents(snapshot.entries),
        update: (message) => {
          if (message.type !== "agent_update") return;
          const payload = message.payload;
          if (payload.kind === "remove") {
            detach(payload.agentId);
            return;
          }
          const agent = payload.agent;
          if (agent.archivedAt || agent.status === "closed") detach(agent.id);
          else {
            remember(agent);
            attach(agent);
          }
        },
        error: (error) => logError("agent list subscription failed", error),
      });
      cleanups.push(releaseObserver);
      syncAgents(list.entries);
    } catch (error) {
      if (!aborted()) logError("bootstrap failed", error);
    }
  }

  const cleanups: Array<() => void> = [];
  cleanups.push(client.addComposerItem({ id: "speed", Component: composerItems.Component }));
  cleanups.push(
    client.addSettingsScreen({
      id: "preferences",
      title: "Turn speed",
      icon: "Gauge",
      Component: makeSettingsScreen(() => void refreshPrefs()),
    }),
  );

  void boot();

  return () => {
    lifetime.abort();
    if (calFlushTimer !== null) {
      clearTimeout(calFlushTimer);
      calFlushTimer = null;
    }
    for (const agentId of [...attached.keys()]) detach(agentId);
    snapshots.clear();
    childParents.clear();
    sessionOwners.clear();
    teamWatchers.clear();
    if (listSubscription) {
      void listSubscription.release().catch(() => undefined);
      listSubscription = null;
    }
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Best-effort teardown.
      }
    }
    cleanups.length = 0;
    composerItems.dispose();
  };
}
