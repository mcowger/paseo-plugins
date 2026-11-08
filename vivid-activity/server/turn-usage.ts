import { MAX_TOKEN_TURNS, type WireTurnTokens } from "../shared/fold-index.js";

/**
 * 0.8.0：本轮 Token。Paseo 只把用量记在 Agent 快照的 `lastUsage` 上（不在时间线里），而且各 Provider 的含义不一样：
 * - Claude（及按它扩展的自定义 Provider）：每轮结束时宿主把这一轮的合计并进去（SDK result 的 usage），轮中只有上下文占用；
 * - ACP：每轮结束时是这一轮的用量（PromptResponse.usage）；没报用量的一轮沿用上一轮的数，所以要和轮中读到的比；
 * - Codex：每次模型请求结束换成这一次请求的用量（`thread/tokenUsage/updated` 的 last），一轮的合计要逐次累加。
 * 其他 Provider（Pi 报整个会话的累计，OpenCode、OMP 未核实）不显示。
 *
 * 只对实时看到的轮次显示：插件服务端读折叠索引时（客户端在前台、行在屏幕上才读）顺带拿到 Agent 快照，不另外读。
 * - 「按轮」：这一轮运行中读到一次（基线），这一轮结束后第一次读到的就是它的合计，前提是之后没有新的一轮开始
 *   （`agent.turn_started`），并且和基线不同（相同说明这一轮没报用量，判断不了，不显示）。
 * - 「按请求」：读索引的间隔会漏掉请求，所以从这一轮开始（`agent.turn_started`）就在 daemon 里订阅运行中 Agent 的更新
 *   （server/usage-feed.ts），每次用量变了算一次请求；订阅断过、或开始时的基线没读到，就不显示。只显示运行中被读过索引的轮次。
 * 一轮结束就冻结；插件重载、daemon 重启之前的轮次（以及回放的历史）没有数字，不显示。
 */

export type Meter = "turn" | "request";

/** How a turn's tokens are read for an Agent whose provider is built on `base`; null for providers whose figures are not shown. */
export function meterFor(base: string | null | undefined): Meter | null {
  if (base === "claude") return "turn";
  if (base === "codex") return "request";
  if (base === "acp" || base === "copilot" || base === "cursor") return "turn";
  return null;
}

/** An AgentUsage as Paseo reports it: input and output are required; cache reads may be missing. */
export interface RawUsage {
  input: number;
  cached: number | null;
  output: number;
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

export function rawUsage(value: unknown): RawUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as { inputTokens?: unknown; cachedInputTokens?: unknown; outputTokens?: unknown };
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  if (input === null || output === null) return null;
  return { input, cached: count(usage.cachedInputTokens), output };
}

export function sameUsage(left: RawUsage | null | undefined, right: RawUsage | null | undefined): boolean {
  if (!left || !right) return left === right;
  return left.input === right.input && left.cached === right.cached && left.output === right.output;
}

/**
 * The figures a turn shows: fresh input, cache reads and output. Codex counts cached tokens inside its input; they are
 * split out, as the observatory's Token page does, so 输入 means the same for every provider.
 */
export function shownTokens(meter: Meter, usage: RawUsage): { i: number; c: number | null; o: number } {
  const input = meter === "request" && usage.cached !== null ? Math.max(0, usage.input - usage.cached) : usage.input;
  return { i: input, c: usage.cached, o: usage.output };
}

interface Finished {
  i: number;
  c: number | null;
  o: number;
}

interface RequestTurn {
  turn: string;
  /** A fold index read saw the Agent running this turn (the user watched it live). */
  seen: boolean;
  /** The last usage counted (or the baseline); undefined until the baseline is read. */
  last: RawUsage | null | undefined;
  /** Updates that came before the baseline. */
  pending: RawUsage[];
  sum: RawUsage;
  requests: number;
  /** Every update since the turn began was received. */
  complete: boolean;
  /** The turn ended (hook) and waits for its last updates. */
  ending: boolean;
  timer: unknown;
  finished: Promise<void>;
  finish: () => void;
}

interface AgentUsageState {
  /** The last turn the daemon started for this Agent (`agent.turn_started`). */
  lastStarted: string | null;
  /** 「按轮」: the usage read while `turn` ran. */
  before: { turn: string; usage: RawUsage | null } | null;
  /** 「按请求」: the turn being counted. */
  current: RequestTurn | null;
  /** Finished turns with figures, oldest first; only turns watched live. */
  done: Map<string, Finished>;
}

export interface UsageFeed {
  /** Keeps the subscription open while held; releasing the last hold closes it after a while. */
  hold(): void;
  release(): void;
}

export interface TurnUsageDeps {
  /** The built-in an Agent's provider is built on (server/provider-base.ts). */
  base(provider: string): Promise<string | null>;
  /** The Agent's record (`handle.refresh()`, which loads nothing); null when unavailable. */
  refresh(agentId: string): Promise<{ lastUsage?: unknown } | null>;
  feed: UsageFeed;
  /**
   * The name a turn id of the Agent's session now goes by (server/fold-index.ts `turnName`: a session loaded again reuses
   * turn ids, so its turns get other names); the turn id by default. Figures are kept and reported by this name.
   */
  turnName?: (agentId: string, turnId: string) => string;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Time a turn that ended waits for the subscription's last updates before its sum is final. */
export const REQUEST_END_GRACE_MS = 3_000;
/** How long an index read after a Codex turn ended waits for its sum. */
export const REQUEST_END_WAIT_MS = 1_000;
const MAX_AGENTS = 500;
const MAX_DONE = 50;
const MAX_PENDING = 20;
/** Finished turns an answer reports besides the turns of its page. */
const RECENT_TURNS = 3;

export function createTurnUsage(deps: TurnUsageDeps) {
  const agents = new Map<string, AgentUsageState>();
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const nameOf = (agentId: string, turnId: string) => (deps.turnName ? deps.turnName(agentId, turnId) : turnId);

  function state(agentId: string): AgentUsageState {
    let found = agents.get(agentId);
    if (found) {
      // Most recently used last, so the oldest go first when the map is full.
      agents.delete(agentId);
      agents.set(agentId, found);
      return found;
    }
    found = { lastStarted: null, before: null, current: null, done: new Map() };
    agents.set(agentId, found);
    if (agents.size > MAX_AGENTS) {
      for (const [id, old] of agents) {
        if (agents.size <= MAX_AGENTS / 2) break;
        if (old.current) continue;
        agents.delete(id);
      }
    }
    return found;
  }

  function remember(entry: AgentUsageState, turn: string, figures: Finished): void {
    entry.done.delete(turn);
    entry.done.set(turn, figures);
    while (entry.done.size > MAX_DONE) entry.done.delete(entry.done.keys().next().value!);
  }

  function count(current: RequestTurn, usage: RawUsage): void {
    if (current.last === undefined) {
      if (current.pending.length < MAX_PENDING) current.pending.push(usage);
      else current.complete = false;
      return;
    }
    // The same figures again are the same request (another change of the Agent's state carried them).
    if (sameUsage(usage, current.last)) return;
    current.sum = {
      input: current.sum.input + usage.input,
      cached: current.sum.cached === null || usage.cached === null ? null : current.sum.cached + usage.cached,
      output: current.sum.output + usage.output,
    };
    current.requests += 1;
    current.last = usage;
  }

  function finish(agentId: string, current: RequestTurn): void {
    const entry = agents.get(agentId);
    if (!entry || entry.current !== current) return;
    clearTimer(current.timer);
    entry.current = null;
    if (current.seen && current.complete && current.requests > 0) remember(entry, current.turn, shownTokens("request", current.sum));
    current.finish();
    deps.feed.release();
  }

  return {
    /** `agent.turn_started` (every Agent). */
    async turnStarted(agentId: string, provider: string, startedId: string | null): Promise<void> {
      if (!agentId || !startedId) return;
      const turnId = nameOf(agentId, startedId);
      const entry = state(agentId);
      entry.lastStarted = turnId;
      // A session loaded again counts its turn ids from the start again: figures kept under this name belong to an old turn
      // (one the plugin could not tell apart, as after it was reloaded).
      entry.done.delete(turnId);
      if (entry.current && entry.current.turn !== turnId) finish(agentId, entry.current);
      if (meterFor(await deps.base(provider).catch(() => null)) !== "request") return;
      if (entry.lastStarted !== turnId || entry.current) return;
      let finishTurn = () => {};
      const finished = new Promise<void>((resolve) => {
        finishTurn = resolve;
      });
      const current: RequestTurn = {
        turn: turnId, seen: false, last: undefined, pending: [], sum: { input: 0, cached: 0, output: 0 }, requests: 0,
        complete: true, ending: false, timer: null, finished, finish: finishTurn,
      };
      entry.current = current;
      deps.feed.hold();
      // The baseline: what the Agent reported before this turn's first request (the last request of the turn before).
      let record: { lastUsage?: unknown } | null = null;
      try {
        record = await deps.refresh(agentId);
      } catch {
        record = null;
      }
      if (entry.current !== current) return;
      if (!record) {
        current.complete = false;
        current.last = null;
      } else {
        current.last = rawUsage(record.lastUsage);
      }
      const pending = current.pending;
      current.pending = [];
      for (const usage of pending) count(current, usage);
    },

    /** `agent.turn_ended`: the sum is final once the subscription says the Agent left the turn, or after a grace time. */
    turnEnded(agentId: string, turnId: string | null): void {
      const current = agents.get(agentId)?.current;
      if (!current || !turnId || current.turn !== nameOf(agentId, turnId) || current.ending) return;
      current.ending = true;
      current.timer = setTimer(() => finish(agentId, current), REQUEST_END_GRACE_MS);
    },

    /** One message of the subscription (`agent_update` payload). */
    feedUpdate(payload: unknown): void {
      const update = payload as { kind?: unknown; agentId?: unknown; agent?: { id?: unknown; activeTurn?: { turnId?: unknown } | null; lastUsage?: unknown } } | null;
      const agentId = update?.kind === "remove" ? update.agentId : update?.agent?.id;
      if (typeof agentId !== "string") return;
      const current = agents.get(agentId)?.current;
      if (!current) return;
      if (update?.kind === "upsert") {
        const running = update.agent?.activeTurn?.turnId;
        if (typeof running !== "string" || nameOf(agentId, running) !== current.turn) return;
        const usage = rawUsage(update.agent?.lastUsage);
        if (usage) count(current, usage);
        return;
      }
      // The Agent stopped running: Paseo sends an Agent's updates in order, so every update of the turn came before this.
      if (update?.kind === "remove") finish(agentId, current);
    },

    /** The subscription missed updates (it failed, or reconnected with a new snapshot): running sums are incomplete. */
    feedGap(): void {
      for (const entry of agents.values()) if (entry.current) entry.current.complete = false;
    },

    /**
     * A fold index read: what the Agent's record said with the page (`payload.agent`). Returns the tokens to send for
     * `turns` (the names of the page's turns) plus the latest finished ones and a live sum.
     */
    async observe(agentId: string, agent: { provider?: unknown; activeTurn?: { turnId?: unknown } | null; lastUsage?: unknown } | null | undefined, turns: readonly string[]): Promise<WireTurnTokens[] | undefined> {
      if (!agent) return undefined;
      const entry = agents.get(agentId);
      const provider = typeof agent.provider === "string" ? agent.provider : "";
      const meter = meterFor(await deps.base(provider).catch(() => null));
      const running = typeof agent.activeTurn?.turnId === "string" && agent.activeTurn.turnId ? nameOf(agentId, agent.activeTurn.turnId) : null;
      if (meter === "turn") {
        const tracked = entry ?? state(agentId);
        if (running) {
          if (!tracked.before || tracked.before.turn !== running) tracked.before = { turn: running, usage: rawUsage(agent.lastUsage) };
        } else if (tracked.before) {
          const { turn, usage: before } = tracked.before;
          tracked.before = null;
          // Its total, unless another turn began since (its figures would be that one's) or nothing new was reported.
          const after = rawUsage(agent.lastUsage);
          if (tracked.lastStarted === turn && after && !sameUsage(after, before)) remember(tracked, turn, shownTokens("turn", after));
        }
      } else if (meter === "request" && entry?.current) {
        const current = entry.current;
        if (running === current.turn) current.seen = true;
        else if (!running) {
          // The turn just ended: its last updates may still be on the way.
          await Promise.race([current.finished, new Promise<void>((resolve) => setTimer(resolve, REQUEST_END_WAIT_MS))]);
        }
      }
      return report(agentId, turns);
    },

    /**
     * The session closed (`agent.closed`; from Paseo 0.14 also after an hour idle): a turn still counted ends here, and the
     * finished turns keep their figures for their rows (the next session's turns go by other names, `deps.turnName`).
     */
    closed(agentId: string): void {
      const entry = agents.get(agentId);
      if (entry?.current) finish(agentId, entry.current);
      if (entry) entry.before = null;
    },

    /** The Agent was archived: nothing of it is shown live any more. */
    forget(agentId: string): void {
      const entry = agents.get(agentId);
      if (entry?.current) finish(agentId, entry.current);
      agents.delete(agentId);
    },

    dispose(): void {
      for (const [agentId, entry] of Array.from(agents)) if (entry.current) finish(agentId, entry.current);
      agents.clear();
    },

    /** For tests. */
    debug(agentId: string) {
      const entry = agents.get(agentId);
      return entry ? { lastStarted: entry.lastStarted, before: entry.before, current: entry.current && { ...entry.current }, done: [...entry.done] } : null;
    },
  };

  function report(agentId: string, turns: readonly string[]): WireTurnTokens[] | undefined {
    const entry = agents.get(agentId);
    if (!entry) return undefined;
    const out: WireTurnTokens[] = [];
    const added = new Set<string>();
    const push = (turn: string, figures: Finished, live: boolean) => {
      if (added.has(turn) || out.length >= MAX_TOKEN_TURNS || turn.length > 200) return;
      added.add(turn);
      out.push({ id: turn, ...figures, ...(live ? { live: true } : {}) });
    };
    const current = entry.current;
    if (current && current.seen && current.complete && current.requests > 0) push(current.turn, shownTokens("request", current.sum), !current.ending);
    for (const turn of turns) {
      const figures = entry.done.get(turn);
      if (figures) push(turn, figures, false);
    }
    const recent = [...entry.done.keys()].slice(-RECENT_TURNS).reverse();
    for (const turn of recent) push(turn, entry.done.get(turn)!, false);
    return out.length > 0 ? out : undefined;
  }
}

export type TurnUsage = ReturnType<typeof createTurnUsage>;
