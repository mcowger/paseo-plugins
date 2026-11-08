import { describe, expect, it } from "vitest";
import { clockOf, dayLabel, instantParts, instantText, isInstantString, parseInstant, RELATIVE_DAYS, relativeLabel } from "./clock";

// The device of these tests is in New York: EDT (UTC-4) until 1 November 2026 02:00, then EST (UTC-5) until 14 March 2027
// 02:00. `local(…)` builds New York wall-clock times; ISO strings are what the daemon writes (`Date#toISOString()`).
process.env.TZ = "America/New_York";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const local = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

describe("strict ISO-8601 instants", () => {
  it("accepts the daemon's toISOString form and other spellings with a zone", () => {
    const cases: Array<[string, number]> = [
      ["2026-10-13T00:00:00.000Z", Date.UTC(2026, 9, 13)],
      ["2026-10-13T00:00:00Z", Date.UTC(2026, 9, 13)],
      ["2026-10-13T00:00Z", Date.UTC(2026, 9, 13)],
      ["2026-10-13T08:00:00+08:00", Date.UTC(2026, 9, 13)],
      ["2026-10-13T08:00:00+0800", Date.UTC(2026, 9, 13)],
      ["2026-10-13T05:30:00+05:30", Date.UTC(2026, 9, 13)],
      ["2026-10-12T20:00:00-04:00", Date.UTC(2026, 9, 13)],
      ["2026-10-13T00:00:00-00:00", Date.UTC(2026, 9, 13)],
      ["2026-10-13T00:00:00.5Z", Date.UTC(2026, 9, 13, 0, 0, 0, 500)],
      // Fractions beyond milliseconds (Python, Go) are cut.
      ["2026-10-13T00:00:00.123456789Z", Date.UTC(2026, 9, 13, 0, 0, 0, 123)],
      ["2028-02-29T12:00:00Z", Date.UTC(2028, 1, 29, 12)],
    ];
    for (const [value, at] of cases) {
      expect(parseInstant(value), value).toBe(at);
      expect(isInstantString(value), value).toBe(true);
    }
    // Years before 100 stay themselves (Date.UTC would read 0099 as 1999).
    expect(new Date(parseInstant("0099-06-01T00:00:00Z")!).getUTCFullYear()).toBe(99);
  });

  it("leaves dates without a time or a zone, other spellings, impossible values and non-strings alone", () => {
    const strings = [
      "2026-10-13",
      "2026-10-13T00:00:00",
      "2026-10-13T00:00:00.000",
      "2026-10-13T00:00",
      "2026-10-13 00:00:00Z",
      "2026-10-13t00:00:00z",
      "20261013T000000Z",
      "2026-10-13T00:00:00+08",
      "2026-10-13T00:00:00 Z",
      " 2026-10-13T00:00:00Z",
      "2026-10-13T00:00:00Z ",
      "2026-13-01T00:00:00Z",
      "2026-00-10T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2027-02-29T12:00:00Z",
      "2026-10-13T24:00:00Z",
      "2026-10-13T00:60:00Z",
      "2026-10-13T00:00:60Z",
      "2026-10-13T00:00:00+24:00",
      "2026-10-13T00:00:00+08:60",
      "+002026-10-13T00:00:00Z",
      "Tue Oct 13 2026 00:00:00 GMT+0000",
      "下次运行",
      "",
    ];
    for (const value of strings) {
      expect(isInstantString(value), value).toBe(false);
      expect(parseInstant(value), value).toBeNull();
      expect(instantText(value), value).toBeNull();
    }
    for (const value of [Date.UTC(2026, 9, 13), null, undefined, {}, new Date(Date.UTC(2026, 9, 13)), ["2026-10-13T00:00:00Z"]]) {
      expect(isInstantString(value)).toBe(false);
      expect(instantText(value)).toBeNull();
    }
  });
});

describe("the device's day and clock", () => {
  it("runs in the test zone", () => {
    expect(iso(local(2026, 10, 12, 20, 0))).toBe("2026-10-13T00:00:00.000Z");
  });

  it("turns the daemon's UTC string into the device's day and hour", () => {
    const now = local(2026, 10, 12, 15, 0);
    // 「13 号 0 点」 in UTC is 20:00 today here.
    expect(instantText("2026-10-13T00:00:00.000Z", now)).toBe("今天 20:00（5 小时后）");
    const at = parseInstant("2026-10-13T00:00:00.000Z")!;
    expect([dayLabel(at, now), clockOf(at)]).toEqual(["今天", "20:00"]);
    expect(instantText("2026-10-13T09:00:00+08:00", now)).toBe("今天 21:00（6 小时后）");
  });

  it("says 今天 / 明天 / 昨天 by the device's calendar, not by 24-hour spans", () => {
    expect(instantText(iso(local(2026, 10, 12, 17, 0)), local(2026, 10, 12, 15, 0))).toBe("今天 17:00（2 小时后）");
    expect(instantText(iso(local(2026, 10, 13, 5, 0)), local(2026, 10, 12, 20, 0))).toBe("明天 05:00（9 小时后）");
    expect(instantText(iso(local(2026, 10, 12, 22, 10)), local(2026, 10, 13, 1, 10))).toBe("昨天 22:10（3 小时前）");
    expect(instantText(iso(local(2026, 10, 13, 0, 1)), local(2026, 10, 12, 23, 59))).toBe("明天 00:01（2 分钟后）");
    expect(instantText(iso(local(2026, 10, 12, 0, 0)), local(2026, 10, 12, 23, 59))).toBe("今天 00:00（24 小时前）");
  });

  it("writes other days as 10月14日 within the year and 2027年1月3日 across years", () => {
    expect(instantText(iso(local(2026, 10, 14, 9, 0)), local(2026, 10, 12, 9, 0))).toBe("10月14日 09:00（2 天后）");
    expect(instantText(iso(local(2026, 10, 9, 23, 0)), local(2026, 10, 12, 9, 0))).toBe("10月9日 23:00（3 天前）");
    expect(instantText(iso(local(2027, 1, 3, 9, 0)), local(2026, 10, 12, 15, 0))).toBe("2027年1月3日 09:00");
    expect(instantText(iso(local(2027, 1, 2, 9, 0)), local(2026, 12, 30, 10, 0))).toBe("2027年1月2日 09:00（3 天后）");
    expect(instantText(iso(local(2025, 12, 31, 23, 0)), local(2026, 1, 2, 10, 0))).toBe("2025年12月31日 23:00（35 小时前）");
  });
});

describe("relative words", () => {
  const now = local(2026, 10, 12, 12, 0);

  it("says 即将 and 刚刚 under a minute", () => {
    expect(relativeLabel(now, now)).toBe("即将");
    expect(relativeLabel(now + 59_999, now)).toBe("即将");
    expect(relativeLabel(now - 30_000, now)).toBe("刚刚");
    expect(relativeLabel(now - 59_999, now)).toBe("刚刚");
  });

  it("counts minutes under an hour, rounded", () => {
    expect(relativeLabel(now + MINUTE, now)).toBe("1 分钟后");
    expect(relativeLabel(now + 89_000, now)).toBe("1 分钟后");
    expect(relativeLabel(now + 90_000, now)).toBe("2 分钟后");
    expect(relativeLabel(now - 59 * MINUTE, now)).toBe("59 分钟前");
    // 59.5 minutes rounds to an hour.
    expect(relativeLabel(now + 59 * MINUTE + 30_000, now)).toBe("1 小时后");
  });

  it("counts hours under 48 hours, rounded", () => {
    expect(relativeLabel(now + 90 * MINUTE, now)).toBe("2 小时后");
    expect(relativeLabel(now - 3 * HOUR, now)).toBe("3 小时前");
    expect(relativeLabel(now + 47 * HOUR, now)).toBe("47 小时后");
    expect(relativeLabel(now - 47 * HOUR, now)).toBe("47 小时前");
  });

  it("counts calendar days from 48 hours on, matching the date, and stops after 30 days", () => {
    expect(relativeLabel(now + 48 * HOUR, now)).toBe("2 天后");
    // 3.6 days of elapsed time, but the 15th is three days after the 12th.
    expect(relativeLabel(local(2026, 10, 15, 23, 0), local(2026, 10, 12, 9, 0))).toBe("3 天后");
    expect(relativeLabel(local(2026, 10, 9, 1, 0), local(2026, 10, 12, 23, 0))).toBe("3 天前");
    expect(RELATIVE_DAYS).toBe(30);
    expect(relativeLabel(local(2026, 11, 11, 12, 0), now)).toBe("30 天后");
    expect(relativeLabel(local(2026, 11, 12, 12, 0), now)).toBeNull();
    expect(relativeLabel(local(2026, 9, 11, 12, 0), now)).toBeNull();
    expect(instantText(iso(local(2026, 11, 12, 12, 0)), now)).toBe("11月12日 12:00");
    expect(instantText(iso(local(2026, 3, 1, 8, 0)), now)).toBe("3月1日 08:00");
  });
});

describe("daylight saving time", () => {
  it("counts the extra hour when it ends (1 November 2026) and keeps the calendar's days", () => {
    const evening = local(2026, 10, 31, 20, 0);
    expect(iso(evening)).toBe("2026-11-01T00:00:00.000Z");
    // 20:00 EDT → 09:00 EST is 13 hours on the clock face, 14 hours of real time.
    expect(instantText("2026-11-01T14:00:00.000Z", evening)).toBe("明天 09:00（14 小时后）");
    expect(instantText(iso(evening), local(2026, 11, 1, 9, 0))).toBe("昨天 20:00（14 小时前）");
    // 1 November has 25 hours.
    const early = local(2026, 11, 1, 0, 30);
    expect(instantText(iso(local(2026, 11, 1, 23, 30)), early)).toBe("今天 23:30（24 小时后）");
    expect(instantText(iso(local(2026, 11, 2, 0, 30)), early)).toBe("明天 00:30（25 小时后）");
    // 49 hours away, yet only the next calendar day: hours, not 「1 天后」.
    expect(instantText(iso(local(2026, 11, 1, 23, 50)), local(2026, 10, 31, 0, 10))).toBe("明天 23:50（49 小时后）");
  });

  it("counts the missing hour when it starts (14 March 2027)", () => {
    const evening = local(2027, 3, 13, 20, 0);
    expect(iso(evening)).toBe("2027-03-14T01:00:00.000Z");
    // 20:00 EST → 09:00 EDT is 13 hours on the clock face, 12 hours of real time.
    expect(instantText("2027-03-14T13:00:00.000Z", evening)).toBe("明天 09:00（12 小时后）");
    expect(instantText(iso(evening), local(2027, 3, 14, 9, 0))).toBe("昨天 20:00（12 小时前）");
    // 14 March has 23 hours.
    const early = local(2027, 3, 14, 0, 30);
    expect(instantText(iso(local(2027, 3, 14, 23, 30)), early)).toBe("今天 23:30（22 小时后）");
    expect(instantText(iso(local(2027, 3, 15, 0, 30)), early)).toBe("明天 00:30（23 小时后）");
  });
});

describe("instant parts", () => {
  it("splits the text for styling and tells the future from the past", () => {
    const now = local(2026, 10, 12, 15, 0);
    expect(instantParts("2026-10-13T00:00:00.000Z", now)).toEqual({
      at: Date.UTC(2026, 9, 13),
      day: "今天",
      clock: "20:00",
      relative: "5 小时后",
      future: true,
    });
    expect(instantParts(iso(local(2026, 10, 12, 14, 0)), now)).toMatchObject({ day: "今天", clock: "14:00", relative: "1 小时前", future: false });
    expect(instantParts(iso(local(2027, 1, 3, 9, 0)), now)).toMatchObject({ day: "2027年1月3日", relative: null, future: true });
    expect(instantParts("2026-10-13", now)).toBeNull();
  });

  it("reads the time now when not told", () => {
    expect(instantText(iso(Date.now() + 2 * HOUR))).toMatch(/（2 小时后）$/);
  });
});
