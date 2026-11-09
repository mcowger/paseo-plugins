import { t } from "./text";
/**
 * 本地补丁：计时。纯函数，客户端、服务端、单元测试共用。
 *
 * 数据从哪来、准不准：
 * - 结束时间：Paseo 投影时间线的每一条都带 `timestamp`，是这一条最后一次更新时 daemon 收到事件的时间
 *   （工具行 = 完成事件，思考行 = 最后一段思考，文字 = 最后一段文字）。准到 daemon 收到事件的时刻。
 * - 开始时间：投影把同一个工具调用的「开始」和「完成」合成一条，开始那一刻的时间不再保存，只能估算。
 *   估算口径（与 Agent 观测台的 digest 一致）：一条的开始 = 同一轮里、在它开始之前（seqEnd < 它的 seqStart）已经结束的
 *   各条里最晚的结束时间，也就是上一步结束（或用户发出消息）的时刻。所以「耗时」= 模型生成这一步的时间 + 执行时间；
 *   同一条消息里并行发出的工具调用，开始时间相同。
 * - 每一轮的下界（0.3.0-local.3）：投影条目带 `turnId`，只在同一轮里找前一条，绝不拿上一轮的结束当开始。
 *   一轮的开始取能拿到的最晚的那个：本轮的用户消息（它就是本轮第一条）、宿主的 `turn_started`（插件服务端记下的时刻）、
 *   Agent 快照里的 `activeTurn.startedAt`。Claude Code 自己醒来的「自主轮」（后台任务结束后）没有用户消息，
 *   拿不到开始时就不显示用时，不再显示「思考了 59 分」这种跨轮的数。
 * - 运行中的行用同一个口径实时走表（daemon 时钟，按 RPC 回包里的 `now` 校正本机时差），完成后停在同一个数上，不会跳。
 * - 看不到前一条（索引窗口的第一条）就不显示；daemon 重放会话时（ACP provider）所有行同一时刻，耗时为 0，也不显示。
 * - 兜底：没有轮次信息的旧数据、或者任何没见过它在运行的行，估出来超过 30 分钟就不显示。
 */
export interface TimedEntry {
  seq: number;
  seqEnd: number;
  /** End time (ms); 0 = unknown. */
  at: number;
  /** Paseo's `turnId`. Entries of one turn are measured only against each other. */
  turn?: string;
}

/** A finished row taking longer than this that nobody saw running gets no time: its start cannot be vouched for. */
export const MAX_UNWITNESSED_MS = 30 * 60 * 1000;

/** Latest end among `entries` that ended strictly before `seq` began (binary search over seqEnd with a prefix max). */
function latestEndBefore(entries: readonly TimedEntry[]): (seq: number) => number | null {
  const byEnd = entries.filter((entry) => entry.at > 0).sort((left, right) => left.seqEnd - right.seqEnd);
  const prefixMax: number[] = [];
  let max = 0;
  for (const entry of byEnd) {
    max = Math.max(max, entry.at);
    prefixMax.push(max);
  }
  return (seq) => {
    let low = 0;
    let high = byEnd.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (byEnd[middle]!.seqEnd < seq) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    return found >= 0 ? prefixMax[found]! : null;
  };
}

/**
 * Start estimate of every entry by seq; null when it cannot be known.
 *
 * Entries with a turn are measured within their turn only: a turn is a contiguous run of one `turnId` in seq order (ids
 * restart when Paseo reopens a session, so two runs with one id are two turns). The first entry of a turn starts at
 * `turnStart(turn)` when known, else it has no start; later ones start at the latest in-turn end before them, never before
 * the turn's start. Entries without a turn (older hosts) fall back to the latest end of anything before them.
 */
export function estimateStarts(
  entries: readonly TimedEntry[],
  turnStart?: (turn: string) => number | null,
): Map<number, number | null> {
  const ordered = [...entries].sort((left, right) => left.seq - right.seq);
  const groups: TimedEntry[][] = [];
  const groupOf = new Map<number, number>();
  let previousTurn: string | null = null;
  for (const entry of ordered) {
    // Entries without a turn neither join nor split a turn.
    if (entry.turn === undefined) continue;
    if (entry.turn !== previousTurn) groups.push([]);
    groups[groups.length - 1]!.push(entry);
    groupOf.set(entry.seq, groups.length - 1);
    previousTurn = entry.turn;
  }
  const anywhere = latestEndBefore(entries);
  const withinGroup = groups.map((group) => latestEndBefore(group));
  const starts = new Map<number, number | null>();
  for (const entry of entries) {
    let start: number | null;
    const group = groupOf.get(entry.seq);
    if (entry.turn === undefined || group === undefined) start = anywhere(entry.seq);
    else {
      const within = withinGroup[group]!(entry.seq);
      let bound = turnStart?.(entry.turn) ?? null;
      // A start recorded after this entry ended belongs to a later turn that reused the id.
      if (bound !== null && entry.at > 0 && bound > entry.at) bound = null;
      start = within === null ? bound : bound === null ? within : Math.max(within, bound);
    }
    starts.set(entry.seq, start !== null && entry.at > 0 && start > entry.at ? entry.at : start);
  }
  return starts;
}

/** What a row needs to say how long it took (client/fold-runtime.ts `RowTiming`). */
export interface RowTimes {
  start: number | null;
  end: number;
  /** The index still has the row running. */
  running: boolean;
  /** The index saw the row running. */
  witnessed: boolean;
}

/**
 * The words for a row's time: final duration, or the live elapsed time of a running row (`liveNow`, daemon clock). A
 * finished row longer than 30 minutes that the index never saw running gets no words: its start cannot be vouched for.
 */
export function rowTimeText(times: RowTimes | null, running: boolean, liveNow: number | null): string | null {
  if (!times || times.start === null) return null;
  // The row finished but the index has not heard yet: wait for the real end instead of showing a short one.
  if (!running && times.running) return null;
  if (running) return liveNow === null ? null : formatDuration(Math.max(0, liveNow - times.start), { live: true });
  const ms = times.end - times.start;
  if (ms > MAX_UNWITNESSED_MS && !times.witnessed) return null;
  return formatDuration(ms);
}

/**
 * 「4.2 秒」「12 秒」「1 分 5 秒」「1 小时 3 分」; null under 0.1 s (nothing worth a number) and for unknown values.
 * `live`: whole seconds only, so a ticking timer does not flicker its decimals.
 */
export function formatDuration(ms: number | null | undefined, options: { live?: boolean } = {}): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < (options.live ? 0 : 100)) return null;
  if (!options.live && ms < 9_950) return t("timing.seconds", { count: (ms / 1000).toFixed(1) });
  const seconds = options.live ? Math.floor(ms / 1000) : Math.round(ms / 1000);
  if (seconds < 60) return t("timing.seconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? t("timing.minutesSeconds", { minutes, seconds: rest }) : t("timing.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? t("timing.hoursMinutes", { hours, minutes: restMinutes }) : t("timing.hours", { count: hours });
}
