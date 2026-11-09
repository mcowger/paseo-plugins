import { t } from "./text";
/**
 * 本地补丁（0.6.0，opus-F53）：时刻按设备时区显示。纯函数，客户端与单元测试共用。
 *
 * Paseo 的定时任务把下次运行（nextRunAt）、上次运行（lastRunAt）、到期时间（expiresAt）和运行记录的 scheduledFor 存成
 * `Date#toISOString()` 的 UTC 串（`2026-10-13T00:00:00.000Z`）；daemon 和设备常不在一个时区，原样显示要人自己换算。
 * 这里把这种时刻写成设备时区的「明天 05:00（9 小时后）」。
 *
 * - 只认带时区的完整时刻：`YYYY-MM-DDTHH:mm`，可带 `:ss` 和小数秒，结尾必须是 `Z`、`±hh:mm` 或 `±hhmm`。
 *   只有日期、不带时区（各端会按不同的时区理解）或者别的写法都不算时刻，原样显示。
 * - 时刻自己算（UTC 年月日时分秒减去偏移），不交给 Date.parse：`+0530`、超过 3 位的小数秒在各个 JS 引擎上结果不一。
 * - 设备时区只用 Date 的本地取值（getFullYear、getHours…），不依赖 Intl，Hermes 也能跑。
 * - 日期按本地日历：今天 / 明天 / 昨天，今年的写「10月14日」，其他年份写「2027年1月3日」。比的是两个本地零点，
 *   夏令时切换那天有 23 或 25 小时，四舍五入后不会差一天。
 * - 括号里的相对时间：
 *   - 不到 1 分钟：将来「即将」，过去「刚刚」；
 *   - 不到 1 小时（按分钟四舍五入）：「N 分钟后 / 前」；
 *   - 不到 48 小时（按小时四舍五入），或者只差一个日历日：「N 小时后 / 前」。分钟和小时都是实际经过的时间，
 *     跨夏令时切换会比两个钟面读数之差多或少一小时；
 *   - 再远按日历天数：「N 天后 / 前」，和前面的日期一致（12 日看 15 日是「3 天后」，不按经过的 3.6 天写成 4 天）；
 *   - 超过 30 天不写相对时间，只看日期。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Relative words stop here: an instant farther away than this many calendar days reads as its date alone. */
export const RELATIVE_DAYS = 30;

// YYYY-MM-DDTHH:mm, optional :ss and fraction, then Z, ±hh:mm or ±hhmm. Upper-case T and Z only.
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|([+-])(\d{2}):?(\d{2}))$/;

/** Epoch milliseconds of a strict ISO-8601 instant with a zone (see the header), else null. */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = INSTANT.exec(value);
  if (!match) return null;
  const field = (index: number) => Number(match[index] ?? 0);
  const [year, month, day, hour, minute, second] = [field(1), field(2), field(3), field(4), field(5), field(6)];
  const [offsetHours, offsetMinutes] = [field(9), field(10)];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) {
    return null;
  }
  const date = new Date(0);
  // setUTCFullYear rather than Date.UTC, which reads the years 0–99 as 1900–1999.
  date.setUTCFullYear(year, month - 1, day);
  // 2月30日 rolls over into March.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  // Fractions beyond milliseconds are cut, not rounded.
  date.setUTCHours(hour, minute, second, Number((match[7] ?? "").slice(0, 3).padEnd(3, "0")));
  const sign = match[8] === "-" ? -1 : 1;
  return date.getTime() - sign * (offsetHours * HOUR + offsetMinutes * MINUTE);
}

export function isInstantString(value: unknown): value is string {
  return parseInstant(value) !== null;
}

const two = (value: number) => String(value).padStart(2, "0");
/** Local midnight of the day `ms` falls on. */
function localMidnight(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
/** Calendar days on the device from the day of `now` to the day of `at`: 1 = tomorrow, -1 = yesterday. */
function calendarDays(at: number, now: number): number {
  return Math.round((localMidnight(at) - localMidnight(now)) / DAY);
}

/** 今天 / 明天 / 昨天, 10月14日 in the year of `now`, else 2027年1月3日: the device-local date of `at`. */
export function dayLabel(at: number, now: number): string {
  const days = calendarDays(at, now);
  if (days === 0) return t("clock.today");
  if (days === 1) return t("clock.tomorrow");
  if (days === -1) return t("clock.yesterday");
  const date = new Date(at);
  return t(date.getFullYear() === new Date(now).getFullYear() ? "clock.monthDay" : "clock.yearMonthDay", {
    year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
  });
}

/** 09:05 on the device's clock. */
export function clockOf(at: number): string {
  const date = new Date(at);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** 「即将」「9 小时后」「3 天前」 by the rules in the header; null farther than `RELATIVE_DAYS` calendar days. */
export function relativeLabel(at: number, now: number): string | null {
  const span = Math.abs(at - now);
  const future = at >= now;
  if (span < MINUTE) return future ? t("clock.soon") : t("clock.justNow");
  const minutes = Math.round(span / MINUTE);
  if (minutes < 60) return t(future ? "clock.minutesAhead" : "clock.minutesAgo", { count: minutes });
  const hours = Math.round(span / HOUR);
  const days = Math.abs(calendarDays(at, now));
  if (hours < 48 || days < 2) return t(future ? "clock.hoursAhead" : "clock.hoursAgo", { count: hours });
  return days > RELATIVE_DAYS ? null : t(future ? "clock.daysAhead" : "clock.daysAgo", { count: days });
}

export interface InstantParts {
  /** Epoch milliseconds. */
  at: number;
  /** 今天 / 明天 / 昨天 / 10月14日 / 2027年1月3日 */
  day: string;
  /** 09:05 */
  clock: string;
  /** 9 小时后 / 刚刚 / 3 天前; null farther than `RELATIVE_DAYS`. */
  relative: string | null;
  /** Not before `now`. */
  future: boolean;
}

/** The pieces of `instantText`, for callers that style them apart; null for anything but a strict instant. */
export function instantParts(value: unknown, now = Date.now()): InstantParts | null {
  const at = parseInstant(value);
  if (at === null) return null;
  return { at, day: dayLabel(at, now), clock: clockOf(at), relative: relativeLabel(at, now), future: at >= now };
}

/** 「明天 05:00（9 小时后）」, 「2027年1月3日 09:00」: a strict ISO-8601 instant on the device's clock; null for anything else. */
export function instantText(value: unknown, now = Date.now()): string | null {
  const parts = instantParts(value, now);
  if (!parts) return null;
  return t(parts.relative ? "clock.instantRelative" : "clock.instant", { day: parts.day, clock: parts.clock, relative: parts.relative });
}
