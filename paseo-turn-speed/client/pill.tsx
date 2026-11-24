import { approx, fmtDuration, fmtPercent, fmtRate, fmtTokens } from "./format";
import type { AgentSpeedStore } from "./store";
import type { TeamView } from "./team";

export const PILL_REFRESH_MS = 500;

/** Preference fields the pill reads, kept structural so pill logic stays
 * testable without pulling in the settings schema. */
export interface PillPreferences {
  liveWindowSec: number;
  numerator: "live" | "decode" | "turn";
  showIdlePills: boolean;
  tokenFormat: "compact" | "plain";
  maxPlausibleTokPerSec: number;
}

/** Minimal button registration contract, satisfied by `PluginButtonRegistration`. */
export interface PillRegistration {
  update(patch: PillView): void;
  remove(): void;
}

export interface PillView {
  label: string;
  visible: boolean;
  title: string;
}

export function samePillView(a: PillView, b: PillView): boolean {
  return (
    a.label === b.label &&
    a.visible === b.visible &&
    a.title === b.title
  );
}

/** Number the pill leads with, per the speed-basis preference. Rates above
 * the plausibility limit are bookkeeping artifacts, not speed: show nothing
 * rather than a fabricated burst. */
function headlineTokPerSec(store: AgentSpeedStore, prefs: PillPreferences, now: number): number | null {
  const summary = store.summary(now);
  const plausible = (rate: number | null): number | null =>
    rate !== null && rate > prefs.maxPlausibleTokPerSec ? null : rate;
  if (store.isRunning() && prefs.numerator === "live") {
    const live = store.liveTokPerSec(prefs.liveWindowSec, prefs.maxPlausibleTokPerSec);
    if (live !== null) return live;
  }
  if (prefs.numerator === "turn")
    return plausible(summary.tokPerSecTurn ?? summary.tokPerSecDecode);
  return plausible(summary.tokPerSecDecode ?? summary.tokPerSecTurn);
}

export function computePillView(
  store: AgentSpeedStore,
  prefs: PillPreferences,
  now: number,
  team?: TeamView | null,
): PillView {
  const state = store.state;
  const phase = state.phase;
  if (phase === "idle") {
    return {
      label: "\u2014",
      visible: prefs.showIdlePills,
      title: "Turn speed",
    };
  }
  const summary = store.summary(now);
  const rate = headlineTokPerSec(store, prefs, now);
  const isApprox = summary.approx;
  const rateText = rate === null ? "\u2014" : fmtRate(rate);
  const waiting = summary.waiting;
  const tooling = summary.tooling;
  const teamRunning = team && phase === "running" && team.running > 0 ? team : null;
  // Keep the composer label numeric; details and state remain accessible in the title.
  const titleParts = [`Turn speed ${approx(rateText, isApprox)} tok/s decode`];
  if (waiting) titleParts.push("waiting");
  if (tooling) titleParts.push("tool running");
  if (teamRunning) {
    // Keep the sheet title on one phone line: the short `N sub` form matches
    // the pill label; the full breakdown is in the popover body.
    const teamLabel = `${teamRunning.running} sub`;
    titleParts.push(
      teamRunning.liveTokPerSec === null
        ? teamLabel
        : `${teamLabel} @ ${approx(fmtRate(teamRunning.liveTokPerSec), teamRunning.approx)} tok/s`,
    );
  }
  if (summary.estTokens > 0) {
    titleParts.push(`${approx(fmtTokens(summary.estTokens, prefs.tokenFormat), isApprox)} tok`);
  }
  if (summary.prefillMs !== null) titleParts.push(`TTFT ${fmtDuration(summary.prefillMs)}`);
  if (summary.cacheHitRate !== null) titleParts.push(`cache ${fmtPercent(summary.cacheHitRate)}`);
  return {
    label: rateText,
    visible: true,
    title: titleParts.join(" \u00b7 "),
  };
}

export interface PillRegistrationHandle {
  /** Re-evaluates the pill immediately (e.g. after a settings change) without
   * waiting for the next store event. Still a no-op when the view is unchanged. */
  refresh(): void;
  destroy(): void;
}

/**
 * Registers a composer pill for one agent and keeps its label fresh: redraws
 * on store changes (throttled), runs a slow heartbeat only while a turn is
 * running, and skips `registration.update()` whenever the rendered fields are
 * unchanged so idle agents do not churn the host button store.
 */
export function bindPill(
  register: (initial: PillView) => PillRegistration,
  store: AgentSpeedStore,
  getPrefs: () => PillPreferences,
  now: () => number,
  getTeam?: () => TeamView | null,
): PillRegistrationHandle {
  const view = (t: number) =>
    computePillView(store, getPrefs(), t, store.isRunning() && getTeam ? getTeam() : null);
  const first = view(now());
  const registration = register(first);
  let lastView: PillView = first;
  let lastPaint = Number.NEGATIVE_INFINITY;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let wasRunning = store.isRunning();
  let destroyed = false;

  const stopHeartbeat = () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const syncHeartbeat = () => {
    if (destroyed) return;
    if (store.isRunning()) {
      if (heartbeat === null) {
        heartbeat = setInterval(() => {
          if (destroyed || !store.isRunning()) {
            stopHeartbeat();
            return;
          }
          paint(false);
        }, PILL_REFRESH_MS);
      }
    } else {
      stopHeartbeat();
    }
  };

  const paint = (force: boolean) => {
    if (destroyed) return;
    const t = now();
    if (!force && t - lastPaint < PILL_REFRESH_MS) {
      if (pendingTimer === null) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          paint(true);
        }, PILL_REFRESH_MS);
      }
      return;
    }
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    lastPaint = t;
    const viewNow = view(t);
    if (samePillView(lastView, viewNow)) return;
    lastView = viewNow;
    registration.update({
      label: viewNow.label,
      visible: viewNow.visible,
      title: viewNow.title,
    });
  };

  const unsubscribe = store.subscribe(() => {
    const running = store.isRunning();
    const phaseChanged = running !== wasRunning;
    wasRunning = running;
    syncHeartbeat();
    // Flush phase transitions (start/end) immediately so a finished turn never
    // lingers with a running icon or a dangling throttle timer.
    paint(phaseChanged);
  });
  syncHeartbeat();

  return {
    refresh() {
      if (destroyed) return;
      wasRunning = store.isRunning();
      syncHeartbeat();
      paint(true);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      stopHeartbeat();
      registration.remove();
    },
  };
}
