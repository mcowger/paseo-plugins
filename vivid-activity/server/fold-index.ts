import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { wirePageFromEntries, type FoldIndexInput, type FoldIndexOutput, type WireTurn } from "../shared/fold-index.js";
import type { TurnUsage } from "./turn-usage.js";

const DEFAULT_LIMIT = 150;

type TimelinePayload = {
  epoch?: unknown;
  entries?: unknown;
  startCursor?: unknown;
  endCursor?: unknown;
  hasOlder?: unknown;
  hasNewer?: unknown;
  reset?: unknown;
  staleCursor?: unknown;
  gap?: unknown;
  agent?: { status?: unknown; cwd?: unknown; provider?: unknown; lastUsage?: unknown; activeTurn?: { turnId?: unknown; startedAt?: unknown } | null } | null;
  error?: unknown;
};

function cursor(value: unknown): FoldIndexOutput["startCursor"] {
  const raw = value as { epoch?: unknown; seq?: unknown } | null;
  return raw && typeof raw.epoch === "string" && raw.epoch && typeof raw.seq === "number" && Number.isInteger(raw.seq) && raw.seq >= 0
    ? { epoch: raw.epoch, seq: raw.seq }
    : null;
}

const EMPTY = {
  epoch: "",
  rows: [],
  startCursor: null,
  endCursor: null,
  hasOlder: false,
  hasNewer: false,
  reset: false,
  running: null,
} as const;
const UNAVAILABLE: FoldIndexOutput = { status: "unavailable", ...EMPTY, rows: [] };
const MISSING: FoldIndexOutput = { status: "missing", ...EMPTY, rows: [] };

/**
 * 本地补丁（0.3.0-local.3）：每一轮的开始时间。投影时间线只告诉我们每条属于哪一轮（`turnId`），不告诉一轮何时开始；
 * Claude Code 自己醒来的「自主轮」连用户消息都没有。插件服务端在 `agent.turn_started` 时记下时刻，读索引时再用 Agent 快照里的
 * `activeTurn.startedAt` 校正。只记在内存里：插件重载或 daemon 重启后，之前的自主轮就不知道开始时间了（客户端那时不显示用时）。
 *
 * 0.10.0-local.3：Paseo 0.14 在 Agent 空闲一小时后关闭它的会话，下次发消息再载入，时间线不变；Claude、Codex、OpenCode 载入的
 * 会话从头数轮次 id，和之前的轮次重名。所以每次 `agent.closed` 换一代，回给客户端的轮次名带上代数（`turnName`，第一代就是
 * 轮次 id），一行属于哪一代看它写下的时间；开始时间按轮次名记，关闭时不再丢掉，归档时才丢。
 */
const TURN_MEMO_LIMIT = 20_000;
const AGENT_LIMIT = 5_000;
const CLOSES_PER_AGENT = 100;
const turnStarts = new Map<string, number>();
/** Per Agent, when its sessions were closed (oldest first), after `dropped` older ones that are no longer kept. */
const closes = new Map<string, { dropped: number; times: number[] }>();
const turnKey = (agentId: string, turn: string) => `${agentId}\u0000${turn}`;

function generationAt(agentId: string, at?: number | null): number {
  const known = closes.get(agentId);
  if (!known) return 0;
  if (at === undefined || at === null) return known.dropped + known.times.length;
  let generation = known.dropped;
  for (const time of known.times) if (time <= at) generation++;
  return generation;
}

/**
 * The name a turn goes by in answers: its turn id in the first session this plugin saw, `<turn id>#<n>` in the n-th one
 * loaded after it. `at`: when one of its rows was written (or it started); the session now when absent.
 */
export function turnName(agentId: string, turnId: string, at?: number | null): string {
  const generation = generationAt(agentId, at);
  return generation === 0 ? turnId : `${turnId}#${generation}`;
}

export function noteTurnStarted(agentId: string, turnId: string | null | undefined, at: number = Date.now()): void {
  if (!agentId || !turnId || !Number.isFinite(at) || at <= 0) return;
  const key = turnKey(agentId, turnName(agentId, turnId, at));
  // A later start for the same turn is it corrected (or one Paseo restarted): the newest wins.
  turnStarts.delete(key);
  turnStarts.set(key, at);
  if (turnStarts.size > TURN_MEMO_LIMIT) {
    let drop = turnStarts.size - TURN_MEMO_LIMIT / 2;
    for (const old of turnStarts.keys()) {
      if (drop-- <= 0) break;
      turnStarts.delete(old);
    }
  }
}

/** The start of a turn, by its name (`turnName`). */
export function knownTurnStart(agentId: string, turn: string): number | null {
  return turnStarts.get(turnKey(agentId, turn)) ?? null;
}

/**
 * The host closed the Agent's session (`agent.closed`; from Paseo 0.14 also after an hour idle). The next session counts
 * its turn ids from the start again: its turns get the next generation, and the starts already known stay for older rows.
 */
export function noteAgentClosed(agentId: string, at: number = Date.now()): void {
  if (!agentId || !Number.isFinite(at)) return;
  const known = closes.get(agentId) ?? { dropped: 0, times: [] };
  closes.delete(agentId);
  known.times.push(at);
  if (known.times.length > CLOSES_PER_AGENT) {
    known.times.shift();
    known.dropped++;
  }
  closes.set(agentId, known);
  while (closes.size > AGENT_LIMIT) forgetAgentTurns(closes.keys().next().value!);
}

/** 0.5.0: an Agent that was archived (`agent.archived`) is done with: its turn starts and sessions go. */
export function forgetAgentTurns(agentId: string): void {
  if (!agentId) return;
  const prefix = turnKey(agentId, "");
  for (const key of turnStarts.keys()) if (key.startsWith(prefix)) turnStarts.delete(key);
  closes.delete(agentId);
}

/** For tests. */
export function turnMemoSize(): number {
  return turnStarts.size;
}

/** For tests. */
export function forgetTurnStarts(): void {
  turnStarts.clear();
  closes.clear();
}

function isMissing(message: unknown): boolean {
  return typeof message === "string" && /not found/i.test(message);
}

/**
 * Reads one page of the Agent's projected timeline inside the daemon and returns its compact index. Only Agents a client
 * is showing ask for this, and showing an Agent already loads it, so the read does not wake idle sessions.
 * 0.8.0: the Agent record that comes with the page also feeds the turn tokens (`usage`, server/turn-usage.ts); nothing
 * more is read for them.
 */
export async function handleFoldIndex(input: FoldIndexInput, context: PluginHandlerContext, usage?: TurnUsage): Promise<FoldIndexOutput> {
  let payload: TimelinePayload;
  try {
    const handle = context.paseo.agents.ref(input.agentId);
    payload = (await handle.timeline.refetch({
      direction: input.direction,
      ...(input.cursor && input.direction !== "tail" ? { cursor: input.cursor } : {}),
      limit: input.limit ?? DEFAULT_LIMIT,
      projection: "projected",
    })) as TimelinePayload;
  } catch (error) {
    // A provider subagent's own view has an id the daemon cannot read: say so, so the client stops asking.
    return isMissing(error instanceof Error ? error.message : String(error)) ? MISSING : UNAVAILABLE;
  }
  if (typeof payload.error === "string" && payload.error) return isMissing(payload.error) ? MISSING : UNAVAILABLE;
  const activeTurn = payload.agent?.activeTurn;
  let active: WireTurn | null = null;
  if (activeTurn && typeof activeTurn.turnId === "string" && activeTurn.turnId) {
    const startedAt = typeof activeTurn.startedAt === "string" ? Date.parse(activeTurn.startedAt) : NaN;
    if (Number.isFinite(startedAt) && startedAt > 0) noteTurnStarted(input.agentId, activeTurn.turnId, startedAt);
    // The running turn is in the session now.
    const turn = turnName(input.agentId, activeTurn.turnId);
    active = { id: turn.slice(0, 200), at: knownTurnStart(input.agentId, turn) };
  }
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const cwd = typeof payload.agent?.cwd === "string" ? payload.agent.cwd : null;
  const { rows, turns } = wirePageFromEntries(
    entries,
    (turn) => knownTurnStart(input.agentId, turn),
    cwd,
    (turnId, rowAt) => turnName(input.agentId, turnId, rowAt),
  );
  const status = payload.agent?.status;
  let tok: FoldIndexOutput["tok"];
  try {
    tok = usage ? await usage.observe(input.agentId, payload.agent, turns.map((turn) => turn.id)) : undefined;
  } catch {
    tok = undefined;
  }
  return {
    status: "ok",
    epoch: typeof payload.epoch === "string" ? payload.epoch : "",
    rows,
    startCursor: cursor(payload.startCursor),
    endCursor: cursor(payload.endCursor),
    hasOlder: payload.hasOlder === true,
    hasNewer: payload.hasNewer === true,
    reset: payload.reset === true || payload.staleCursor === true || payload.gap === true,
    running: typeof status === "string" ? status === "running" : null,
    now: Date.now(),
    turns,
    active,
    ...(tok ? { tok } : {}),
  };
}
