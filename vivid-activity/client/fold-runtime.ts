import { planFolds, roleSignature, SHOW, type FoldPlan, type FoldRole, type IndexRow, type StepStatus } from "../shared/fold";
import { estimateStarts } from "../shared/timing";
import { indexRowFromWire, type FoldIndexInput, type FoldIndexOutput, type WireTurn, type WireTurnTokens } from "../shared/fold-index";
import { promptPin, samePin, type PromptPin } from "../shared/prompt-pin";
import type { TakeoverScope } from "../shared/settings";

/**
 * 本地补丁：折叠的客户端状态，按 Agent 共享，不按行重复计算。
 *
 * Paseo 0.11.1 给插件行的信息只有它自己（没有相邻行、没有序号），而且每条插件行外面都包着一层带 16px 下边距的容器，
 * 行本身画成 0 高也会留下这 16px。所以折叠不能在行里做，只能在时间线转换器里做：被折叠的行返回空数组（连容器一起消失），
 * 段首那一行换成摘要。转换器拿不到 Agent，于是：
 *
 * 1. 每个正在显示的 Agent 一个索引：插件服务端在 daemon 本机读投影时间线，只回传位置、种类、状态和类别（`fold-index` RPC）。
 *    第一行出现时读尾部，之后只读增量；有新行、行状态变化、Agent 文字或用户消息到来时（转换器顺带「戳」一下）再读，
 *    运行中每 15 秒兜底一次；所有行卸载 30 秒后停止，10 分钟后连索引和角色一起丢掉（0.4.1）。
 * 2. 由索引算出每一行的角色（显示 / 折叠 / 摘要），合成一张按折叠键（工具行 callId、思考行文本哈希）查的全局表，供转换器同步查询。
 * 3. 已经画出来的行角色变了，就让 Paseo 重新投影：增删一个空的渲染器，Paseo 会换一个新的组合转换函数，投影缓存随之失效。
 *    用户点击立即重投影；段结束折叠稍等 0.1 秒；运行中的「前面 N 步」最多每 2.5 秒一次，长对话里不会一直重算。
 */

export interface FoldDeps {
  rpc(input: FoldIndexInput): Promise<FoldIndexOutput>;
  /** Makes Paseo project every timeline again (see index.client.tsx). */
  nudge(): void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export type NudgePriority = "now" | "soon" | "auto";
type Cursor = NonNullable<FoldIndexOutput["endCursor"]>;

export const FOLD_TIMING = {
  tailLimit: 160,
  pageLimit: 200,
  maxPages: 5,
  pokeDelay: 2_000,
  rowDelay: 200,
  pollMs: 15_000,
  releaseGraceMs: 30_000,
  /**
   * 0.4.1: an Agent none of whose rows has been on screen for this long is dropped (index, timings, roles). Coming back
   * later reads it afresh, and until that read lands its rows show unfolded, so this is minutes rather than the
   * 30 s after which polling stops: switching between a few Agents keeps their folds.
   */
  forgetMs: 10 * 60_000,
  retryMs: [2_000, 5_000, 15_000],
  /** Smallest gap between two re-projections, by priority. */
  minGap: { now: 0, soon: 600, auto: 2_500 } as Record<NudgePriority, number>,
  delay: { now: 0, soon: 120, auto: 250 } as Record<NudgePriority, number>,
  seenLimit: 60_000,
} as const;

/**
 * 0.5.0: caps on what the runtime keeps per Agent beyond its index rows, for a session left open for days. Each drops its
 * older half once full, like `seen`. A tail read that starts the index over also drops turn starts and running rows the
 * index no longer has, and a new history (epoch) the folds opened in the old one; forgetting an Agent drops all of it.
 */
export const FOLD_MEMORY = {
  witnessed: 4_000,
  turnStarts: 2_000,
  expanded: 500,
  misses: 1_000,
  contested: 10_000,
  /** Agents the rows' 「最新一行」 times are kept for (client/latest-rows.ts); a forgotten Agent drops its own. */
  latestAgents: 1_000,
  /** 0.8.0: turns whose tokens are kept per Agent. */
  tokens: 200,
} as const;

/** Drops the older half (insertion order) of a set or map holding more than `limit` entries; true when it did. */
export function trimOldest(entries: Set<unknown> | Map<unknown, unknown>, limit: number): boolean {
  if (entries.size <= limit) return false;
  let drop = Math.floor(entries.size / 2);
  for (const key of entries.keys()) {
    if (drop-- <= 0) break;
    entries.delete(key);
  }
  return true;
}

interface AgentFolds {
  readonly agentId: string;
  refs: number;
  rows: IndexRow[];
  bySeq: Map<number, IndexRow>;
  byKey: Map<string, IndexRow>;
  epoch: string | null;
  start: Cursor | null;
  end: Cursor | null;
  hasOlder: boolean;
  loaded: boolean;
  running: boolean | null;
  want: { tail: boolean; after: boolean; before: boolean };
  timer: unknown;
  timerDue: number;
  inflight: boolean;
  failures: number;
  retryAt: number;
  lastReadAt: number;
  poll: unknown;
  releaseTimer: unknown;
  misses: Map<string, number>;
  /** Rows that reported before the first read; checked once it lands. */
  early: Map<string, { status: StepStatus | undefined; at: number }>;
  plan: FoldPlan | null;
  /** key → role signature this agent publishes. */
  roles: Map<string, string>;
  /** key → estimated start / end of the row (shared/timing.ts). */
  timings: Map<string, RowTiming>;
  /** Start estimate of whatever the Agent produces next: the latest end among finished entries of the running turn. */
  tailStart: number | null;
  timingListeners: Set<() => void>;
  /** Known turn starts by turn id (the plugin server's `turn_started`, `activeTurn.startedAt`). */
  turnStarts: Map<string, number>;
  /** The running turn from the last answer; null = none; undefined = the host does not say. */
  activeTurn: WireTurn | null | undefined;
  /** Tool rows the index has seen running. */
  witnessed: Set<string>;
  /** The daemon has no such Agent (a provider subagent's view): never ask again. */
  missing: boolean;
  /** 0.6.0: where the latest question is pinned (shared/prompt-pin.ts), and the rows listening for it. */
  pin: PromptPin | null;
  pinListeners: Set<() => void>;
  /** When the pin last moved from one row to another (a live run went on), for the strip's entrance; 0: it appeared. */
  pinMovedAt: number;
  /** 0.8.0: tokens of the turns the plugin server watched live (server/turn-usage.ts), and the rows listening for them. */
  tokens: Map<string, WireTurnTokens>;
  tokenListeners: Set<() => void>;
}

/** When a row ran, on the daemon's clock. `start` is an estimate (see shared/timing.ts); null when unknown. */
export interface RowTiming {
  start: number | null;
  end: number;
  running: boolean;
  /** The index saw this row running, so a long time of its own is real. */
  witnessed: boolean;
}

function newAgent(agentId: string): AgentFolds {
  return {
    agentId,
    refs: 0,
    rows: [],
    bySeq: new Map(),
    byKey: new Map(),
    epoch: null,
    start: null,
    end: null,
    hasOlder: false,
    loaded: false,
    running: null,
    want: { tail: true, after: false, before: false },
    timer: null,
    timerDue: Infinity,
    inflight: false,
    failures: 0,
    retryAt: 0,
    lastReadAt: -Infinity,
    poll: null,
    releaseTimer: null,
    misses: new Map(),
    early: new Map(),
    plan: null,
    roles: new Map(),
    timings: new Map(),
    tailStart: null,
    timingListeners: new Set(),
    turnStarts: new Map(),
    activeTurn: undefined,
    witnessed: new Set(),
    missing: agentId.startsWith("provider:"),
    pin: null,
    pinListeners: new Set(),
    pinMovedAt: 0,
    tokens: new Map(),
    tokenListeners: new Set(),
  };
}

function sortRows(rows: Iterable<IndexRow>): IndexRow[] {
  return [...rows].sort((left, right) => left.seq - right.seq);
}

/** 0.8.0: whether two index rows report the same changed lines, uncounted changes and exit code. */
function sameChanges(left: IndexRow, right: IndexRow): boolean {
  if (left.exit !== right.exit || left.uncounted !== right.uncounted) return false;
  const a = left.changes ?? [];
  const b = right.changes ?? [];
  return a.length === b.length && a.every((change, index) => change.file === b[index]!.file && change.added === b[index]!.added && change.removed === b[index]!.removed);
}

export interface FoldRuntime {
  configure(deps: FoldDeps | null): void;
  settings(): { enabled: boolean; scope: TakeoverScope };
  setSettings(next: { enabled?: boolean; scope?: TakeoverScope }): void;
  /** Transformer side (synchronous, runs while Paseo projects). */
  roleFor(key: string): FoldRole;
  hasSeen(key: string): boolean;
  /** 0.6.0-local.3: whether the transformer folded a repeat notice into its row; the plan follows it (shared/fold.ts). */
  noteNotice(key: string, merged: boolean): void;
  markProjected(key: string, role: FoldRole): void;
  poke(): void;
  /** Renderer side. */
  acquire(agentId: string): void;
  release(agentId: string): void;
  noteRow(agentId: string, key: string, status: StepStatus | undefined, at: number): void;
  setRunning(agentId: string, running: boolean): void;
  isExpanded(agentId: string, segment: string): boolean | undefined;
  toggle(agentId: string, segment: string, expanded: boolean): void;
  scheduleNudge(priority: NudgePriority): void;
  /** Timing of one row; the same object until it changes. */
  timing(agentId: string, key: string): RowTiming | null;
  /** Start estimate for a live row the index does not know yet. */
  tailStart(agentId: string): number | null;
  subscribeTimings(agentId: string, listener: () => void): () => void;
  /** 0.5.0: runs when the runtime forgets an Agent, so what other modules keep per Agent goes with it. */
  onForget(listener: (agentId: string) => void): () => void;
  /** 0.6.0: where the Agent's latest question is pinned; null for nowhere. The same object until it moves. */
  pin(agentId: string): PromptPin | null;
  subscribePin(agentId: string, listener: () => void): () => void;
  /** When the pin last moved to another row (local clock); 0 when it has not moved since it appeared. */
  pinMovedAt(agentId: string): number;
  /** The Agent's timeline epoch, as its index last read it. */
  epoch(agentId: string): string | null;
  /** 0.8.0: tokens of one turn, when the plugin server watched it live; the same object until it changes. */
  turnTokens(agentId: string, turn: string): WireTurnTokens | null;
  subscribeTokens(agentId: string, listener: () => void): () => void;
  /** Now on the daemon's clock (the local clock corrected by the last answer's `now`). */
  serverNow(): number;
  /** For tests and diagnostics. */
  debugAgent(agentId: string): { rows: IndexRow[]; plan: FoldPlan | null; running: boolean | null; refs: number; loaded: boolean } | null;
  /** For tests: how much the runtime keeps (0.5.0). */
  debugMemory(agentId?: string): { agents: number; seen: number; contested: number; expandedAgents: number; expanded: number; witnessed: number; turnStarts: number; misses: number };
}

// Hermes (the phone app) rejects `class` syntax in plugin bundles (client/bundle.test.ts): closures and plain objects only.
export function createFoldRuntime(): FoldRuntime {
  let deps: FoldDeps | null = null;
  let enabled = true;
  let scope: TakeoverScope = "all";
  const agents = new Map<string, AgentFolds>();
  /** key → agentId → role (several agents may claim one key: forks share history). */
  const owners = new Map<string, Map<string, { role: FoldRole; sig: string }>>();
  const effective = new Map<string, { role: FoldRole; sig: string }>();
  /** Role signature each key was last projected with. */
  const applied = new Map<string, string>();
  const seen = new Set<string>();
  /** 0.6.0-local.3: the transformer's decision for each repeat notice it projected (true: folded into its row). */
  const noticeMerged = new Map<string, boolean>();
  /** Keys two Agents claim with different roles; planned as ambiguous from then on. */
  const contested = new Set<string>();
  /** agentId → `${epoch}|${segment}` → the user's choice (0.5.0: per Agent, so forgetting an Agent drops them). */
  const expandedState = new Map<string, Map<string, boolean>>();
  const forgetListeners = new Set<(agentId: string) => void>();
  let nudgeTimer: unknown = null;
  let nudgeDue = Infinity;
  let lastNudge = -Infinity;
  let recomputeTimer: unknown = null;
  const recomputeQueue = new Set<AgentFolds>();
  /** Daemon clock minus local clock, from the last answer. */
  let clockOffset = 0;
  const noteClock = (page: FoldIndexOutput) => {
    if (typeof page.now === "number" && page.now > 0) clockOffset = page.now - now();
  };

  const now = () => deps?.now?.() ?? Date.now();
  const setTimer = (run: () => void, ms: number): unknown => (deps?.setTimer ? deps.setTimer(run, ms) : setTimeout(run, ms));
  const clearTimer = (handle: unknown) => {
    if (handle === null || handle === undefined) return;
    if (deps?.clearTimer) deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  };
  const expandKey = (agent: AgentFolds | undefined, segment: string) => `${agent?.epoch ?? ""}|${segment}`;
  const readExpanded = (agentId: string, segment: string) => {
    const agent = agents.get(agentId);
    return expandedState.get(agentId)?.get(expandKey(agent, segment));
  };
  function writeExpanded(agent: AgentFolds, segment: string, expanded: boolean): void {
    let entries = expandedState.get(agent.agentId);
    if (!entries) {
      entries = new Map();
      expandedState.set(agent.agentId, entries);
    }
    const key = expandKey(agent, segment);
    entries.delete(key);
    entries.set(key, expanded);
    trimOldest(entries, FOLD_MEMORY.expanded);
  }

  // ---- index reads ----

  function request(agent: AgentFolds, kind: "tail" | "after" | "before", delay: number): void {
    if (agent.missing) return;
    agent.want[kind] = true;
    const due = Math.max(now() + delay, agent.retryAt, agent.loaded && agent.running !== false ? agent.lastReadAt + FOLD_TIMING.pokeDelay : 0);
    if (agent.inflight || agent.timerDue <= due) return;
    clearTimer(agent.timer);
    agent.timerDue = due;
    agent.timer = setTimer(() => {
      agent.timer = null;
      agent.timerDue = Infinity;
      void run(agent);
    }, Math.max(0, due - now()));
  }

  function syncPoll(agent: AgentFolds): void {
    const wanted = agent.refs > 0 && agent.running !== false && !agent.missing;
    if (wanted && agent.poll === null) {
      const tick = () => {
        agent.poll = setTimer(tick, FOLD_TIMING.pollMs);
        if (agent.loaded) request(agent, "after", 0);
      };
      agent.poll = setTimer(tick, FOLD_TIMING.pollMs);
    } else if (!wanted && agent.poll !== null) {
      clearTimer(agent.poll);
      agent.poll = null;
    }
  }

  /** Turn starts of one answer; true when one is new. */
  function noteTurnStarts(agent: AgentFolds, turns: readonly WireTurn[] | undefined): boolean {
    let changed = false;
    for (const turn of turns ?? []) {
      if (turn.at === null || agent.turnStarts.get(turn.id) === turn.at) continue;
      agent.turnStarts.set(turn.id, turn.at);
      changed = true;
    }
    if (changed) trimOldest(agent.turnStarts, FOLD_MEMORY.turnStarts);
    return changed;
  }

  /** 0.8.0: tokens of one answer's turns; rows showing them hear about a change. */
  function noteTokens(agent: AgentFolds, page: FoldIndexOutput): void {
    let changed = false;
    // A new history (the session was loaded again) counts its turn ids from the start again: the figures of an old
    // `foreground-turn-1` must not show on the new one.
    if (agent.epoch !== null && page.epoch && page.epoch !== agent.epoch && agent.tokens.size > 0) {
      agent.tokens.clear();
      changed = true;
    }
    for (const entry of page.tok ?? []) {
      const known = agent.tokens.get(entry.id);
      if (known && known.i === entry.i && known.c === entry.c && known.o === entry.o && Boolean(known.live) === Boolean(entry.live)) continue;
      agent.tokens.delete(entry.id);
      agent.tokens.set(entry.id, entry);
      changed = true;
    }
    if (!changed) return;
    trimOldest(agent.tokens, FOLD_MEMORY.tokens);
    for (const listener of agent.tokenListeners) listener();
  }

  /** Turn starts and the running turn of one answer; true when either changed. */
  function noteTurns(agent: AgentFolds, page: FoldIndexOutput): boolean {
    let changed = noteTurnStarts(agent, page.turns);
    if (page.active !== undefined) {
      const before = agent.activeTurn;
      if (before?.id !== page.active?.id || before?.at !== page.active?.at || (before === undefined) !== (page.active === undefined)) changed = true;
      agent.activeTurn = page.active;
      if (page.active) changed = noteTurnStarts(agent, [page.active]) || changed;
    }
    return changed;
  }

  function rowsOf(page: FoldIndexOutput): IndexRow[] {
    return page.rows.map((row) => indexRowFromWire(row, page.turns));
  }

  function witness(agent: AgentFolds, rows: readonly IndexRow[]): void {
    for (const row of rows) if (row.kind === "tool" && row.status === "running" && row.key) agent.witnessed.add(row.key);
    trimOldest(agent.witnessed, FOLD_MEMORY.witnessed);
  }

  /**
   * 0.5.0: the index starts over from a tail page. Turn starts and rows seen running that no row of it needs any more go
   * (older rows read again later bring their turns along); a new history (epoch) also drops its old turn ids, which a
   * reopened session counts from the start again, and the folds the user opened in it.
   */
  function startOver(agent: AgentFolds, page: FoldIndexOutput): void {
    const epochChanged = agent.epoch !== null && page.epoch !== "" && page.epoch !== agent.epoch;
    if (epochChanged) agent.turnStarts.clear();
    noteTurns(agent, page);
    agent.rows = sortRows(rowsOf(page));
    const turns = new Set<string>();
    const keys = new Set<string>();
    for (const row of agent.rows) {
      if (row.turn !== undefined) turns.add(row.turn);
      if (row.key) keys.add(row.key);
    }
    if (agent.activeTurn) turns.add(agent.activeTurn.id);
    for (const id of agent.turnStarts.keys()) if (!turns.has(id)) agent.turnStarts.delete(id);
    for (const key of agent.witnessed) if (!keys.has(key)) agent.witnessed.delete(key);
    if (epochChanged) {
      const entries = expandedState.get(agent.agentId);
      const prefix = `${page.epoch}|`;
      if (entries) for (const key of entries.keys()) if (!key.startsWith(prefix)) entries.delete(key);
    }
  }

  function replace(agent: AgentFolds, page: FoldIndexOutput): void {
    startOver(agent, page);
    witness(agent, agent.rows);
    agent.bySeq = new Map(agent.rows.map((row) => [row.seq, row]));
    agent.byKey = new Map(agent.rows.filter((row) => row.key).map((row) => [row.key!, row]));
    agent.epoch = page.epoch || null;
    agent.start = page.startCursor;
    agent.end = page.endCursor;
    agent.hasOlder = page.hasOlder;
    agent.loaded = true;
    agent.misses.clear();
    if (page.running !== null) agent.running = page.running;
    syncPoll(agent);
  }

  function upsert(agent: AgentFolds, rows: readonly IndexRow[]): boolean {
    let changed = false;
    for (const row of rows) {
      const previous = agent.bySeq.get(row.seq);
      if (previous && previous.key === row.key && previous.status === row.status && previous.kind === row.kind && previous.at === row.at && previous.look === row.look && previous.turn === row.turn && sameChanges(previous, row)) continue;
      if (previous?.key && previous.key !== row.key) agent.byKey.delete(previous.key);
      agent.bySeq.set(row.seq, row);
      if (row.key) {
        agent.byKey.set(row.key, row);
        agent.misses.delete(row.key);
      }
      changed = true;
    }
    if (changed) agent.rows = sortRows(agent.bySeq.values());
    return changed;
  }

  function setRunningFromPage(agent: AgentFolds, running: boolean): boolean {
    if (agent.running === running) return false;
    agent.running = running;
    syncPoll(agent);
    return true;
  }

  /**
   * One read cycle. It serves the requests made before it started; requests that arrive while it reads wait for the next
   * cycle (at most one every `pokeDelay`), so streaming text cannot turn into back-to-back reads.
   */
  async function run(agent: AgentFolds): Promise<void> {
    if (agent.inflight || agent.missing || !deps) return;
    const rpc = deps.rpc;
    agent.inflight = true;
    agent.lastReadAt = now();
    const want = agent.want;
    agent.want = { tail: false, after: false, before: false };
    let changed = false;
    let firstLoad = false;
    const readTail = async () => {
      const page = await rpc({ agentId: agent.agentId, direction: "tail", limit: FOLD_TIMING.tailLimit });
      if (page.status !== "ok") throw new Error(page.status);
      noteClock(page);
      noteTokens(agent, page);
      firstLoad = firstLoad || !agent.loaded;
      replace(agent, page);
      changed = true;
    };
    try {
      if (want.tail || !agent.loaded || !agent.end) {
        await readTail();
      } else {
        let reset = false;
        if (want.after) {
          let cursor: Cursor | null = agent.end;
          for (let pages = 0; cursor && pages < FOLD_TIMING.maxPages; pages++) {
            const page: FoldIndexOutput = await rpc({ agentId: agent.agentId, direction: "after", cursor, limit: FOLD_TIMING.pageLimit });
            if (page.status !== "ok") throw new Error(page.status);
            noteClock(page);
            noteTokens(agent, page);
            if (page.reset || (page.epoch && page.epoch !== agent.epoch)) {
              reset = true;
              break;
            }
            changed = noteTurns(agent, page) || changed;
            const rows = rowsOf(page);
            witness(agent, rows);
            changed = upsert(agent, rows) || changed;
            if (page.endCursor) agent.end = page.endCursor;
            if (page.running !== null) changed = setRunningFromPage(agent, page.running) || changed;
            cursor = page.hasNewer ? page.endCursor : null;
          }
        }
        if (!reset && want.before && agent.hasOlder && agent.start) {
          const page = await rpc({ agentId: agent.agentId, direction: "before", cursor: agent.start, limit: FOLD_TIMING.pageLimit });
          if (page.status !== "ok") throw new Error(page.status);
          if (page.reset || (page.epoch && page.epoch !== agent.epoch)) reset = true;
          else {
            noteTokens(agent, page);
            changed = noteTurnStarts(agent, page.turns) || changed;
            const rows = rowsOf(page);
            witness(agent, rows);
            changed = upsert(agent, rows) || changed;
            agent.start = page.startCursor ?? agent.start;
            agent.hasOlder = page.hasOlder;
          }
        }
        if (reset) await readTail();
      }
      agent.failures = 0;
      agent.retryAt = 0;
    } catch (error) {
      agent.inflight = false;
      if (error instanceof Error && error.message === "missing") {
        // Not an Agent the daemon can read (a provider subagent's own view): leave its rows as they are, stop asking.
        agent.missing = true;
        agent.want = { tail: false, after: false, before: false };
        syncPoll(agent);
        return;
      }
      agent.failures += 1;
      // Keep what was asked for and try again later (2 s, 5 s, then every 15 s) while the Agent is on screen.
      agent.want = { tail: agent.want.tail || want.tail || !agent.loaded, after: true, before: agent.want.before || want.before };
      if (agent.refs > 0) {
        const wait = FOLD_TIMING.retryMs[Math.min(agent.failures - 1, FOLD_TIMING.retryMs.length - 1)]!;
        agent.retryAt = now() + wait;
        request(agent, agent.loaded ? "after" : "tail", wait);
      }
      return;
    }
    agent.inflight = false;
    if (changed) {
      retime(agent);
      recompute(agent, firstLoad ? "soon" : "auto");
    }
    if (agent.early.size > 0 && agent.loaded) {
      const early = [...agent.early];
      agent.early.clear();
      for (const [key, note] of early) runtime.noteRow(agent.agentId, key, note.status, note.at);
    }
    const next = agent.want;
    if (agent.refs > 0 && (next.tail || next.after || next.before)) {
      request(agent, next.tail ? "tail" : next.before ? "before" : "after", FOLD_TIMING.pokeDelay);
    }
  }

  // ---- timings ----

  /** Re-estimates every row's start and end; listeners hear about it only when some row changed. */
  function retime(agent: AgentFolds): void {
    const turnStart = (turn: string) => agent.turnStarts.get(turn) ?? null;
    const starts = estimateStarts(
      agent.rows.map((row) => ({ seq: row.seq, seqEnd: row.seqEnd ?? row.seq, at: row.at, ...(row.turn !== undefined ? { turn: row.turn } : {}) })),
      turnStart,
    );
    const next = new Map<string, RowTiming>();
    let changed = false;
    for (const row of agent.rows) {
      if (!row.key || (row.kind !== "tool" && row.kind !== "reasoning")) continue;
      const timing: RowTiming = {
        start: starts.get(row.seq) ?? null,
        end: row.at,
        running: row.kind === "tool" && row.status === "running",
        witnessed: agent.witnessed.has(row.key),
      };
      const previous = agent.timings.get(row.key);
      if (previous && previous.start === timing.start && previous.end === timing.end && previous.running === timing.running && previous.witnessed === timing.witnessed) {
        next.set(row.key, previous);
        continue;
      }
      next.set(row.key, timing);
      changed = true;
    }
    const tailStart = tailStartOf(agent);
    if (tailStart !== agent.tailStart) {
      agent.tailStart = tailStart;
      changed = true;
    }
    if (!changed && next.size === agent.timings.size) return;
    agent.timings = next;
    for (const listener of agent.timingListeners) listener();
  }

  /**
   * Where a row the index has not caught up with yet (a live reasoning stream, a call that just began) starts: the latest
   * end among finished entries of the running turn, never before that turn's start: the same estimate it gets once the
   * index knows it. Unknown (null) while the running turn is not known: better no timer than one counting from the last turn.
   */
  function tailStartOf(agent: AgentFolds): number | null {
    const finished = (row: IndexRow) => row.at > 0 && !(row.kind === "tool" && row.status === "running");
    if (!agent.rows.some((row) => row.turn !== undefined)) {
      // A host without turn ids: the old estimate.
      let latest: number | null = null;
      for (const row of agent.rows) if (finished(row)) latest = Math.max(latest ?? 0, row.at);
      return latest;
    }
    const active = agent.activeTurn;
    if (!active) return null;
    let latest: number | null = null;
    // The running turn is the last run of its id.
    for (let index = agent.rows.length - 1; index >= 0; index--) {
      const row = agent.rows[index]!;
      if (row.turn === undefined) continue;
      if (row.turn !== active.id) break;
      if (finished(row)) latest = Math.max(latest ?? 0, row.at);
    }
    const bound = active.at ?? agent.turnStarts.get(active.id) ?? null;
    return latest === null ? bound : bound === null ? latest : Math.max(latest, bound);
  }

  // ---- roles ----

  function queueRecompute(agent: AgentFolds): void {
    recomputeQueue.add(agent);
    if (recomputeTimer !== null) return;
    recomputeTimer = setTimer(() => {
      recomputeTimer = null;
      const queued = [...recomputeQueue];
      recomputeQueue.clear();
      for (const entry of queued) recompute(entry, "soon");
    }, 0);
  }

  /** Plans one agent again and publishes its roles; re-projects when a drawn row's role changed. */
  function recompute(agent: AgentFolds, priority: NudgePriority): void {
    if (!agent.loaded) return;
    const planScope = scope === "off" ? null : scope;
    const plan: FoldPlan = planScope
      ? planFolds(agent.rows, {
          scope: planScope,
          enabled,
          agentRunning: agent.running ?? true,
          expanded: (segment) => expandedState.get(agent.agentId)?.get(expandKey(agent, segment)),
          present: (key) => seen.has(key),
          noticeMerged: (key) => noticeMerged.get(key),
          contested: (key) => contested.has(key),
          turnStart: (turn) => agent.turnStarts.get(turn) ?? null,
          witnessed: (key) => agent.witnessed.has(key),
        })
      : { roles: new Map<string, FoldRole>(), segments: [] };
    agent.plan = plan;
    publishRoles(agent, plan.roles, priority);
    // 0.6.0: the latest question goes above the newest segment's first drawn row; rows hear when it moves.
    const pin = planScope ? promptPin(agent.rows, plan, { drawn: (key) => seen.has(key), hasOlder: agent.hasOlder }) : null;
    if (!samePin(agent.pin, pin)) {
      agent.pinMovedAt = agent.pin && pin && agent.pin.key !== pin.key ? now() : 0;
      agent.pin = pin;
      for (const listener of agent.pinListeners) listener();
    }
  }

  /** `quiet`: none of the agent's rows is on screen, so a changed role needs no re-projection. */
  function publishRoles(agent: AgentFolds, roles: Map<string, FoldRole>, priority: NudgePriority, quiet = false): void {
    const touched = new Set<string>();
    for (const key of agent.roles.keys()) if (!roles.has(key)) touched.add(key);
    const next = new Map<string, string>();
    for (const [key, role] of roles) {
      const sig = roleSignature(role);
      next.set(key, sig);
      if (agent.roles.get(key) !== sig) touched.add(key);
    }
    agent.roles = next;
    if (touched.size === 0) return;
    let dirty = false;
    let urgent = false;
    for (const key of touched) {
      const claims = owners.get(key) ?? new Map<string, { role: FoldRole; sig: string }>();
      const role = roles.get(key);
      if (role) claims.set(agent.agentId, { role, sig: next.get(key)! });
      else claims.delete(agent.agentId);
      if (claims.size === 0) owners.delete(key);
      else owners.set(key, claims);
      // Agents that disagree about one key (a fork, or two Agents with the same reasoning text): the key becomes contested,
      // both plan again without it, so each keeps a summary on a row of its own.
      const all = [...claims.values()];
      const agreed = all.length > 0 && all.every((claim) => claim.sig === all[0]!.sig) ? all[0]! : null;
      if (!agreed && all.length > 1 && !contested.has(key)) {
        contested.add(key);
        trimOldest(contested, FOLD_MEMORY.contested);
        for (const agentId of claims.keys()) {
          const other = agents.get(agentId);
          if (other) queueRecompute(other);
        }
      }
      if (agreed) effective.set(key, agreed);
      else effective.delete(key);
      const sig = agreed?.sig ?? "s";
      const previous = applied.get(key);
      if (previous !== undefined && previous !== sig) {
        dirty = true;
        if (agreed?.role.kind === "fold" && agreed.role.summary.mode === "done" && !previous.startsWith("f|")) urgent = true;
      }
    }
    if (dirty && !quiet) runtime.scheduleNudge(urgent && priority === "auto" ? "soon" : priority);
  }

  /**
   * 0.4.1: drops an Agent nobody has looked at for `forgetMs`: its index, timings and the roles it claims. A read still
   * in flight, or a row still listening for its timing, puts it off.
   */
  function forget(agent: AgentFolds): void {
    if (agent.refs > 0 || agents.get(agent.agentId) !== agent) return;
    if (agent.inflight || agent.timingListeners.size > 0 || agent.pinListeners.size > 0 || agent.tokenListeners.size > 0) {
      agent.releaseTimer = setTimer(() => {
        agent.releaseTimer = null;
        forget(agent);
      }, FOLD_TIMING.releaseGraceMs);
      return;
    }
    clearTimer(agent.timer);
    clearTimer(agent.poll);
    agent.timer = null;
    agent.poll = null;
    recomputeQueue.delete(agent);
    publishRoles(agent, new Map(), "auto", true);
    agents.delete(agent.agentId);
    // 0.5.0: the folds the user opened in it, and the keys only its index made contested.
    expandedState.delete(agent.agentId);
    for (const key of contested) {
      if (!agent.byKey.has(key)) continue;
      let shared = false;
      for (const other of agents.values()) if (other.byKey.has(key)) shared = true;
      if (!shared) contested.delete(key);
    }
    for (const listener of forgetListeners) {
      try {
        listener(agent.agentId);
      } catch {
        // A listener's failure must not keep the others' memory.
      }
    }
  }

  const runtime: FoldRuntime = {
    configure(next) {
      deps = next;
    },
    settings() {
      return { enabled, scope };
    },
    setSettings(next) {
      const nextEnabled = next.enabled ?? enabled;
      const nextScope = next.scope ?? scope;
      if (nextEnabled === enabled && nextScope === scope) return;
      enabled = nextEnabled;
      scope = nextScope;
      for (const agent of agents.values()) recompute(agent, "now");
    },
    roleFor(key) {
      return effective.get(key)?.role ?? SHOW;
    },
    hasSeen(key) {
      return seen.has(key);
    },
    noteNotice(key, merged) {
      if (noticeMerged.get(key) === merged) return;
      noticeMerged.set(key, merged);
      if (noticeMerged.size > FOLD_TIMING.seenLimit) {
        let drop = Math.floor(noticeMerged.size / 2);
        for (const old of noticeMerged.keys()) {
          if (drop-- <= 0) break;
          noticeMerged.delete(old);
        }
      }
      for (const agent of agents.values()) if (agent.loaded && agent.byKey.has(key)) queueRecompute(agent);
    },
    markProjected(key, role) {
      applied.set(key, roleSignature(role));
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > FOLD_TIMING.seenLimit) {
        let drop = Math.floor(seen.size / 2);
        for (const old of seen) {
          if (drop-- <= 0) break;
          seen.delete(old);
          applied.delete(old);
        }
        // 0.5.0: rows still on screen may have lost their key; Paseo projecting again records them anew, before a plan
        // takes a drawn row for one another plugin drew (shared/fold.ts splitAtForeign).
        runtime.scheduleNudge("auto");
      }
      for (const agent of agents.values()) if (agent.loaded && agent.byKey.has(key)) queueRecompute(agent);
    },
    poke() {
      for (const agent of agents.values()) if (agent.refs > 0 && agent.loaded && now() >= agent.retryAt) request(agent, "after", FOLD_TIMING.pokeDelay);
    },
    acquire(agentId) {
      let agent = agents.get(agentId);
      if (!agent) {
        agent = newAgent(agentId);
        agents.set(agentId, agent);
      }
      agent.refs += 1;
      if (agent.releaseTimer !== null) {
        clearTimer(agent.releaseTimer);
        agent.releaseTimer = null;
      }
      if (agent.refs === 1) {
        request(agent, agent.loaded ? "after" : "tail", 0);
        syncPoll(agent);
      }
    },
    release(agentId) {
      const agent = agents.get(agentId);
      if (!agent || agent.refs === 0) return;
      agent.refs -= 1;
      if (agent.refs > 0) return;
      agent.releaseTimer = setTimer(() => {
        agent.releaseTimer = null;
        if (agent.refs > 0) return;
        clearTimer(agent.timer);
        agent.timer = null;
        agent.timerDue = Infinity;
        syncPoll(agent);
        // acquire() cancels this second stage too.
        agent.releaseTimer = setTimer(() => {
          agent.releaseTimer = null;
          forget(agent);
        }, FOLD_TIMING.forgetMs - FOLD_TIMING.releaseGraceMs);
      }, FOLD_TIMING.releaseGraceMs);
    },
    noteRow(agentId, key, status, at) {
      const agent = agents.get(agentId);
      if (!agent) return;
      if (!agent.loaded) {
        agent.early.set(key, { status, at });
        return;
      }
      const known = agent.byKey.get(key);
      if (known) {
        if (status && known.kind === "tool" && known.status !== status) request(agent, "after", FOLD_TIMING.rowDelay);
        return;
      }
      const misses = agent.misses.get(key) ?? 0;
      if (misses >= 2) return;
      agent.misses.set(key, misses + 1);
      trimOldest(agent.misses, FOLD_MEMORY.misses);
      const oldest = agent.rows[0];
      const older = agent.hasOlder && oldest !== undefined && at > 0 && oldest.at > 0 && at < oldest.at;
      request(agent, older ? "before" : "after", FOLD_TIMING.rowDelay);
    },
    setRunning(agentId, running) {
      const agent = agents.get(agentId);
      if (!agent || agent.running === running) return;
      agent.running = running;
      syncPoll(agent);
      if (agent.loaded) {
        recompute(agent, "soon");
        request(agent, "after", FOLD_TIMING.rowDelay);
      }
    },
    isExpanded(agentId, segment) {
      return readExpanded(agentId, segment);
    },
    toggle(agentId, segment, expanded) {
      // A summary row keeps its Agent acquired, so the Agent is known; there is nothing to plan without one.
      const agent = agents.get(agentId);
      if (!agent) return;
      writeExpanded(agent, segment, expanded);
      if (agent.loaded) recompute(agent, "now");
    },
    scheduleNudge(priority) {
      const at = now();
      const due = Math.max(at + FOLD_TIMING.delay[priority], lastNudge + FOLD_TIMING.minGap[priority]);
      if (nudgeTimer !== null && nudgeDue <= due) return;
      clearTimer(nudgeTimer);
      nudgeDue = due;
      nudgeTimer = setTimer(() => {
        nudgeTimer = null;
        nudgeDue = Infinity;
        lastNudge = now();
        deps?.nudge();
      }, Math.max(0, due - at));
    },
    timing(agentId, key) {
      return agents.get(agentId)?.timings.get(key) ?? null;
    },
    tailStart(agentId) {
      return agents.get(agentId)?.tailStart ?? null;
    },
    subscribeTimings(agentId, listener) {
      let agent = agents.get(agentId);
      if (!agent) {
        agent = newAgent(agentId);
        agents.set(agentId, agent);
      }
      const target = agent;
      target.timingListeners.add(listener);
      return () => void target.timingListeners.delete(listener);
    },
    serverNow() {
      return now() + clockOffset;
    },
    onForget(listener) {
      forgetListeners.add(listener);
      return () => {
        forgetListeners.delete(listener);
      };
    },
    pin(agentId) {
      return agents.get(agentId)?.pin ?? null;
    },
    subscribePin(agentId, listener) {
      let agent = agents.get(agentId);
      if (!agent) {
        agent = newAgent(agentId);
        agents.set(agentId, agent);
      }
      const target = agent;
      target.pinListeners.add(listener);
      return () => void target.pinListeners.delete(listener);
    },
    pinMovedAt(agentId) {
      return agents.get(agentId)?.pinMovedAt ?? 0;
    },
    epoch(agentId) {
      return agents.get(agentId)?.epoch ?? null;
    },
    turnTokens(agentId, turn) {
      return agents.get(agentId)?.tokens.get(turn) ?? null;
    },
    subscribeTokens(agentId, listener) {
      let agent = agents.get(agentId);
      if (!agent) {
        agent = newAgent(agentId);
        agents.set(agentId, agent);
      }
      const target = agent;
      target.tokenListeners.add(listener);
      return () => void target.tokenListeners.delete(listener);
    },
    debugAgent(agentId) {
      const agent = agents.get(agentId);
      return agent ? { rows: agent.rows, plan: agent.plan, running: agent.running, refs: agent.refs, loaded: agent.loaded } : null;
    },
    debugMemory(agentId) {
      const agent = agentId ? agents.get(agentId) : undefined;
      return {
        agents: agents.size,
        seen: seen.size,
        contested: contested.size,
        expandedAgents: expandedState.size,
        expanded: agentId ? expandedState.get(agentId)?.size ?? 0 : 0,
        witnessed: agent?.witnessed.size ?? 0,
        turnStarts: agent?.turnStarts.size ?? 0,
        misses: agent?.misses.size ?? 0,
      };
    },
  };
  return runtime;
}

/** One runtime per plugin evaluation (that is, per host). */
export const foldRuntime: FoldRuntime = createFoldRuntime();
