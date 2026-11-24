/**
 * Pure aggregation of subagent stores into a parent-facing team view.
 *
 * Subagents are ordinary Paseo agents with their own stores; this module
 * only folds those stores together at read time. No subscriptions, no I/O,
 * unit-testable with `node --test`.
 */

import type { AgentSpeedStore } from "./store";

export interface TeamMemberInput {
  id: string;
  title: string | null;
  model: string | null;
  store: AgentSpeedStore;
}

export interface TeamMemberView {
  id: string;
  title: string | null;
  model: string | null;
  running: boolean;
  liveTokPerSec: number | null;
  estTokens: number;
  approx: boolean;
}

export interface TeamView {
  members: readonly TeamMemberView[];
  /** Members whose turn phase is running. */
  running: number;
  /** Sum of running members' live rates; null unless at least one has one. */
  liveTokPerSec: number | null;
  /** Sum of running members' estimated turn tokens. */
  estTokens: number;
  /** True when any member's number is character-estimated. */
  approx: boolean;
}

/** A team with nobody in it. */
export const EMPTY_TEAM: TeamView = {
  members: [],
  running: 0,
  liveTokPerSec: null,
  estTokens: 0,
  approx: false,
};

/**
 * Fold child stores into one view. Non-running members are reported (the
 * popover shows who just finished) but never contribute to the sums.
 */
export function summarizeTeam(
  members: readonly TeamMemberInput[],
  windowSec: number,
  now: number,
  maxTokPerSec?: number,
): TeamView {
  const views: TeamMemberView[] = [];
  let running = 0;
  let live: number | null = null;
  let estTokens = 0;
  let approx = false;
  for (const member of members) {
    const isRunning = member.store.isRunning();
    const summary = member.store.summary(now);
    const liveTokPerSec = isRunning ? member.store.liveTokPerSec(windowSec, maxTokPerSec) : null;
    views.push({
      id: member.id,
      title: member.title,
      model: member.model,
      running: isRunning,
      liveTokPerSec,
      estTokens: summary.estTokens,
      approx: summary.approx,
    });
    if (!isRunning) continue;
    running += 1;
    estTokens += summary.estTokens;
    approx = approx || summary.approx;
    if (liveTokPerSec !== null) live = (live ?? 0) + liveTokPerSec;
  }
  views.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return b.estTokens - a.estTokens;
  });
  return { members: views, running, liveTokPerSec: live, estTokens, approx };
}
