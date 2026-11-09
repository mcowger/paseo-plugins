import { describe, expect, it } from "vitest";
import { estimateStarts, formatDuration, MAX_UNWITNESSED_MS, rowTimeText } from "./timing";

describe("start estimates", () => {
  it("starts a step when the previous one ended, the first one when the prompt was sent", () => {
    const starts = estimateStarts([
      { seq: 1, seqEnd: 1, at: 10_000 }, // user message
      { seq: 2, seqEnd: 2, at: 14_000 }, // reasoning
      { seq: 3, seqEnd: 4, at: 19_000 }, // Read
      { seq: 5, seqEnd: 6, at: 30_000 }, // Bash
    ]);
    expect([...starts.entries()]).toEqual([[1, null], [2, 10_000], [3, 14_000], [5, 19_000]]);
  });

  it("gives calls sent together the same start, and ignores a call still running", () => {
    const starts = estimateStarts([
      { seq: 1, seqEnd: 1, at: 10_000 },
      { seq: 2, seqEnd: 7, at: 40_000 }, // long call, finished last
      { seq: 3, seqEnd: 4, at: 20_000 }, // parallel call
      { seq: 5, seqEnd: 5, at: 21_000 }, // reasoning after the short call came back
    ]);
    expect(starts.get(2)).toBe(10_000);
    expect(starts.get(3)).toBe(10_000);
    expect(starts.get(5)).toBe(20_000);
  });

  it("never starts after its own end and skips unknown times", () => {
    const starts = estimateStarts([
      { seq: 1, seqEnd: 1, at: 50_000 },
      { seq: 2, seqEnd: 2, at: 0 },
      { seq: 3, seqEnd: 3, at: 40_000 },
    ]);
    expect(starts.get(2)).toBe(50_000);
    expect(starts.get(3)).toBe(40_000);
  });
});

const HOUR = 3_600_000;

describe("start estimates within a turn (0.3.0-local.3)", () => {
  // The live case: the last reply of turn 31 ended at 03:53:30, Claude Code woke up by itself at 04:52 (no user message).
  const quiet = [
    { seq: 1, seqEnd: 1, at: 10_000, turn: "foreground-turn-31" }, // user message
    { seq: 2, seqEnd: 2, at: 12_000, turn: "foreground-turn-31" }, // reasoning
    { seq: 3, seqEnd: 3, at: 30_000, turn: "foreground-turn-31" }, // reply
  ];

  it("never starts the first row of a turn at the previous turn's end: the first row is reasoning", () => {
    const entries = [...quiet, { seq: 4, seqEnd: 4, at: 30_000 + HOUR, turn: "autonomous-turn-32" }, { seq: 5, seqEnd: 6, at: 33_000 + HOUR, turn: "autonomous-turn-32" }];
    const unknown = estimateStarts(entries);
    expect(unknown.get(4)).toBeNull(); // no start known: no time, rather than 「思考了 59 分」
    expect(unknown.get(5)).toBe(30_000 + HOUR); // later rows of the turn still have the row before them
    const known = estimateStarts(entries, (turn) => (turn === "autonomous-turn-32" ? 29_000 + HOUR : null));
    expect(known.get(4)).toBe(29_000 + HOUR);
  });

  it("the first row is a tool call", () => {
    const entries = [...quiet, { seq: 4, seqEnd: 7, at: 45_000 + HOUR, turn: "autonomous-turn-32" }];
    expect(estimateStarts(entries).get(4)).toBeNull();
    expect(estimateStarts(entries, () => 40_000 + HOUR).get(4)).toBe(40_000 + HOUR);
  });

  it("starts a turn the user opened after a long pause at the user's message, and takes the later of message and turn start", () => {
    const entries = [...quiet, { seq: 4, seqEnd: 4, at: 2 * HOUR, turn: "foreground-turn-33" }, { seq: 5, seqEnd: 5, at: 2 * HOUR + 26_000, turn: "foreground-turn-33" }];
    expect(estimateStarts(entries).get(5)).toBe(2 * HOUR);
    // A message queued before the turn began: the turn's own start is later, and wins.
    expect(estimateStarts(entries, () => 2 * HOUR + 4_000).get(5)).toBe(2 * HOUR + 4_000);
  });

  it("treats a reused turn id after a reopened session as another turn, and ignores a start that came after a row ended", () => {
    const entries = [
      { seq: 1, seqEnd: 1, at: 1_000, turn: "foreground-turn-1" },
      { seq: 2, seqEnd: 2, at: 2_000, turn: "foreground-turn-1" },
      { seq: 3, seqEnd: 3, at: 3_000, turn: "foreground-turn-2" },
      { seq: 4, seqEnd: 4, at: HOUR, turn: "foreground-turn-1" }, // reopened: ordinals start again
      { seq: 5, seqEnd: 5, at: HOUR + 5_000, turn: "foreground-turn-1" },
    ];
    const starts = estimateStarts(entries, (turn) => (turn === "foreground-turn-1" ? HOUR - 2_000 : null));
    expect(starts.get(2)).toBe(1_000); // the old run ignores the new run's start
    expect(starts.get(4)).toBe(HOUR - 2_000); // the new run starts at its own start, not at seq 2 an hour earlier
    expect(starts.get(5)).toBe(HOUR);
  });

  it("keeps the old rule for hosts without turn ids", () => {
    expect(estimateStarts([{ seq: 1, seqEnd: 1, at: 1_000 }, { seq: 2, seqEnd: 2, at: HOUR }]).get(2)).toBe(1_000);
  });
});

describe("row time words", () => {
  const times = (start: number | null, end: number, extra: { running?: boolean; witnessed?: boolean } = {}) => ({ start, end, running: false, witnessed: false, ...extra });

  it("says how long a finished row took, nothing without a start", () => {
    expect(rowTimeText(times(1_000, 5_200), false, null)).toBe("4.2 秒");
    expect(rowTimeText(times(null, 5_200), false, null)).toBeNull();
    expect(rowTimeText(null, false, null)).toBeNull();
  });

  it("hides a finished row longer than 30 minutes that nobody saw running", () => {
    expect(rowTimeText(times(0, MAX_UNWITNESSED_MS + 1_000), false, null)).toBeNull();
    expect(rowTimeText(times(0, MAX_UNWITNESSED_MS + 1_000, { witnessed: true }), false, null)).toBe("30 分 1 秒");
    expect(rowTimeText(times(0, 25 * 60_000), false, null)).toBe("25 分");
  });

  it("ticks a running row on the daemon clock and waits for the real end of a row the index still has running", () => {
    expect(rowTimeText(times(1_000, 0, { running: true }), true, 62_500)).toBe("1 分 1 秒");
    expect(rowTimeText(times(1_000, 0, { running: true }), true, null)).toBeNull();
    expect(rowTimeText(times(1_000, 3_000, { running: true }), false, null)).toBeNull();
  });
});

describe("duration words", () => {
  it("formats finished durations with a decimal below ten seconds", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(40)).toBeNull();
    expect(formatDuration(420)).toBe("0.4 秒");
    expect(formatDuration(4_240)).toBe("4.2 秒");
    expect(formatDuration(9_960)).toBe("10 秒");
    expect(formatDuration(65_000)).toBe("1 分 5 秒");
    expect(formatDuration(120_000)).toBe("2 分");
    expect(formatDuration(3_780_000)).toBe("1 小时 3 分");
  });

  it("ticks live timers in whole seconds", () => {
    expect(formatDuration(400, { live: true })).toBe("0 秒");
    expect(formatDuration(4_900, { live: true })).toBe("4 秒");
    expect(formatDuration(61_900, { live: true })).toBe("1 分 1 秒");
  });
});
