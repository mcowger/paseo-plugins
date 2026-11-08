import { z } from "zod";

/**
 * 本地补丁：每一轮结束时，在这一轮末尾显示一行时刻。
 *
 * Paseo 只在悬停助手消息时用 tooltip 显示结束时刻；这里把同一时刻固化成一行的常显时间，回看聊天时能直接看到
 * 每一轮是什么时候结束的。行由插件服务端在 `agent.turn_ended` 时写进 Agent 时间线，所以会随会话持久化，重开聊天也在。
 *
 * 时间线只能 append，行的位置由宿主提交的先后决定，通常在这一轮末尾、但不保证（见 server/turn-time.ts）；折叠索引
 * 不收这种行（shared/fold-index.ts），所以它落在哪里都不影响折叠与计时。
 */
export const TURN_TIME_RENDERER_KIND = "vivid-turn-time";
export const TURN_TIME_RENDERER_VERSION = 1;

export const turnTimeDataSchema = z.object({
  /** 这一轮结束的时刻（ms）。 */
  at: z.number().nonnegative(),
  /** Paseo 的 `turnId`；provider 没给时为 null。 */
  turnId: z.string().max(200).nullable(),
  outcome: z.enum(["completed", "failed", "canceled"]),
});

export type TurnTimeData = z.output<typeof turnTimeDataSchema>;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 「2026年10月15日 14:23:05」。
 *
 * 一直带年月日：会话可能横跨很多天，而回看时「昨天 23:59」这类相对说法会随查看时间变化，读起来容易错。
 * 折叠摘要行和每轮末尾那行都用这一个函数，两处格式永远一致。
 */
export function formatTurnTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  const date = new Date(at);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * 本地补丁：一条活动行的结束时刻标签。
 *
 * 时刻来自渲染器本来就拿到的 `timestamp`，也就是这一条最后一次更新时 daemon 收到事件的时间：工具行通常是完成
 * 事件（完成后若还有更新，则是最后一次更新）、思考行是最后一段思考。它是「最近更新时间」，不保证是精确的完成时刻；
 * 和折叠索引里的 `at` 是同一个值，不需要多读一次时间线。
 */
export function endedStamp(at: number | Date, enabled: boolean, running: boolean): string | null {
  if (!enabled || running) return null;
  const ms = typeof at === "number" ? at : at.getTime();
  return formatTurnTime(ms) || null;
}
