export const MAX_CHILD_TIMELINE_ENTRIES = 8;

/** Rows the 「子 Agent 实时动态」 card shows. */
export const MAX_VISIBLE_CHILD_ACTIVITY_ENTRIES = 3;

/**
 * 0.5.0：每次读子 Agent 时间线的条数（0.4 是 100 条，只为显示 3 条）。daemon 把 limit 用在投影后的条目上
 * （`selectProjectedEntriesTail`），`recentChildTimelineEntries` 不按类型过滤（每种条目都画成一行），所以 8 条一定凑得出
 * 显示的 3 行，也正好是 `recentChildTimelineEntries` 保留的窗口；多出的 5 条留给 daemon 按客户端能力滤掉的条目。
 */
export const CHILD_TIMELINE_PAGE_SIZE = MAX_CHILD_TIMELINE_ENTRIES;

/** 0.6.0: minimum interval between trailing summary refreshes; status changes and manual reads are immediate. */
export const CHILD_EVENT_READ_DELAY_MS = 5_000;

/**
 * 0.6.0-local.5: a running child whose host sends no Agent update for this long is read once more (client/child-agent.tsx).
 * Paseo 0.11.1 sends a running Agent's update only for some events (a model call's usage, a status change), so an ACP child
 * that reports no usage sends none until its turn ends.
 */
export const CHILD_QUIET_READ_MS = 10_000;

/**
 * 0.9.1: how often the card asks after a child on another host (Paseo 0.13 connected hosts) that is not running. That host
 * sends this app nothing about it, so only a status check (it loads nothing) can tell that it started again.
 */
export const CHILD_REMOTE_POLL_MS = 30_000;

export interface TimelineEntryPosition {
  seqStart: number;
  seqEnd: number;
}

export function extractPaseoChildAgentId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const agentId = Reflect.get(value, "agentId");
  return typeof agentId === "string" && agentId.trim() ? agentId : undefined;
}

export function recentChildTimelineEntries<T extends TimelineEntryPosition>(
  entries: readonly T[],
): readonly T[] {
  return [...entries]
    .sort((left, right) => left.seqStart - right.seqStart)
    .slice(-MAX_CHILD_TIMELINE_ENTRIES);
}

export function childTimelineEntryKey(entry: TimelineEntryPosition): string {
  return `${entry.seqStart}-${entry.seqEnd}`;
}

/*
 * 0.5.0：子 Agent 卡片什么时候读时间线。卡片只在「新建 Agent」行展开时挂载（点开，或「只展开最新」时它是最新一行），
 * 0.6.0 改为服务端三行摘要；以下可见性、已加载状态和手动查看规则继续保持：
 * - 只读 daemon 已加载的子 Agent。0.11 里状态 closed 就是没加载，读它的时间线会让 daemon 把它加载起来；
 *   App 的 Agent 列表里没有它（可能已归档或删除）时同样不读。这两种只在用户点「查看动态」时读一次。
 * - 只在前台、卡片在屏幕上时读取。子卡不订阅时间线，使用宿主已有的 Agent 更新。网页用 IntersectionObserver 看卡片的 DOM 节点；原生端没有视口 API，只看前后台
 *   （原生列表会卸载离屏很远的行）。
 * - 暂停期间可能错过的变化记成「有更新」（版本号加一）：暂停时子 Agent 还在运行，或 App 的 Agent 列表里它的状态、
 *   活动时间变了。恢复后有更新才补读一次；什么都没变就不读。
 * - App 的 Agent 列表会留着已归档、已删除 Agent 的旧副本（Paseo 只发一个 remove），插件里 `handle.subscribe()`
 *   也收不到更新（SDK 只在同一个 API 实例订阅了 Agent 列表时才转发），所以卡片自己发起的每次读取之前，都先用
 *   `fetch_agent` 问一次状态（只读存储的记录，不加载 Agent），确认还加载着才读；实时事件合并 0.4 秒再读。
 *   列表里关闭、不认得的子 Agent 有了变化（可能又被加载了），只问状态，不读。
 * - 0.6.0：「确认还加载着」看记录本身（childLoaded：只有活的 Agent 的记录带 activeTurn），不看状态：daemon 异常退出后，
 *   没加载的 Agent 存着的状态仍是 running 或 idle（codex-F18）。问状态失败（断线、超时）时不读，等下一次动静再问
 *   （grok-F9、pi-F2）。合并懒加载版后（0.6.0-local.5）读取和问状态都在服务端的三行摘要里（server/child-summary.ts）：
 *   没加载的子 Agent 由服务端报成 closed，问状态失败报 unconfirmed，卡片只看这个状态。卡片也不再订阅「运行中 Agent」，
 *   所以那里的 remove 不会再被当成归档（opus-F20 不再适用）。
 */

/** Statuses of an Agent the daemon has loaded: reading its timeline wakes nothing. */
const LOADED_STATUSES: ReadonlySet<string> = new Set(["initializing", "idle", "running", "error"]);

/** What the card knows of the child from the daemon (`fetch_agent`, a pushed update, a timeline read). */
export interface ChildRecord {
  status?: string | null;
  archivedAt?: string | null;
  activeTurn?: unknown;
}

/**
 * 0.6.0 (codex-F18): whether the daemon has the child loaded. Paseo 0.11.1 builds the record of a loaded Agent from the live
 * Agent, which always says what turn it runs (`activeTurn`, null between turns); an Agent that is not loaded gets its stored
 * record, without `activeTurn` and with whatever status it last saved. A daemon that went down without closing its Agents
 * leaves them saved as running or idle, so the status alone does not tell: only a live record counts as loaded.
 */
export function childLoaded(agent: ChildRecord | null | undefined): boolean {
  return !!agent && Object.prototype.hasOwnProperty.call(agent, "activeTurn");
}

/**
 * The child's status as far as the card can tell. The app's agent list is live while the child is in it, but it keeps a
 * stale copy of an Agent that left it (archived or deleted: Paseo only sends "remove"), so what the card's own status
 * check found wins when it says the child is gone or closed. The check is the server's summary, which already reports an
 * archived child or one the daemon has not loaded (childLoaded) as closed.
 */
export function childStatus(input: { heard: boolean; agent: Pick<ChildRecord, "status" | "archivedAt"> | null; listed: string | null }): string | null {
  if (input.heard) {
    if (!input.agent) return null;
    if (input.agent.archivedAt || input.agent.status === "closed") return "closed";
  }
  return input.listed ?? (input.heard ? input.agent?.status ?? null : null);
}

/** Whether reading this child's timeline leaves it as it is (loaded, not archived). */
export function childReadable(status: string | null | undefined): boolean {
  return !!status && LOADED_STATUSES.has(status);
}

/** Whether the card is on screen: web asks the browser (pending until it answers); native cannot tell. */
export type CardVisibility = "visible" | "hidden" | "pending" | "unsupported";

/** Why the card does not read the child now: it is not loaded, not known, the app is in the background, or the card is off screen. */
export type ChildFeedHold = "closed" | "unknown" | "background" | "offscreen" | null;

export function childFeedHold(input: { foreground: boolean; visibility: CardVisibility; status: string | null | undefined }): ChildFeedHold {
  if (input.status === "closed") return "closed";
  if (!childReadable(input.status)) return "unknown";
  if (!input.foreground) return "background";
  if (input.visibility === "hidden" || input.visibility === "pending") return "offscreen";
  return null;
}

export interface ChildFeedState {
  /** Why reads are held; null while the card may read summaries. */
  hold: ChildFeedHold;
  /** Goes up with everything the card may not have read yet. */
  version: number;
  /** The version the last finished read covers; 0 before the first. */
  readVersion: number;
}

export type ChildFeedEvent =
  /** The hold changed; `running`: the child was running, so it keeps changing while the card does not listen. */
  | { type: "hold"; hold: ChildFeedHold; running: boolean }
  /** An explicit refresh signal; retained for state-machine callers. */
  | { type: "event" }
  /** The app's copy of the child changed (status, activity time). */
  | { type: "changed"; immediate?: boolean }
  /**
   * 0.6.0-local.5 (codex-vivid-merge-F1): the host has said nothing about a running child for CHILD_QUIET_READ_MS. Read
   * again, but this is no news about the child: an answer still on its way stays current, so a slow 「closed」 counts.
   */
  | { type: "quiet" }
  /** The user asked to read the child (「查看动态」). */
  | { type: "manual" }
  /** 0.9.1: time to ask after a child on another host, which sends no updates here: only its status, never a read. */
  | { type: "poll" }
  /** A read finished; `version` is the state's version when it started. */
  | { type: "read"; version: number };

export interface ChildFeedStep {
  state: ChildFeedState;
  /** Read the child's summary (the scheduler controls the actual interval). */
  read: boolean;
  /**
   * Ask the daemon for the child's status first, inside the summary RPC (`fetch_agent` reads the stored record of an Agent that is not loaded,
   * it loads nothing) and read only if it is still loaded. The app's agent list can be stale, and a child archived while
   * the card listens still sends its last events, so every read the card starts by itself is checked; only a read the
   * user asked for is not (it may load the child on purpose).
   */
  verify: boolean;
  /** Only ask for the status (the app's copy of a child the card does not read changed: it may be loaded again). */
  check: boolean;
}

const NOTHING = { read: false, verify: false, check: false } as const;

/** The card's first state: it has read nothing, so it reads at once if it may. */
export function childFeedStart(hold: ChildFeedHold): ChildFeedStep {
  return { state: { hold, version: 1, readVersion: 0 }, read: hold === null, verify: true, check: false };
}

export function childFeedStep(state: ChildFeedState, event: ChildFeedEvent): ChildFeedStep {
  switch (event.type) {
    case "hold": {
      if (event.hold === state.hold) return { state, ...NOTHING };
      const version = state.hold === null && event.running ? state.version + 1 : state.version;
      return { state: { ...state, hold: event.hold, version }, read: event.hold === null && version > state.readVersion, verify: true, check: false };
    }
    case "event":
      return { state: { ...state, version: state.version + 1 }, read: state.hold === null, verify: true, check: false };
    case "changed":
      if (state.hold === null) return { state: { ...state, version: state.version + 1 }, read: true, verify: true, check: false };
      return { state: { ...state, version: state.version + 1 }, read: false, verify: false, check: state.hold === "closed" || state.hold === "unknown" };
    case "quiet":
      return { state, read: state.hold === null, verify: true, check: false };
    case "manual":
      return { state, read: true, verify: false, check: false };
    case "poll":
      return { state, read: false, verify: false, check: true };
    case "read":
      return { state: { ...state, readVersion: Math.max(state.readVersion, event.version) }, ...NOTHING };
  }
}

/** Something may have changed since the last read (or nothing was read yet). */
export function childFeedDirty(state: ChildFeedState): boolean {
  return state.version > state.readVersion;
}
