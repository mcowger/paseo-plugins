import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTeam, type TeamMemberInput } from "./team";
import { initialMeterState, type TurnSummary } from "./meter";
import type { AgentSpeedStore } from "./store";

function fakeStore(opts: {
  running: boolean;
  live?: number | null;
  estTokens?: number;
  approx?: boolean;
}): AgentSpeedStore {
  const summary = {
    estTokens: opts.estTokens ?? 0,
    approx: opts.approx ?? false,
  } as TurnSummary;
  return {
    agentId: "fake",
    state: initialMeterState(),
    provider: null,
    model: null,
    everSawUsage: true,
    subscribe: () => () => undefined,
    getSnapshot: () => initialMeterState(),
    setIdentity: () => undefined,
    dispatch: () => undefined,
    liveTokPerSec: () => opts.live ?? null,
    summary: () => summary,
    isRunning: () => opts.running,
  } as unknown as AgentSpeedStore;
}

function member(id: string, store: AgentSpeedStore): TeamMemberInput {
  return { id, title: id, model: null, store };
}

test("team sums live rates and tokens over running members only", () => {
  const team = summarizeTeam(
    [
      member("a", fakeStore({ running: true, live: 40, estTokens: 500 })),
      member("b", fakeStore({ running: true, live: 10, estTokens: 100 })),
      member("c", fakeStore({ running: false, live: 999, estTokens: 4000 })),
    ],
    2,
    1000,
  );
  assert.equal(team.running, 2);
  assert.equal(team.liveTokPerSec, 50);
  assert.equal(team.estTokens, 600);
  assert.equal(team.approx, false);
});

test("team live rate stays usable while some members have no live number", () => {
  const team = summarizeTeam(
    [
      member("a", fakeStore({ running: true, live: null, estTokens: 10 })),
      member("b", fakeStore({ running: true, live: 7, estTokens: 10 })),
    ],
    2,
    1000,
  );
  assert.equal(team.liveTokPerSec, 7);
  const blind = summarizeTeam([member("a", fakeStore({ running: true, live: null }))], 2, 1000);
  assert.equal(blind.liveTokPerSec, null);
});

test("team is approximate when any member is approximate", () => {
  const team = summarizeTeam(
    [
      member("a", fakeStore({ running: true, estTokens: 5 })),
      member("b", fakeStore({ running: true, estTokens: 5, approx: true })),
    ],
    2,
    1000,
  );
  assert.equal(team.approx, true);
});

test("finished members are listed after running ones, big first", () => {
  const team = summarizeTeam(
    [
      member("done-small", fakeStore({ running: false, estTokens: 1 })),
      member("run-small", fakeStore({ running: true, estTokens: 5 })),
      member("done-big", fakeStore({ running: false, estTokens: 900 })),
      member("run-big", fakeStore({ running: true, estTokens: 500 })),
    ],
    2,
    1000,
  );
  assert.deepEqual(
    team.members.map((m) => m.id),
    ["run-big", "run-small", "done-big", "done-small"],
  );
});

test("empty team is safe", () => {
  const team = summarizeTeam([], 2, 1000);
  assert.equal(team.running, 0);
  assert.equal(team.liveTokPerSec, null);
  assert.equal(team.estTokens, 0);
});
