import assert from "node:assert/strict";
import test from "node:test";
import { approx, fmtDuration, fmtPercent, fmtRate, fmtTokPerSec, fmtTokens } from "./format";

test("fmtRate keeps three significant digits", () => {
  assert.equal(fmtRate(139.035), "139");
  assert.equal(fmtRate(12.36), "12.4");
  assert.equal(fmtRate(1.869), "1.87");
  assert.equal(fmtRate(0), "—");
  assert.equal(fmtRate(null), "—");
});

test("fmtTokens compact", () => {
  assert.equal(fmtTokens(823), "823");
  assert.equal(fmtTokens(1240), "1.2k");
  assert.equal(fmtTokens(12400), "12k");
  assert.equal(fmtTokens(128_500), "129k");
});

test("fmtTokens plain groups with thin spaces", () => {
  assert.equal(fmtTokens(1240, "plain"), "1\u2009240");
  assert.equal(fmtTokens(1_234_567, "plain"), "1\u2009234\u2009567");
});

test("fmtPercent keeps a useful precision at both ends", () => {
  assert.equal(fmtPercent(0.86), "86%");
  assert.equal(fmtPercent(0.0342), "3.4%");
  assert.equal(fmtPercent(0.0004), "0%");
  assert.equal(fmtPercent(1), "100%");
  assert.equal(fmtPercent(0.99999), "100%");
  assert.equal(fmtPercent(null), "—");
});

test("fmtPercent never rounds a near-miss up to 100%", () => {
  // A 99.86% hit rate (164 fresh tokens against 113k cache reads) is not 100%.
  assert.equal(fmtPercent(0.9986), "99.9%");
  assert.equal(fmtPercent(0.99), "99.0%");
  assert.equal(fmtPercent(0.989), "99%");
});

test("fmtDuration scales units", () => {
  assert.equal(fmtDuration(640), "640ms");
  assert.equal(fmtDuration(12_300), "12.3s");
  assert.equal(fmtDuration(125_000), "2m05s");
  assert.equal(fmtDuration(null), "—");
});

test("approx prefixes estimated numbers", () => {
  assert.equal(approx("130", true), "\u2248130");
  assert.equal(approx("130", false), "130");
  assert.equal(fmtTokPerSec(130, true), "\u2248130 tok/s");
  assert.equal(fmtTokPerSec(null, true), "—");
});
