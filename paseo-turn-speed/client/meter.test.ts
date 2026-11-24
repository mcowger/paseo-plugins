import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheStats,
  calibrate,
  initialMeterState,
  reduceMeter,
  summarizeTurn,
  REASONING_CHARS_PER_TOKEN,
  type MeterState,
} from "./meter";

const CPT = 4;

function startTurn(state: MeterState = initialMeterState(), at = 0): MeterState {
  return reduceMeter(state, { t: "turn_started", at, turnId: "t1" });
}

test("snapshot text growth counts only the new characters", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "Hello" });
  s = reduceMeter(s, { t: "text", at: 1200, key: "m1", text: "Hello world" });
  assert.equal(s.totalChars, 11);
  assert.equal(s.firstTextAt, 1000);
  assert.equal(s.stepFirstTextAt, 1000);
});

test("delta text growth accumulates fragments", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "Hel" });
  s = reduceMeter(s, { t: "text", at: 1200, key: "m1", text: "lo w" });
  s = reduceMeter(s, { t: "text", at: 1400, key: "m1", text: "orld" });
  assert.equal(s.totalChars, 11);
});

test("usage closes a step: window runs from first text to usage arrival", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "text", at: 3000, key: "m1", text: "x".repeat(800) });
  s = reduceMeter(s, { t: "usage", at: 3100, usage: { output: 100, input: 50 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 100);
  // Includes the tail where tool arguments were still being generated.
  assert.equal(s.steps[0].decodeMs, 2100);
  assert.equal(s.steps[0].prefillMs, 1000);
  assert.equal(s.steps[0].waitMs, 0);
  assert.equal(s.sawUsage, true);
  assert.equal(s.liveChars, 0);
  assert.equal(s.stepFirstTextAt, null);
  assert.deepEqual(s.calibInput, { chars: 800, tokens: 100 });
});

test("multi-step turn: tool runs sit between steps, argument decode stays inside", () => {
  let s = startTurn();
  // Step 1: text 1000..2000, arguments to 2100, usage at 2100.
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "text", at: 2000, key: "m1", text: "a b" });
  s = reduceMeter(s, { t: "usage", at: 2100, usage: { output: 10 } });
  // Tool runs 2100..12100. Step 2 decodes 12100..13200.
  s = reduceMeter(s, { t: "text", at: 12100, key: "m2", text: "c" });
  s = reduceMeter(s, { t: "text", at: 13100, key: "m2", text: "c d" });
  s = reduceMeter(s, { t: "usage", at: 13200, usage: { output: 25 } });
  assert.equal(s.steps.length, 2);
  assert.equal(s.steps[1].outTokens, 15);
  assert.equal(s.steps[1].decodeMs, 1100);
  assert.equal(s.steps[1].waitMs, 10000);
  assert.equal(s.steps[1].prefillMs, 0);

  const sum = summarizeTurn(s, CPT, 14200);
  assert.equal(sum.outTokens, 25);
  assert.equal(sum.decodeMs, 1100 + 1100);
  assert.equal(sum.waitMs, 10000);
  assert.equal(sum.prefillMs, 1000);
  assert.equal(sum.totalMs, 14200);
  assert.equal(sum.tokPerSecDecode, 25 / 2.2);
});

test("cumulative counters grow per step and are never counted twice", () => {
  // OpenCode reports message-cumulative tokens: each event contains the
  // previous ones. The meter must count differences, not the raw values.
  // Rates here are synthetic, so the plausibility guard is switched off.
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 600, usage: { output: 6000 }, maxTokPerSec: Infinity });
  s = reduceMeter(s, { t: "text", at: 2000, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 2600, usage: { output: 12000 }, maxTokPerSec: Infinity });
  s = reduceMeter(s, { t: "text", at: 4000, key: "m3", text: "c" });
  s = reduceMeter(s, { t: "usage", at: 4600, usage: { output: 19000 }, maxTokPerSec: Infinity });
  const sum = summarizeTurn(s, CPT, 4600);
  assert.equal(sum.outTokens, 19000);
  assert.equal(sum.steps, 3);
  assert.equal(s.steps[1].outTokens, 6000);
  assert.equal(s.steps[2].outTokens, 7000);
});

test("a counter reset (new assistant message) counts the fresh value whole", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 18000 }, maxTokPerSec: Infinity });
  // New message: counters restart from a smaller number.
  s = reduceMeter(s, { t: "text", at: 2000, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 3000, usage: { output: 2500 }, maxTokPerSec: Infinity });
  assert.equal(s.steps.length, 2);
  assert.equal(s.steps[1].outTokens, 2500);
  assert.equal(s.prevUsageOut, 2500);
  assert.equal(summarizeTurn(s, CPT, 3000).outTokens, 20500);
});

test("turn_started keeps the observed usage baseline, not a racy snapshot", () => {
  let s = reduceMeter(initialMeterState(), { t: "usage", at: 10, usage: { output: 40, input: 900 } });
  assert.equal(s.prevUsageOut, 40);
  s = startTurn(s, 100);
  assert.equal(s.prevUsageOut, 40);
  s = reduceMeter(s, { t: "text", at: 500, key: "m1", text: "hello" });
  s = reduceMeter(s, { t: "usage", at: 1500, usage: { output: 45, input: 950 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 5);
  assert.equal(s.steps[0].inputTokens, 50);
});

test("early usage before turn_started is not lost or double counted", () => {
  // The agent_update carrying step-1 usage can beat the timeline's
  // turn_started event. The observed baseline makes the delta exact either
  // way: step 1's tokens are attributed to the previous turn's tail (idle),
  // and only genuinely new tokens open steps afterwards.
  let s = reduceMeter(initialMeterState(), { t: "usage", at: 100, usage: { output: 6000 } });
  s = startTurn(s, 200);
  s = reduceMeter(s, { t: "text", at: 300, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1300, usage: { output: 12000 }, maxTokPerSec: Infinity });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 6000);
});

test("repeated usage at completion opens no extra step", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 30 } });
  s = reduceMeter(s, { t: "turn_ended", at: 1200, kind: "completed", usage: { output: 30 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.phase, "completed");
});

test("zero-token usage does not open a step and never divides by zero", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "usage", at: 500, usage: { output: 0 } });
  assert.equal(s.steps.length, 0);
  const sum = summarizeTurn(s, CPT, 600);
  assert.equal(sum.tokPerSecDecode, null);
});

test("compaction drops the live character window", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "x".repeat(100) });
  s = reduceMeter(s, { t: "compaction", at: 200 });
  assert.equal(s.liveChars, 0);
  assert.equal(s.totalChars, 100);
});

test("no usage: numbers are estimated from characters and flagged approx", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "text", at: 2100, key: "m1", text: "x".repeat(800) });
  s = reduceMeter(s, { t: "turn_ended", at: 2200, kind: "completed" });
  const sum = summarizeTurn(s, CPT, 2200);
  assert.equal(sum.approx, true);
  assert.equal(sum.estTokens, 200);
  // Without any step, the text window stands in for the decode window.
  assert.equal(sum.decodeMs, 2000);
  assert.equal(sum.tokPerSecDecode, 200 / 2);
});

test("turn completion folds a trailing usage payload into the final step", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "turn_ended", at: 1200, kind: "completed", usage: { output: 30 } });
  assert.equal(s.phase, "completed");
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 30);
  assert.equal(s.steps[0].decodeMs, 1100);
  assert.equal(s.endedAt, 1200);
});

test("canceled and failed turns keep accumulated numbers", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "abc" });
  s = reduceMeter(s, { t: "usage", at: 900, usage: { output: 12 } });
  s = reduceMeter(s, { t: "turn_ended", at: 5000, kind: "canceled", note: "user stop" });
  assert.equal(s.phase, "canceled");
  assert.equal(s.endNote, "user stop");
  assert.equal(summarizeTurn(s, CPT, 5000).outTokens, 12);
});

test("end events without a running turn are ignored", () => {
  const s = initialMeterState();
  const next = reduceMeter(s, { t: "turn_ended", at: 10, kind: "completed" });
  assert.equal(next.phase, "idle");
});

test("reset drops the turn but keeps the usage baseline continuous", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "abc" });
  s = reduceMeter(s, { t: "usage", at: 200, usage: { output: 77 }, maxTokPerSec: Infinity });
  s = reduceMeter(s, { t: "reset" });
  assert.equal(s.phase, "idle");
  assert.equal(s.totalChars, 0);
  assert.equal(s.prevUsageOut, 77);
  s = startTurn(s, 300);
  s = reduceMeter(s, { t: "text", at: 400, key: "m2", text: "def" });
  s = reduceMeter(s, { t: "usage", at: 500, usage: { output: 90 } });
  assert.equal(s.steps[0].outTokens, 13);
});

test("text before turn start is ignored", () => {
  const s = reduceMeter(initialMeterState(), { t: "text", at: 100, key: "m1", text: "abc" });
  assert.equal(s.totalChars, 0);
});

test("reasoning-only steps still measure their decode window", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "reasoning", text: "thinking..." });
  s = reduceMeter(s, { t: "usage", at: 2500, usage: { output: 60 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].decodeMs, 2000);
  assert.equal(s.steps[0].prefillMs, 500);
});

test("user wait is removed from the tool-wait window between steps", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 2000, usage: { output: 10 } });
  // Model asks a question, sleeps for 10s, user answers.
  s = reduceMeter(s, { t: "user_wait_started", at: 2100 });
  s = reduceMeter(s, { t: "user_wait_ended", at: 12100 });
  s = reduceMeter(s, { t: "text", at: 12200, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 13200, usage: { output: 20 } });
  assert.equal(s.steps.length, 2);
  // Raw gap 2000..12200 is 10200ms; 10000 of it was the user thinking.
  assert.equal(s.steps[1].waitMs, 200);
  const sum = summarizeTurn(s, CPT, 13200);
  assert.equal(sum.waitMs, 200);
  assert.equal(sum.userWaitMs, 10000);
  assert.equal(sum.waiting, false);
});

test("a user wait inside a step is removed from its decode window", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "user_wait_started", at: 1500 });
  s = reduceMeter(s, { t: "user_wait_ended", at: 5500 });
  s = reduceMeter(s, { t: "usage", at: 6000, usage: { output: 30 } });
  assert.equal(s.steps.length, 1);
  // Raw window 1000..6000 = 5000ms, minus the 4000ms asleep.
  assert.equal(s.steps[0].decodeMs, 1000);
});

test("an open user wait counts live and closes when the turn ends", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 100 } });
  s = reduceMeter(s, { t: "user_wait_started", at: 2000 });
  const live = summarizeTurn(s, CPT, 7000);
  assert.equal(live.waiting, true);
  assert.equal(live.userWaitMs, 5000);
  // 7000ms wall, 5000 of it asleep -> whole-turn rate uses 2000ms.
  assert.equal(live.tokPerSecTurn, 100 / 2);
  s = reduceMeter(s, { t: "turn_ended", at: 8000, kind: "completed" });
  assert.equal(s.pausedAt, null);
  assert.equal(s.userWaits.length, 1);
  const done = summarizeTurn(s, CPT, 9000);
  assert.equal(done.userWaitMs, 6000);
  assert.equal(done.totalMs, 8000);
  assert.equal(done.tokPerSecTurn, 100 / 2);
});

test("user wait actions outside a live wait are no-ops", () => {
  const idle = reduceMeter(initialMeterState(), { t: "user_wait_started", at: 10 });
  assert.equal(idle.pausedAt, null);
  const running = startTurn();
  const ended = reduceMeter(running, { t: "user_wait_ended", at: 10 });
  assert.equal(ended, running);
});

test("turn_started and reset clear user waits", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "user_wait_started", at: 100 });
  s = reduceMeter(s, { t: "user_wait_ended", at: 600 });
  s = startTurn(s, 700);
  assert.equal(s.userWaits.length, 0);
  assert.equal(s.pausedAt, null);
  s = reduceMeter(s, { t: "user_wait_started", at: 800 });
  s = reduceMeter(s, { t: "reset" });
  assert.equal(s.userWaits.length, 0);
  assert.equal(s.pausedAt, null);
});

test("a step faster than physically plausible is absorbed into the baseline", () => {
  // The interrupted-message scenario: its late step-finish lands mid new
  // turn and claims 1200 tokens in a 1600ms window (750 tok/s > 400).
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(230) });
  s = reduceMeter(s, { t: "usage", at: 2600, usage: { output: 1200 } });
  assert.equal(s.steps.length, 0);
  assert.deepEqual(s.stepRejected, { tokens: 1200, windowMs: 1600 });
  assert.equal(s.prevUsageOut, 1200);
  // The real step continues: window and characters were not reset.
  assert.equal(s.liveChars, 230);
  assert.equal(s.stepFirstTextAt, 1000);
  s = reduceMeter(s, { t: "text", at: 3400, key: "m1", text: "x".repeat(300) });
  s = reduceMeter(s, { t: "usage", at: 3600, usage: { output: 1260 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 60);
  assert.equal(s.stepRejected, null);
  const sum = summarizeTurn(s, CPT, 3600);
  assert.equal(sum.outTokens, 60);
});

test("text keys survive turn boundaries", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "hello world" });
  assert.equal(s.totalChars, 11);
  // The previous message's final snapshot arrives inside the next turn:
  // only the new characters may count.
  s = startTurn(s, 500);
  s = reduceMeter(s, { t: "text", at: 600, key: "m1", text: "hello world!" });
  assert.equal(s.totalChars, 1);
});

test("cache hit rate uses reported cache reads", () => {
  // OpenAI-style: `input` already contains the cached tokens.
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 40, input: 10_000, cached: 8_000 } });
  const sum = summarizeTurn(s, CPT, 1000);
  assert.equal(sum.inputTokens, 10_000);
  assert.equal(sum.cachedTokens, 8_000);
  assert.equal(sum.promptTokens, 10_000);
  assert.equal(sum.cacheHitRate, 0.8);
});

test("cache hit rate is null without prompt data and 0 without cache", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 40 } });
  assert.equal(summarizeTurn(s, CPT, 1000).cacheHitRate, null);
  s = reduceMeter(s, { t: "text", at: 1100, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 2000, usage: { output: 70, input: 900, cached: 0 } });
  const sum = summarizeTurn(s, CPT, 2000);
  assert.equal(sum.promptTokens, 900);
  assert.equal(sum.cacheHitRate, 0);
});

test("cacheStats separates the two provider prompt shapes", () => {
  // OpenAI-style: prompt total equals input.
  assert.deepEqual(cacheStats(1000, 400), { promptTokens: 1000, cachedTokens: 400, hitRate: 0.4 });
  // Anthropic-style: `input` is the uncached prompt, cache reads are extra.
  assert.deepEqual(cacheStats(1000, 9000), { promptTokens: 10_000, cachedTokens: 9000, hitRate: 0.9 });
  // Nothing reported.
  assert.deepEqual(cacheStats(0, 0), { promptTokens: 0, cachedTokens: 0, hitRate: null });
  assert.deepEqual(cacheStats(Number.NaN, 500), { promptTokens: 500, cachedTokens: 500, hitRate: 1 });
});

test("cache writes join the prompt total, so they lower the hit rate", () => {
  // The Anthropic definition: cacheRead / (newInput + cacheWrite + cacheRead).
  // Half the prompt is served from cache, half is being written into it.
  const half = cacheStats(1200, 60_000, "separate", 60_000);
  assert.equal(half.promptTokens, 121_200);
  assert.equal(half.cachedTokens, 60_000);
  assert.equal(half.hitRate, 60_000 / 121_200);
  assert.ok(half.hitRate !== null && half.hitRate < 0.5);

  // A TTL rebuild that hits nothing: the old formula called this 0% by luck
  // (cached = 0), the new one keeps 0% for the right reason.
  const rebuild = cacheStats(1200, 0, "auto", 120_000);
  assert.equal(rebuild.promptTokens, 121_200);
  assert.equal(rebuild.hitRate, 0);
});

test("a zero cache write leaves the rate exactly as before", () => {
  // Every provider Paseo reports today is in this branch, so the extra term
  // must not move any number.
  const withoutTerm = cacheStats(194, 125_056);
  const withZeroTerm = cacheStats(194, 125_056, "auto", 0);
  assert.deepEqual(withZeroTerm, withoutTerm);
  assert.equal(withZeroTerm.promptTokens, 125_250);
});

test("cache hit rate stays null when the turn reports no prompt at all", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 40, cacheWrite: 9000 } });
  const sum = summarizeTurn(s, CPT, 1000);
  assert.equal(sum.cacheWriteTokens, 9000);
  assert.equal(sum.promptTokens, 9000);
  assert.equal(sum.cacheHitRate, 0);
});

test("cache writes accumulate per step like the other counters", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 900, usage: { output: 10, input: 1000, cached: 0, cacheWrite: 50_000 } });
  s = reduceMeter(s, { t: "text", at: 1000, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 1800, usage: { output: 20, input: 1200, cached: 51_000, cacheWrite: 50_000 } });
  const sum = summarizeTurn(s, CPT, 1800);
  // Step 2: 1200 new prompt tokens, 51000 cache reads, no new writes.
  assert.equal(sum.cacheWriteTokens, 50_000);
  assert.equal(sum.cachedTokens, 51_000);
  assert.equal(sum.promptTokens, 1200 + 50_000 + 51_000);
  assert.equal(sum.cacheHitRate, 51_000 / 102_200);
});

test("cache hit rate accumulates across a turn's steps", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 900, usage: { output: 10, input: 1000, cached: 400 } });
  s = reduceMeter(s, { t: "text", at: 1000, key: "m2", text: "b" });
  // Step 2 brings 1200 fresh prompt tokens and 1200 more cache reads.
  s = reduceMeter(s, { t: "usage", at: 1800, usage: { output: 20, input: 2200, cached: 1600 } });
  const sum = summarizeTurn(s, CPT, 1800);
  assert.equal(sum.inputTokens, 2200);
  assert.equal(sum.cachedTokens, 1600);
  assert.equal(sum.promptTokens, 2200);
  assert.equal(sum.cacheHitRate, 1600 / 2200);
});

test("a cache read larger than the prompt means disjoint counters", () => {
  // Anthropic-style providers report cache reads outside `inputTokens`.
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 40, input: 900, cached: 9_100 } });
  const sum = summarizeTurn(s, CPT, 1000);
  assert.equal(sum.inputTokens, 900);
  assert.equal(sum.cachedTokens, 9_100);
  assert.equal(sum.promptTokens, 10_000);
  assert.equal(sum.cacheHitRate, 0.91);
});

test("a cache-cold call does not switch the rest of the turn to the inclusive shape", () => {
  // A separate-counter provider (Anthropic-style, and OpenCode's usage) whose
  // first call ran with a cold cache: that call alone reads as inclusive,
  // because its prompt is larger than its cache read. Deciding per call then
  // drops the first call's cache reads from the denominator while keeping them
  // in the numerator: this is how a 61% turn used to print 86%.
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 900, usage: { output: 10, input: 20_000, cached: 15_000 } });
  s = reduceMeter(s, { t: "text", at: 1000, key: "m2", text: "b" });
  // The proof of the shape: 16000 cache reads against 26 new prompt tokens.
  s = reduceMeter(s, { t: "usage", at: 1800, usage: { output: 20, input: 20_026, cached: 31_000 } });
  const sum = summarizeTurn(s, CPT, 1800);
  assert.equal(sum.inputTokens, 20_026);
  assert.equal(sum.cachedTokens, 31_000);
  assert.equal(sum.promptTokens, 51_026);
  // One shape for the turn, so the parts always add up to the whole prompt.
  assert.equal(
    sum.promptTokens,
    sum.inputTokens + sum.cacheWriteTokens + sum.cachedTokens,
  );
  assert.equal(sum.cacheHitRate, 31_000 / 51_026);
});

test("an explicit cache mode overrides the shape inferred from the turn", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 900, usage: { output: 10, input: 20_000, cached: 15_000 } });
  s = reduceMeter(s, { t: "text", at: 1000, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 1800, usage: { output: 20, input: 20_026, cached: 31_000 } });
  // Forced inclusive: every read already sits inside its prompt, and the clamp
  // keeps the impossible totals from printing above 100%.
  const inclusive = summarizeTurn(s, CPT, 1800, "inclusive");
  assert.equal(inclusive.promptTokens, 20_026);
  assert.equal(inclusive.cacheHitRate, 1);
  // Forced separate matches what auto infers from the second call.
  assert.equal(summarizeTurn(s, CPT, 1800, "separate").promptTokens, 51_026);
});

test("a turn discovered mid-flight claims no prefill and no whole-turn rate", () => {
  // The plugin reloaded while the turn was running. The clock still starts at
  // the turn's real boundary, so `turn time` stays honest, but tokens only
  // cover what is watched from here on: dividing them by the whole turn is the
  // artifact that printed 4.9 tok/s for a 36 tok/s model.
  let s = reduceMeter(initialMeterState(), {
    t: "turn_started",
    at: 0,
    turnId: "t1",
    observedFrom: 80_000,
  });
  s = reduceMeter(s, { t: "text", at: 81_000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "usage", at: 85_000, usage: { output: 100, input: 50 } });
  const sum = summarizeTurn(s, CPT, 90_000);
  assert.equal(sum.partial, true);
  assert.equal(sum.prefillMs, null);
  assert.equal(sum.tokPerSecTurn, null);
  assert.ok(sum.tokPerSecDecode !== null && sum.tokPerSecDecode > 0);
  assert.equal(sum.totalMs, 90_000);
  assert.equal(sum.observedMs, 10_000);

  // The same turn watched from its first event keeps both rows.
  let f = reduceMeter(initialMeterState(), { t: "turn_started", at: 0, turnId: "t1" });
  f = reduceMeter(f, { t: "text", at: 1_000, key: "m1", text: "x".repeat(400) });
  f = reduceMeter(f, { t: "usage", at: 5_000, usage: { output: 100, input: 50 } });
  const full = summarizeTurn(f, CPT, 10_000);
  assert.equal(full.partial, false);
  assert.equal(full.prefillMs, 1_000);
  assert.ok(full.tokPerSecTurn !== null && full.tokPerSecTurn > 0);
  assert.equal(full.observedMs, null);
});

test("a re-announced turn_started keeps the mark of a partly observed turn", () => {
  const seeded = reduceMeter(initialMeterState(), {
    t: "turn_started",
    at: 0,
    turnId: "t1",
    observedFrom: 5_000,
  });
  // Resubscribing can re-announce the turn being tracked; the events before the
  // seed are still missing, so the mark survives. A new turn does not inherit it.
  assert.equal(reduceMeter(seeded, { t: "turn_started", at: 0, turnId: "t1" }).seededFrom, 5_000);
  assert.equal(
    reduceMeter(seeded, { t: "turn_started", at: 9_000, turnId: "t2" }).seededFrom,
    null,
  );
});

test("repeated snapshots never inflate the cache hit rate", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 900, usage: { output: 10, input: 1000, cached: 900 } });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 10, input: 1000, cached: 900 } });
  const sum = summarizeTurn(s, CPT, 1000);
  assert.equal(sum.steps, 1);
  assert.equal(sum.cachedTokens, 900);
  assert.equal(sum.promptTokens, 1000);
  assert.equal(sum.cacheHitRate, 0.9);
});

test("calibration blends with EMA 0.7/0.3, clamps, and rejects thin samples", () => {
  const first = calibrate(undefined, 800, 100); // 0.7*3.6 + 0.3*8
  assert.equal(first, 4.92);
  const blended = calibrate(4, 400, 100); // 0.7*4 + 0.3*4 = 4
  assert.equal(blended, 4);
  const clampedLow = calibrate(2, 400, 100); // observed 4 -> stays >= 2
  assert.equal(clampedLow, 0.7 * 2 + 0.3 * 4);
  // Tool-argument-heavy steps stream almost no visible text: too thin.
  assert.equal(calibrate(4, 20, 50), null);
  assert.equal(calibrate(4, 400, 0), null);
  // A 1-char/token sample is tool-call arguments counted in `output`, not
  // this model's text ratio: reject instead of dragging the blend down.
  assert.equal(calibrate(4, 100, 100), null);
  assert.equal(calibrate(4, 160, 100), 0.7 * 4 + 0.3 * 1.6); // observed 1.5+ kept
  // A 40-chars/token sample is bookkeeping noise, not a model ratio: reject
  // instead of letting one step pin the blend at CAL_MAX.
  assert.equal(calibrate(4, 4000, 100), null);
});

test("delegated intervals are removed from the whole-turn rate", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "usage", at: 2000, usage: { output: 100 } });
  // Subagents do the real work for 10s; the parent produces nothing itself.
  s = reduceMeter(s, { t: "delegated_started", at: 2000 });
  s = reduceMeter(s, { t: "delegated_ended", at: 12000 });
  s = reduceMeter(s, { t: "turn_ended", at: 12000, kind: "completed" });
  const sum = summarizeTurn(s, CPT, 12000);
  assert.equal(sum.delegatedMs, 10000);
  assert.equal(sum.delegated, false);
  assert.equal(sum.totalMs, 12000);
  // 100 tokens over 2 productive seconds, not 12 wall seconds.
  assert.equal(sum.tokPerSecTurn, 50);
});

test("overlapping user wait and delegation subtract once from turn time", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "usage", at: 2000, usage: { output: 100 } });
  s = reduceMeter(s, { t: "delegated_started", at: 2000 });
  s = reduceMeter(s, { t: "user_wait_started", at: 3000 });
  s = reduceMeter(s, { t: "user_wait_ended", at: 8000 });
  s = reduceMeter(s, { t: "delegated_ended", at: 12000 });
  s = reduceMeter(s, { t: "turn_ended", at: 12000, kind: "completed" });
  const sum = summarizeTurn(s, CPT, 12000);
  // Union of asleep time is 2000..12000; the nested user wait must not
  // subtract a second time.
  assert.equal(sum.userWaitMs, 5000);
  assert.equal(sum.delegatedMs, 10000);
  assert.equal(sum.tokPerSecTurn, 50);
});

test("open delegation counts while running and closes at turn end", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "delegated_started", at: 5000 });
  let sum = summarizeTurn(s, CPT, 8000);
  assert.equal(sum.delegated, true);
  assert.equal(sum.delegatedMs, 3000);
  s = reduceMeter(s, { t: "turn_ended", at: 10000, kind: "completed" });
  assert.equal(s.delegatedAt, null);
  assert.equal(s.delegatedWaits.length, 1);
  sum = summarizeTurn(s, CPT, 10000);
  assert.equal(sum.delegated, false);
  assert.equal(sum.delegatedMs, 5000);
});

test("delegation outside a running turn is a no-op", () => {
  const idle = initialMeterState();
  assert.equal(reduceMeter(idle, { t: "delegated_started", at: 100 }), idle);
  assert.equal(reduceMeter(idle, { t: "delegated_ended", at: 100 }), idle);
  const running = startTurn();
  assert.equal(reduceMeter(running, { t: "delegated_ended", at: 100 }), running);
});

test("a provider that excludes reasoning gets estimated thinking tokens", () => {
  // Heavy thinking streamed as reasoning text, a short answer, then the step
  // usage: 2400 chars cannot come from 47 reported output tokens.
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "reasoning:t1", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "text", at: 3000, key: "m1", text: "a".repeat(30) });
  s = reduceMeter(s, { t: "usage", at: 3100, usage: { output: 47 } });
  assert.equal(s.thinkingExcluded, true);
  assert.equal(s.steps[0].thinkingChars, 2400);
  const sum = summarizeTurn(s, CPT, 3100);
  // Reasoning characters convert with the reasoning ratio, not the visible
  // text calibration: measured ~3.7 chars per reasoning token.
  assert.equal(sum.thinkingTokens, 2400 / REASONING_CHARS_PER_TOKEN);
  assert.equal(sum.outTokens, 47);
  assert.equal(sum.estTokens, 47 + 2400 / REASONING_CHARS_PER_TOKEN);
  assert.equal(sum.approx, true);
  // The rate covers thinking + visible tokens across the full step window.
  assert.equal(sum.tokPerSecDecode, (47 + 2400 / REASONING_CHARS_PER_TOKEN) / 2.6);
});

test("the excluded-reasoning verdict survives turn boundaries like the baseline", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "y".repeat(400), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 600, usage: { output: 10 } });
  assert.equal(s.thinkingExcluded, true);
  s = reduceMeter(s, { t: "model_changed", model: "m1" });
  assert.equal(s.thinkingExcludedModel, "m1");
  s = startTurn(s, 5000);
  assert.equal(s.thinkingExcluded, true);
  assert.equal(s.thinkingExcludedModel, "m1");
  const fresh = reduceMeter(s, { t: "reset" });
  assert.equal(fresh.thinkingExcluded, true);
  assert.equal(fresh.thinkingExcludedModel, "m1");
});

test("the verdict belongs to its model: switching models revokes it, inclusive output is not double counted", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "model_changed", model: "excluder" });
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "text", at: 3000, key: "m1", text: "a".repeat(30) });
  s = reduceMeter(s, { t: "usage", at: 3100, usage: { output: 47 } });
  assert.equal(s.thinkingExcluded, true);
  assert.equal(s.thinkingExcludedModel, "excluder");
  // Switch to a model that reports thinking inside `output`.
  s = reduceMeter(s, { t: "model_changed", model: "includer" });
  assert.equal(s.thinkingExcluded, false);
  assert.equal(s.steps.length, 1); // the current turn's steps survive
  // Heavy thinking whose reported output already pays for it: no estimate on
  // top (that would count the thinking twice), and no false re-arm.
  s = reduceMeter(s, { t: "text", at: 3300, key: "r2", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 5200, usage: { output: 695 } });
  assert.equal(s.thinkingExcluded, false);
  assert.equal(s.steps.length, 2);
  const sum = summarizeTurn(s, CPT, 5300);
  assert.equal(sum.thinkingTokens, 0);
  assert.equal(sum.estTokens, 695);
  // Switching back starts unjudged; the verdict only comes back with evidence.
  s = reduceMeter(s, { t: "model_changed", model: "excluder" });
  assert.equal(s.thinkingExcluded, false);
  assert.equal(s.thinkingExcludedModel, "excluder");
});

test("an unknown model never clears the verdict, and a verdict predating identity adopts the first model", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "y".repeat(600), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 600, usage: { output: 10 } });
  assert.equal(s.thinkingExcluded, true);
  assert.equal(s.thinkingExcludedModel, null);
  assert.equal(reduceMeter(s, { t: "model_changed", model: null }), s);
  const adopted = reduceMeter(s, { t: "model_changed", model: "m1" });
  assert.equal(adopted.thinkingExcluded, true); // adopted, not revoked
  assert.equal(adopted.thinkingExcludedModel, "m1");
  assert.equal(reduceMeter(adopted, { t: "model_changed", model: "m2" }).thinkingExcluded, false);
});

test("three consecutive inclusive steps revoke the verdict and excluding evidence re-arms it", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "model_changed", model: "m" });
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "text", at: 700, key: "m1", text: "a".repeat(30) });
  s = reduceMeter(s, { t: "usage", at: 800, usage: { output: 47 } });
  assert.equal(s.thinkingExcluded, true);
  // The provider config now includes thinking: reported output covers the
  // streamed reasoning characters.
  s = reduceMeter(s, { t: "text", at: 900, key: "r2", text: "y".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 1900, usage: { output: 197 } });
  assert.equal(s.thinkingExcluded, true);
  s = reduceMeter(s, { t: "text", at: 2000, key: "r3", text: "y".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 3000, usage: { output: 347 } });
  assert.equal(s.thinkingExcluded, true);
  // A thin step (too few reasoning chars for either verdict) breaks the
  // streak: the count must start over.
  s = reduceMeter(s, { t: "text", at: 3100, key: "r4", text: "y".repeat(100), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 3500, usage: { output: 367 } });
  assert.equal(s.thinkingExcluded, true);
  s = reduceMeter(s, { t: "text", at: 3600, key: "r5", text: "y".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 4600, usage: { output: 517 } });
  s = reduceMeter(s, { t: "text", at: 4700, key: "r6", text: "y".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 5700, usage: { output: 667 } });
  assert.equal(s.thinkingExcluded, true);
  s = reduceMeter(s, { t: "text", at: 5800, key: "r7", text: "y".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 6800, usage: { output: 817 } });
  assert.equal(s.thinkingExcluded, false);
  assert.equal(summarizeTurn(s, CPT, 6900).thinkingTokens, 0);
  // Excluding evidence lands: the verdict is back on the next step.
  s = reduceMeter(s, { t: "text", at: 6900, key: "r8", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 7800, usage: { output: 867 } });
  assert.equal(s.thinkingExcluded, true);
});

test("ordinary reasoning density revokes the verdict; the neutral band concludes nothing", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "model_changed", model: "m" });
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 1600, usage: { output: 47 } });
  assert.equal(s.thinkingExcluded, true);
  // A step at 6 chars per output token sits in the neutral band
  // (inclusion ratio ~5.2, exclusion ratio 8): verdict stays, streak resets.
  s = reduceMeter(s, { t: "text", at: 2000, key: "r2", text: "y".repeat(1200), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 3000, usage: { output: 247 } });
  assert.equal(s.thinkingExcluded, true);
  // Typical reasoning prose (~3.7 chars/token) now satisfies inclusion; the
  // neutral step above must not have counted, so three full steps are needed.
  s = reduceMeter(s, { t: "text", at: 3100, key: "r3", text: "y".repeat(740), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 4100, usage: { output: 447 } });
  assert.equal(s.thinkingExcluded, true);
  s = reduceMeter(s, { t: "text", at: 4200, key: "r4", text: "y".repeat(740), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 5200, usage: { output: 647 } });
  assert.equal(s.thinkingExcluded, true);
  s = reduceMeter(s, { t: "text", at: 5300, key: "r5", text: "y".repeat(740), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 6300, usage: { output: 847 } });
  assert.equal(s.thinkingExcluded, false);
});

test("a verdict without a model owner is re-derived on the next turn", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "y".repeat(600), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 600, usage: { output: 10 } });
  assert.equal(s.thinkingExcluded, true);
  assert.equal(s.thinkingExcludedModel, null);
  // Identity never resolved: the verdict cannot be permanent across turns.
  s = startTurn(s, 5000);
  assert.equal(s.thinkingExcluded, false);
  // Fresh evidence in the new turn brings it right back.
  s = reduceMeter(s, { t: "text", at: 5500, key: "r2", text: "y".repeat(600), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 5600, usage: { output: 20 } });
  assert.equal(s.thinkingExcluded, true);
});

test("moderate reasoning leaves the provider unjudged and adds no estimate", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "y".repeat(150), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 600, usage: { output: 10 } });
  assert.equal(s.thinkingExcluded, false);
  assert.equal(summarizeTurn(s, CPT, 600).thinkingTokens, 0);
});

test("late bulk reasoning counts in totals but not in the decode rate", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "a".repeat(40) });
  // The finished reasoning block is delivered in one burst, after the answer
  // was already streaming: its generation time is outside the window.
  s = reduceMeter(s, { t: "text", at: 2000, key: "reasoning:t1", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 2100, usage: { output: 10 } });
  assert.equal(s.thinkingExcluded, true);
  assert.equal(s.steps[0].thinkingLateChars, 2400);
  const sum = summarizeTurn(s, CPT, 2100);
  assert.equal(sum.thinkingTokens, 2400 / REASONING_CHARS_PER_TOKEN);
  assert.equal(sum.estTokens, 10 + 2400 / REASONING_CHARS_PER_TOKEN);
  // Decode sees 10 visible tokens in 1100ms; the windowless thinking cannot
  // inflate it, while the whole-turn rate does count it.
  assert.equal(sum.tokPerSecDecode, 10 / 1.1);
  assert.equal(sum.tokPerSecTurn, (10 + 2400 / REASONING_CHARS_PER_TOKEN) / 2.1);
});

test("no-usage estimation ignores bulk reasoning characters", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a".repeat(400) });
  s = reduceMeter(s, { t: "text", at: 150, key: "r1", text: "t".repeat(1600), kind: "reasoning" });
  s = reduceMeter(s, { t: "turn_ended", at: 2000, kind: "completed" });
  // The reasoning burst arrived after the visible text had started, so its
  // characters cannot stand in for streamed live tokens.
  assert.equal(summarizeTurn(s, CPT, 2000).estTokens, 100);
});

test("a rejected usage burst is kept as unattributed in the turn totals", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1100, usage: { output: 30 } });
  // Aggregated usage arriving 20ms after the previous snapshot: 1200 tokens
  // in a physically impossible window.
  s = reduceMeter(s, { t: "usage", at: 1120, usage: { output: 1230 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.unattributedTokens, 1200);
  const sum = summarizeTurn(s, CPT, 1120);
  assert.equal(sum.outTokens, 30);
  assert.equal(sum.unattributedTokens, 1200);
  assert.equal(sum.estTokens, 1230);
  // The decode-window rate ignores the windowless burst; the whole-turn rate
  // counts it.
  assert.equal(sum.tokPerSecDecode, 30 / 1);
  assert.equal(sum.tokPerSecTurn, 1230 / 1.12);
});

test("an open step's running window counts in the decode rate", () => {
  let s = startTurn();
  // Closed step: 10 reported tokens over a 100ms window.
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "a".repeat(40) });
  s = reduceMeter(s, { t: "usage", at: 1100, usage: { output: 10 } });
  // Current step: a long early reasoning stream, still open 40s later. Its
  // estimated tokens sit in the totals, so its running window must sit in
  // the decode denominator — dividing them by the closed 100ms window alone
  // used to print a >10k tok/s burst on the pill.
  s = reduceMeter(s, { t: "text", at: 2000, key: "r1", text: "t".repeat(4000), kind: "reasoning" });
  const sum = summarizeTurn(s, CPT, 42000);
  assert.equal(sum.decodeMs, 40100);
  assert.equal(sum.tokPerSecDecode, (10 + 4000 / REASONING_CHARS_PER_TOKEN) / 40.1);
});

test("calibration pairs only visible characters with output tokens", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "y".repeat(400), kind: "reasoning" });
  s = reduceMeter(s, { t: "text", at: 5600, key: "m1", text: "v".repeat(800) });
  s = reduceMeter(s, { t: "usage", at: 5700, usage: { output: 200 } });
  assert.deepEqual(s.calibInput, { chars: 800, tokens: 200 });
});

test("reasoning and visible characters are estimated with their own ratios", () => {
  let s = startTurn();
  // Closed step: 370 reasoning chars (early) + 10 reported output tokens.
  s = reduceMeter(s, { t: "text", at: 100, key: "r1", text: "t".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "text", at: 200, key: "m1", text: "a".repeat(40) });
  s = reduceMeter(s, { t: "usage", at: 300, usage: { output: 10 } });
  assert.equal(s.thinkingExcluded, true);
  // Open step: reasoning leads again, then visible text streams.
  s = reduceMeter(s, { t: "text", at: 400, key: "r2", text: "t".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "text", at: 500, key: "m2", text: "a".repeat(40) });
  const sum = summarizeTurn(s, CPT, 600);
  const closedThinking = 370 / REASONING_CHARS_PER_TOKEN;
  const liveThinking = 370 / REASONING_CHARS_PER_TOKEN;
  const liveVisible = 40 / CPT;
  assert.equal(sum.thinkingTokens, closedThinking + liveThinking);
  assert.equal(sum.estTokens, 10 + closedThinking + liveVisible + liveThinking);
});

test("a provisional end still lets the real terminal event decide the outcome", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, {
    t: "turn_ended",
    at: 1000,
    kind: "completed",
    turnId: "t1",
    provisional: true,
  });
  assert.equal(s.phase, "completed");
  assert.equal(s.provisional, true);
  assert.equal(s.endedAt, 1000);
  // The agent snapshot only knew that work stopped; the failure still lands.
  s = reduceMeter(s, { t: "turn_ended", at: 1100, kind: "failed", note: "boom", turnId: "t1" });
  assert.equal(s.phase, "failed");
  assert.equal(s.endNote, "boom");
  assert.equal(s.endedAt, 1100);
  assert.equal(s.provisional, false);
});

test("a provisional end is replaced by a completed terminal with its usage", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "turn_ended", at: 1000, kind: "completed", turnId: "t1", provisional: true });
  s = reduceMeter(s, {
    t: "turn_ended",
    at: 1200,
    kind: "completed",
    turnId: "t1",
    usage: { output: 40, input: 10 },
  });
  assert.equal(s.phase, "completed");
  assert.equal(s.provisional, false);
  assert.equal(s.endedAt, 1200);
  // The terminal payload still refreshes the counters and their baseline.
  assert.equal(s.usageOut, 40);
  assert.equal(s.prevUsageOut, 40);
});

test("a terminal for another turn cannot rewrite a provisional end", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "turn_ended", at: 1000, kind: "completed", turnId: "t1", provisional: true });
  const after = reduceMeter(s, { t: "turn_ended", at: 1100, kind: "failed", turnId: "t2" });
  assert.equal(after, s);
});

test("a real terminal event is not rewritten by a later duplicate", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "turn_ended", at: 1000, kind: "failed", note: "boom", turnId: "t1" });
  const after = reduceMeter(s, { t: "turn_ended", at: 1100, kind: "completed", turnId: "t1" });
  assert.equal(after, s);
});

test("the next turn clears a provisional end", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "turn_ended", at: 1000, kind: "completed", turnId: "t1", provisional: true });
  s = reduceMeter(s, { t: "turn_started", at: 2000, turnId: "t2" });
  assert.equal(s.phase, "running");
  assert.equal(s.turnId, "t2");
  assert.equal(s.provisional, false);
  assert.equal(s.endedAt, null);
});

test("a terminal event for another turn neither closes this turn nor advances its baseline", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  const after = reduceMeter(s, {
    t: "turn_ended",
    at: 1200,
    kind: "failed",
    turnId: "other",
    usage: { output: 40 },
  });
  assert.equal(after, s);
  assert.equal(after.phase, "running");
  assert.equal(after.prevUsageOut, 0);
});

test("a terminal event for another turn cannot rewrite a provisional end", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "turn_ended", at: 1100, kind: "completed", turnId: "t1", provisional: true });
  const after = reduceMeter(s, {
    t: "turn_ended",
    at: 1200,
    kind: "failed",
    turnId: "other",
    note: "not this turn",
  });
  assert.equal(after, s);
  assert.equal(after.phase, "completed");
  assert.equal(after.endNote, null);
});

test("a provisional end still accounts the terminal usage into the turn", () => {
  const direct = reduceMeter(
    reduceMeter(startTurn(initialMeterState(), 0), {
      t: "text",
      at: 1000,
      key: "m1",
      text: "x".repeat(400),
    }),
    { t: "turn_ended", at: 1200, kind: "completed", turnId: "t1", usage: { output: 40, input: 10 } },
  );

  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "turn_ended", at: 1100, kind: "completed", turnId: "t1", provisional: true });
  s = reduceMeter(s, {
    t: "turn_ended",
    at: 1200,
    kind: "completed",
    turnId: "t1",
    usage: { output: 40, input: 10 },
  });

  const directSum = summarizeTurn(direct, CPT, 2000);
  const sum = summarizeTurn(s, CPT, 2000);
  assert.equal(sum.steps, directSum.steps);
  assert.equal(sum.steps, 1);
  assert.equal(sum.outTokens, 40);
  assert.equal(sum.outTokens, directSum.outTokens);
  assert.equal(sum.decodeMs, directSum.decodeMs);
  assert.equal(sum.tokPerSecDecode, directSum.tokPerSecDecode);
});

test("usage that arrives after a provisional end still closes the step", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "turn_ended", at: 1100, kind: "completed", turnId: "t1", provisional: true });
  s = reduceMeter(s, { t: "usage", at: 1200, usage: { output: 40, input: 10 } });
  // The clock stays stopped, but the tokens are counted.
  assert.equal(s.phase, "completed");
  assert.equal(s.provisional, true);
  assert.equal(s.endedAt, 1100);
  const sum = summarizeTurn(s, CPT, 2000);
  assert.equal(sum.steps, 1);
  assert.equal(sum.outTokens, 40);
  assert.equal(sum.tokPerSecDecode, 200);
});

test("the terminal payload repeats no token after the usage already landed", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "turn_ended", at: 1100, kind: "completed", turnId: "t1", provisional: true });
  s = reduceMeter(s, { t: "usage", at: 1200, usage: { output: 40 } });
  s = reduceMeter(s, { t: "turn_ended", at: 1300, kind: "completed", turnId: "t1", usage: { output: 40 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 40);
  assert.equal(s.provisional, false);
});

test("an empty turn id is no id, not another turn", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  // The terminal carries no usable id: it must still close this turn.
  const after = reduceMeter(s, { t: "turn_ended", at: 1200, kind: "failed", turnId: "" });
  assert.equal(after.phase, "failed");
  assert.equal(after.endedAt, 1200);
});

test("an empty turn id on the start is stored as no id", () => {
  const s = reduceMeter(initialMeterState(), { t: "turn_started", at: 0, turnId: "" });
  assert.equal(s.turnId, null);
});

// --- Tool calls ----------------------------------------------------------------
// Measured in the wild on a provider that lands a step's usage after the tool
// result: a 20 s `sleep` inside a step window printed 2.3 tok/s, and trailing
// deltas with an 8 ms window printed 250-375 tok/s.

test("a running tool is parked out of the decode window", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "text", at: 2000, key: "m1", text: "x".repeat(800) });
  s = reduceMeter(s, { t: "usage", at: 2000, usage: { output: 100 } });
  // The provider reports the next step's tokens only after the call returns.
  s = reduceMeter(s, { t: "tool_started", at: 2000 });
  s = reduceMeter(s, { t: "tool_ended", at: 22000 });
  s = reduceMeter(s, { t: "text", at: 22100, key: "m2", text: "y".repeat(400) });
  s = reduceMeter(s, { t: "usage", at: 22500, usage: { output: 150 } });
  assert.equal(s.steps.length, 2);
  assert.equal(s.steps[0].decodeMs, 1000);
  // Generation only: the 20 s call sat between this step's first character
  // and the usage that closed it.
  assert.equal(s.steps[1].decodeMs, 400);
  const sum = summarizeTurn(s, CPT, 22500);
  assert.equal(sum.toolMs, 20000);
  assert.equal(sum.tooling, false);
  assert.equal(Math.round(sum.tokPerSecDecode ?? 0), Math.round(150 / 1.4));
});

test("the whole-turn rate excludes tool time", () => {
  const run = (park: boolean) => {
    let s = startTurn(initialMeterState(), 0);
    s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
    s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 100 } });
    if (park) s = reduceMeter(s, { t: "tool_started", at: 1000 });
    s = reduceMeter(s, { t: "text", at: 21000, key: "m2", text: "y".repeat(400) });
    s = reduceMeter(s, { t: "usage", at: 21000, usage: { output: 200 } });
    if (park) s = reduceMeter(s, { t: "tool_ended", at: 21000 });
    s = reduceMeter(s, { t: "turn_ended", at: 21000, kind: "completed", turnId: "t1" });
    return summarizeTurn(s, CPT, 21000);
  };
  const parked = run(true);
  const charged = run(false);
  assert.equal(parked.toolMs, 20000);
  assert.equal(parked.totalMs, 21000);
  // 200 tokens over the 1 s the model actually worked, not over 21 s.
  assert.equal(Math.round(parked.tokPerSecTurn ?? 0), 200);
  assert.equal(Math.round(charged.tokPerSecTurn ?? 0), Math.round(200 / 21));
});

test("sequential calls park one interval each", () => {
  let s = startTurn(initialMeterState(), 0);
  // Concurrent calls reach the meter as a single transition pair: the caller
  // only dispatches when its set of open calls empties or fills up.
  s = reduceMeter(s, { t: "tool_started", at: 1000 });
  s = reduceMeter(s, { t: "tool_started", at: 1200 });
  assert.equal(s.toolAt, 1000);
  assert.deepEqual(s.toolWaits, []);
  assert.equal(summarizeTurn(s, CPT, 5000).tooling, true);
  s = reduceMeter(s, { t: "tool_ended", at: 5000 });
  assert.equal(s.toolAt, null);
  assert.deepEqual(s.toolWaits, [{ start: 1000, end: 5000 }]);
  s = reduceMeter(s, { t: "tool_started", at: 6000 });
  s = reduceMeter(s, { t: "tool_ended", at: 8000 });
  assert.deepEqual(s.toolWaits, [
    { start: 1000, end: 5000 },
    { start: 6000, end: 8000 },
  ]);
  assert.equal(summarizeTurn(s, CPT, 8000).toolMs, 6000);
});

test("a re-delivered running item does not restart the interval", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "tool_started", at: 1000 });
  s = reduceMeter(s, { t: "tool_started", at: 6000 });
  assert.equal(s.toolAt, 1000);
});

test("a call still running when the turn ends closes the interval at the end", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "tool_started", at: 3000 });
  s = reduceMeter(s, { t: "turn_ended", at: 9000, kind: "canceled", turnId: "t1" });
  assert.equal(s.toolAt, null);
  assert.deepEqual(s.toolWaits, [{ start: 3000, end: 9000 }]);
  const sum = summarizeTurn(s, CPT, 9000);
  assert.equal(sum.tooling, false);
  assert.equal(sum.toolMs, 6000);
});

test("a tool overlapping a user wait is subtracted once", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 100 } });
  s = reduceMeter(s, { t: "user_wait_started", at: 1000 });
  s = reduceMeter(s, { t: "tool_started", at: 2000 });
  s = reduceMeter(s, { t: "tool_ended", at: 8000 });
  s = reduceMeter(s, { t: "user_wait_ended", at: 9000 });
  s = reduceMeter(s, { t: "turn_ended", at: 9000, kind: "completed", turnId: "t1" });
  const sum = summarizeTurn(s, CPT, 9000);
  // The intervals overlap, so the turn's productive time is 9 s minus their
  // union (8 s) — not 9 s minus 8 s + 6 s, which would leave nothing.
  assert.equal(sum.userWaitMs, 8000);
  assert.equal(sum.toolMs, 6000);
  assert.equal(sum.tokPerSecTurn, 100);
  s = reduceMeter(startTurn(initialMeterState(), 0), { t: "reset" });
  assert.equal(s.toolWaits.length, 0);
  assert.equal(s.toolAt, null);
});

test("a window too short to measure keeps its tokens without a rate", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "usage", at: 2000, usage: { output: 100 } });
  // A trailing delta 8 ms after the previous step: 3 tokens over 8 ms would
  // read as 375 tok/s, under the plausibility cap yet no measurement at all.
  s = reduceMeter(s, { t: "usage", at: 2008, usage: { output: 103 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.stepRejected?.tokens, 3);
  assert.equal(s.stepRejected?.windowMs, 8);
  assert.equal(s.unattributedTokens, 3);
  const sum = summarizeTurn(s, CPT, 2008);
  assert.equal(sum.steps, 1);
  assert.equal(sum.outTokens, 100);
  assert.equal(sum.estTokens, 103);
  assert.equal(sum.unattributedTokens, 3);
  // The burst never enters the decode rate.
  assert.equal(Math.round(sum.tokPerSecDecode ?? 0), 100);
});

test("a delegation spanning an open step is parked out of the decode window", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "text", at: 2000, key: "m1", text: "x".repeat(800) });
  // Two minutes of subagent work, and the step's usage only lands after it:
  // this is a parent whose pill read 0.17 tok/s over a 20 minute window.
  s = reduceMeter(s, { t: "delegated_started", at: 2000 });
  s = reduceMeter(s, { t: "delegated_ended", at: 122000 });
  s = reduceMeter(s, { t: "usage", at: 122100, usage: { output: 100 } });
  assert.equal(s.steps.length, 1);
  // The second of generation that actually ran, not the two minutes plus it.
  assert.equal(s.steps[0].decodeMs, 1100);
  const sum = summarizeTurn(s, CPT, 122100);
  assert.equal(sum.delegatedMs, 120000);
  assert.equal(Math.round(sum.tokPerSecDecode ?? 0), Math.round(100 / 1.1));
});

test("a delegation overlapping a tool call is subtracted once", () => {
  let s = startTurn(initialMeterState(), 0);
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "usage", at: 1500, usage: { output: 20 } });
  s = reduceMeter(s, { t: "text", at: 2000, key: "m2", text: "y".repeat(400) });
  s = reduceMeter(s, { t: "delegated_started", at: 2000 });
  s = reduceMeter(s, { t: "tool_started", at: 3000 });
  s = reduceMeter(s, { t: "tool_ended", at: 9000 });
  s = reduceMeter(s, { t: "delegated_ended", at: 10000 });
  s = reduceMeter(s, { t: "usage", at: 10200, usage: { output: 60 } });
  assert.equal(s.steps.length, 2);
  // 2000..10000 is one parked stretch (8 s), not 8 s + 6 s: what is left of
  // the step's generation stays as its window.
  assert.equal(s.steps[1].decodeMs, 200);
});
