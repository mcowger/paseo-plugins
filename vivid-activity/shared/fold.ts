import { t } from "./text";
import { joinList } from "./i18n";
import { estimateStarts, formatDuration, MAX_UNWITNESSED_MS } from "./timing";
import { COUNT_LABELS, isLookKey, type LookKey } from "./vivid-model";

/**
 * 本地补丁：把连续的思考行和工具行折叠成一行。纯函数，不依赖 react-native，客户端、服务端和单元测试共用。
 *
 * 「段」= 两条 Agent 文字、用户消息或其他卡片（任务行、计划卡、审批卡、Bot 卡片、错误、压缩标记……）之间，
 * 由本插件接管的连续思考行和工具行。
 * - 已结束的段（后面已有其他内容，或 Agent 已停下）全部完成后，折叠成一行摘要；点开后整段恢复。
 * - 运行中的段只留运行中、等你批准、失败的行和最近两行，前面完成的步骤收成一行「前面 N 步」。
 */

export type StepStatus = "running" | "completed" | "failed" | "canceled";

/** One projected timeline entry, reduced to what folding needs. */
export interface IndexRow {
  /** `seqStart` of the projected entry: its position. */
  seq: number;
  /** `seqEnd`: the entry's last update. Defaults to `seq`. */
  seqEnd?: number;
  /** End time of the entry in ms (Paseo stamps merged entries with their last update). 0 when unknown. */
  at: number;
  /**
   * reasoning / tool: rows this plugin may draw. boundary: anything else the user sees (text, cards, task rows…).
   * skip: entries Paseo never shows (Claude's TaskCreate/TaskUpdate…); they neither join nor split a segment.
   */
  kind: "reasoning" | "tool" | "boundary" | "skip";
  /** Fold key of reasoning/tool rows (see `toolKey`/`reasoningKey`). */
  key?: string;
  status?: StepStatus;
  look?: LookKey;
  /** Claude Code task notification (Paseo's synthetic `task_notification` row). */
  notice?: { ref: string | null; foreground: boolean };
  /** Boundary kind, for debugging and tests. */
  what?: string;
  /** 0.6.0: an Agent text's length in lines (about), for the pinned question (shared/prompt-pin.ts). */
  lines?: number;
  /** Paseo's `turnId` of the entry (0.3.0-local.3): timing never reaches into an earlier turn, and a new turn starts a new segment. */
  turn?: string;
  /** 0.8.0: lines a finished call added and removed, per file id (shared/changes.ts); absent when not countable. */
  changes?: ReadonlyArray<{ file: string; added: number; removed: number }>;
  /** 0.8.0: the call's changes whose lines are not known (shared/changes.ts); they are counted, never guessed. */
  uncounted?: number;
  /** 0.8.0: a failed command's exit code, when it reported one. */
  exit?: number;
}

export interface FoldOptions {
  /** Which rows the plugin draws: in 仅思考行 tool rows are Paseo's and therefore boundaries. */
  scope: "all" | "reasoning";
  /** 「完成后折叠连续的思考与工具行」. Off: everything stays visible (foreground notices still merge). */
  enabled: boolean;
  /** The Agent's turn is running: the trailing segment is still growing. */
  agentRunning: boolean;
  /** The user's choice for a segment id; undefined = default (collapsed). */
  expanded?: (segment: string) => boolean | undefined;
  /**
   * Keys Paseo has projected (holds in its timeline) at least once. Paseo loads history in pages of 40 entries, so the start
   * of a segment may not be loaded yet: the summary sits on the first loaded row and counts only loaded rows, so expanding
   * shows exactly what it says. Absent = all.
   */
  present?: (key: string) => boolean;
  /**
   * 0.6.0-local.3: what the client decided for a repeat notice it projected (true: folded into its row, which needs that
   * row's result the index may not have); undefined = the index's `foreground`.
   */
  noticeMerged?: (key: string) => boolean | undefined;
  /** Keys other Agents claim differently (forks, identical reasoning text): never hidden, never a summary. */
  contested?: (key: string) => boolean;
  /** Known start of a turn (its user message is a row of its own; this is `turn_started` / `activeTurn.startedAt`). */
  turnStart?: (turn: string) => number | null;
  /** Rows seen running: a long duration of theirs is real even where no turn bounds it. */
  witnessed?: (key: string) => boolean;
  /** Tool call ids waiting for the user's approval. */
  waiting?: ReadonlySet<string>;
  /** Most recent settled rows a running segment keeps visible besides its running ones (default 2). */
  keep?: number;
  /** Smallest finished segment that folds (default 2 steps). */
  minFold?: number;
  /** Smallest number of earlier steps worth a 「前面 N 步」 row (default 2). */
  minHidden?: number;
}

export interface FoldSummary {
  /** Segment id within the agent's timeline epoch (seq of its first row). */
  segment: string;
  /** done = the whole finished segment; earlier = the folded beginning of a running segment. */
  mode: "done" | "earlier";
  expanded: boolean;
  /** Steps in the segment (notices excluded). */
  steps: number;
  /** Steps the summary stands for: all of them (done) or the earlier ones (earlier). */
  hidden: number;
  /** Steps per look, most frequent first, of the steps the summary stands for. */
  counts: Array<[LookKey, number]>;
  failed: number;
  canceled: number;
  /** done: from the content before the segment to its last step; null when unknown. */
  durationMs: number | null;
  endedAt: number | null;
  /**
   * 0.8.0: files the steps changed whose lines are known (edits with a diff; writes and edits without one are left out),
   * and the lines added and removed across them.
   */
  files: number;
  added: number;
  removed: number;
  /** Changes whose lines are not known (writes, deletions, diffs cut short, patches Paseo kept only part of): shown as a count. */
  uncounted: number;
  /** The most changed files (at most FOLD_FILES), each with the key of a step that changed it, to find its path on the client. */
  changed: FoldFile[];
  /** Failed commands (at most FOLD_FAILS), oldest first, with their exit code when known. */
  fails: FoldFail[];
  /**
   * 0.8.0: the segment's turn, and whether this is the last summary of that turn in the index (it shows the turn's tokens).
   * A turn whose last stretch is too short to fold shows them on its last folded one; a turn with no summary shows none.
   */
  turn: string | null;
  lastOfTurn: boolean;
}

// Type aliases, not interfaces: a summary is timeline item data, which must be JSON.
export type FoldFile = { key: string; file: string; added: number; removed: number };
export type FoldFail = { key: string; exit: number | null };

/** Most files a summary lists when expanded; the rest are counted in 「还有 N 个文件」. */
export const FOLD_FILES = 8;
/** Most failed commands a summary lists when expanded. */
export const FOLD_FAILS = 5;

export type FoldRole = { kind: "show" } | { kind: "hide" } | { kind: "fold"; summary: FoldSummary };

export const SHOW: FoldRole = Object.freeze({ kind: "show" }) as FoldRole;
export const HIDE: FoldRole = Object.freeze({ kind: "hide" }) as FoldRole;

export interface SegmentInfo {
  id: string;
  keys: string[];
  sealed: boolean;
  running: boolean;
  mode: "done" | "earlier" | "open";
  anchor: string | null;
}

export interface FoldPlan {
  roles: Map<string, FoldRole>;
  segments: SegmentInfo[];
}

/** Fold key of a tool call row. */
export function toolKey(callId: string): string {
  return `t:${callId}`;
}

/** FNV-1a over UTF-16 code units, base 36. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** 0.4.1: reasoning longer than this is hashed by its first and last half of it only (the key keeps the full length). */
export const REASONING_KEY_SAMPLE = 64 * 1024;

/**
 * Fold key of a reasoning row: its raw text (length + hash). Reasoning carries no id; Paseo's live stream and its projected
 * timeline both concatenate the same chunks, so the texts agree. Identical texts in one agent are ambiguous and never fold.
 * The plugin server keys every reasoning row of a page each time it reads it, so a very long text is sampled: two texts
 * of the same length that differ only in the middle share a key, and like identical texts they then never fold.
 */
export function reasoningKey(text: string): string {
  const half = REASONING_KEY_SAMPLE / 2;
  const sample = text.length <= REASONING_KEY_SAMPLE ? text : text.slice(0, half) + text.slice(-half);
  return `r:${text.length.toString(36)}:${hashText(sample)}`;
}

/** Stable signature of a role, to tell whether a projected row needs drawing again. */
export function roleSignature(role: FoldRole): string {
  if (role.kind !== "fold") return role.kind === "hide" ? "h" : "s";
  const s = role.summary;
  const changed = s.changed.map((file) => `${file.key}:${file.file}:${file.added}:${file.removed}`).join(",");
  const fails = s.fails.map((fail) => `${fail.key}:${fail.exit ?? ""}`).join(",");
  return `f|${s.segment}|${s.mode}|${s.expanded ? 1 : 0}|${s.steps}|${s.hidden}|${s.failed}|${s.canceled}|${s.durationMs ?? ""}|${s.endedAt ?? ""}|${s.counts.map(([look, n]) => `${look}${n}`).join(",")}`
    + `|${s.files}|${s.added}|${s.removed}|${s.uncounted}|${changed}|${fails}|${s.turn ?? ""}|${s.lastOfTurn ? 1 : 0}`;
}

interface Step {
  row: IndexRow;
  key: string;
  status: StepStatus;
  look: LookKey;
  /** A foreground notice whose tool row is known: always hidden, never counted. */
  merged: boolean;
  /** A notice: hidden with its segment, but not a step. */
  notice: boolean;
  /** Same key more than once in this timeline: never hidden, never a summary. */
  ambiguous: boolean;
}

interface Segment {
  steps: Step[];
  /** Turn of its rows (a new turn starts a new segment). */
  turn: string | undefined;
  /** Estimated start of its first row (shared/timing.ts); null when nothing before it is known. */
  startAt: number | null;
  /** Something follows the segment. */
  followed: boolean;
}

function isMember(row: IndexRow, scope: FoldOptions["scope"]): boolean {
  if (!row.key) return false;
  if (row.kind === "reasoning") return true;
  return row.kind === "tool" && scope === "all";
}

function callIdOf(key: string): string | null {
  return key.startsWith("t:") ? key.slice(2) : null;
}

/**
 * 0.8.0: what the steps a summary stands for changed, and which of their commands failed. Adapted from
 * lthieu96/paseo-chat-polish `shared/recap.ts` `changeSummary` (MIT, see NOTICE): there a turn's timeline items are read
 * after it ends and a row is appended; here the plugin server counts each call's lines while it builds the fold index
 * (shared/changes.ts), so the summary only adds up numbers. Calls whose lines are not known are left out, not guessed.
 */
export function summarizeChanges(steps: ReadonlyArray<{ key: string; row: IndexRow; status: StepStatus; look: LookKey; notice?: boolean }>): Pick<FoldSummary, "files" | "added" | "removed" | "uncounted" | "changed" | "fails"> {
  const files = new Map<string, FoldFile & { order: number }>();
  const fails: FoldFail[] = [];
  let added = 0;
  let removed = 0;
  let uncounted = 0;
  for (const step of steps) {
    uncounted += step.row.uncounted ?? 0;
    for (const change of step.row.changes ?? []) {
      added += change.added;
      removed += change.removed;
      const known = files.get(change.file);
      if (known) {
        known.added += change.added;
        known.removed += change.removed;
        known.key = step.key;
      } else {
        files.set(change.file, { key: step.key, file: change.file, added: change.added, removed: change.removed, order: files.size });
      }
    }
    if (step.look === "shell" && step.status === "failed" && !step.notice && fails.length < FOLD_FAILS) fails.push({ key: step.key, exit: step.row.exit ?? null });
  }
  // Most changed first; ties keep the order the files were first changed in.
  const changed = [...files.values()]
    .sort((left, right) => right.added + right.removed - (left.added + left.removed) || left.order - right.order)
    .slice(0, FOLD_FILES)
    .map(({ key, file, added: plus, removed: minus }) => ({ key, file, added: plus, removed: minus }));
  return { files: files.size, added, removed, uncounted, changed, fails };
}

function countLooks(steps: readonly Step[]): Array<[LookKey, number]> {
  const counts = new Map<LookKey, number>();
  for (const step of steps) counts.set(step.look, (counts.get(step.look) ?? 0) + 1);
  // Most frequent first; ties keep first appearance.
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

/**
 * 0.5.0: a tool step the plugin never drew while steps before and after it in the same run were drawn: another plugin
 * took that row (a card of its own, as Bots does with proposals) or Paseo shows it as something else, so it ends the
 * segment like any card. A step not drawn at the start of a run is history Paseo has not loaded yet, one at the end is not
 * drawn yet: both stay members, as before. Reasoning steps never count as foreign: their key follows the text, which
 * changes while it streams, so a drawn one can look absent for a moment.
 */
function splitAtForeign(segment: Segment, options: FoldOptions, starts: ReadonlyMap<number, number | null>): Segment[] {
  const present = options.present;
  if (!present || segment.steps.length < 3) return [segment];
  const drawn = segment.steps.map((step) => present(step.key));
  const firstDrawn = drawn.indexOf(true);
  const lastDrawn = drawn.lastIndexOf(true);
  if (firstDrawn < 0 || lastDrawn - firstDrawn < 2) return [segment];
  const parts: Segment[] = [];
  let current: Segment | null = null;
  for (let index = 0; index < segment.steps.length; index++) {
    const step = segment.steps[index]!;
    if (index > firstDrawn && index < lastDrawn && !drawn[index] && step.row.kind === "tool") {
      if (current) current.followed = true;
      current = null;
      continue;
    }
    if (!current) {
      current = { steps: [], turn: segment.turn, startAt: index === 0 ? segment.startAt : starts.get(step.row.seq) ?? null, followed: false };
      parts.push(current);
    }
    current.steps.push(step);
  }
  if (current) current.followed = segment.followed;
  return parts.length > 0 ? parts : [segment];
}

/** Splits the index into segments of consecutive member rows. */
function segmentRows(rows: readonly IndexRow[], options: FoldOptions): Segment[] {
  const occurrences = new Map<string, number>();
  const tools = new Set<string>();
  for (const row of rows) {
    if (!row.key) continue;
    occurrences.set(row.key, (occurrences.get(row.key) ?? 0) + 1);
    if (row.kind === "tool") tools.add(row.key);
  }
  const starts = estimateStarts(
    rows.map((row) => ({ seq: row.seq, seqEnd: row.seqEnd ?? row.seq, at: row.at, ...(row.turn !== undefined ? { turn: row.turn } : {}) })),
    options.turnStart,
  );
  const segments: Segment[] = [];
  let current: Segment | null = null;
  for (const row of rows) {
    if (row.kind === "skip") continue;
    if (!isMember(row, options.scope)) {
      if (current) {
        current.followed = true;
        current = null;
      }
      continue;
    }
    const key = row.key!;
    const ref = row.notice?.ref ? toolKey(row.notice.ref) : null;
    const foreground = row.notice ? (options.noticeMerged?.(key) ?? row.notice.foreground) : false;
    const merged = Boolean(foreground && ref && (tools.has(ref) || options.present?.(ref)));
    const step: Step = {
      row,
      key,
      status: row.kind === "reasoning" ? "completed" : row.status ?? "completed",
      look: row.kind === "reasoning" ? "think" : row.look ?? "other",
      merged,
      notice: Boolean(row.notice),
      ambiguous: (occurrences.get(key) ?? 0) > 1 || Boolean(options.contested?.(key)),
    };
    // An autonomous turn can follow a turn that ended on a tool row: the runs belong to different rounds.
    if (current && row.turn !== undefined && current.turn !== undefined && row.turn !== current.turn) {
      current.followed = true;
      current = null;
    }
    if (!current) {
      current = { steps: [], turn: row.turn, startAt: starts.get(row.seq) ?? null, followed: false };
      segments.push(current);
    }
    current.steps.push(step);
  }
  return segments.flatMap((segment) => splitAtForeign(segment, options, starts));
}

function isPresent(step: Step, options: FoldOptions): boolean {
  return !options.present || options.present(step.key);
}

function isWaiting(step: Step, options: FoldOptions): boolean {
  const callId = callIdOf(step.key);
  return Boolean(callId && options.waiting?.has(callId));
}

/** Computes every row's fold role for one agent timeline. Rows without a role show as usual. */
export function planFolds(rows: readonly IndexRow[], options: FoldOptions): FoldPlan {
  const keep = options.keep ?? 2;
  const minFold = options.minFold ?? 2;
  const minHidden = options.minHidden ?? 2;
  const roles = new Map<string, FoldRole>();
  const infos: SegmentInfo[] = [];
  const segments = segmentRows(rows, options);
  // 0.8.0: the last summary of each turn shows the turn's tokens (marked once every segment is planned).
  const lastOfTurn = new Map<string, FoldSummary>();
  for (const segment of segments) {
    const first = segment.steps[0]!;
    const turn = segment.turn ?? null;
    const id = String(first.row.seq);
    for (const step of segment.steps) if (step.merged && !step.ambiguous) roles.set(step.key, HIDE);
    const foldable = segment.steps.filter((step) => !step.merged);
    const countable = foldable.filter((step) => !step.notice);
    const sealed = segment.followed || !options.agentRunning;
    const running = !sealed || foldable.some((step) => step.status === "running" || isWaiting(step, options));
    const info: SegmentInfo = { id, keys: segment.steps.map((step) => step.key), sealed, running, mode: "open", anchor: null };
    infos.push(info);
    if (!options.enabled || foldable.length === 0) continue;
    const userExpanded = options.expanded?.(id);

    if (!running) {
      // Rows that stay visible (ambiguous keys) are not part of what the summary stands for.
      const loaded = countable.filter((step) => !step.ambiguous && isPresent(step, options));
      if (loaded.length < minFold) continue;
      const anchor = foldable.find((step) => !step.ambiguous && isPresent(step, options));
      if (!anchor) continue;
      // Parallel calls can finish out of order: the run ends with whichever finished last.
      const end = Math.max(...segment.steps.map((step) => step.row.at));
      let durationMs = segment.startAt !== null && end > 0 && end >= segment.startAt ? end - segment.startAt : null;
      // Without turns (older hosts) the start may sit in an earlier round: hide a long total nobody saw running.
      if (durationMs !== null && durationMs > MAX_UNWITNESSED_MS && segment.turn === undefined && !segment.steps.some((step) => options.witnessed?.(step.key))) {
        durationMs = null;
      }
      // 0.6.0: a failed notice (a background sub-agent or command that failed) is not a step, but the summary says so in red.
      const failedNotices = foldable.filter((step) => step.notice && step.status === "failed" && !step.ambiguous && isPresent(step, options)).length;
      const failed = loaded.filter((step) => step.status === "failed").length + failedNotices;
      // 0.11.0:「失败」段自动展开（此前从未手动开合过，reader 返回 undefined）：失败行与失败清单直接可见。
      // 用户显式开合（true/false）优先，收起的失败段保持紧凑。
      const expanded = userExpanded ?? failed > 0;
      const summary: FoldSummary = {
        segment: id,
        mode: "done",
        expanded,
        steps: loaded.length,
        hidden: loaded.length,
        counts: countLooks(loaded),
        failed,
        canceled: loaded.filter((step) => step.status === "canceled").length,
        durationMs,
        endedAt: end > 0 ? end : null,
        ...summarizeChanges(loaded),
        turn,
        lastOfTurn: false,
      };
      if (turn !== null) lastOfTurn.set(turn, summary);
      info.mode = "done";
      info.anchor = anchor.key;
      for (const step of foldable) {
        if (step.ambiguous) continue;
        roles.set(step.key, step === anchor ? { kind: "fold", summary } : expanded ? SHOW : HIDE);
      }
      continue;
    }

    // Running: keep running, waiting and failed rows plus the two most recent settled ones; fold the finished beginning.
    const live = (step: Step) => step.status === "running" || isWaiting(step, options);
    // 0.5.0: only drawn steps use up the two places (a card another plugin draws at the end of the run does not), but
    // newer steps not drawn yet stay visible too, so a row that just finished is never hidden when it first appears.
    const recent = new Set<Step>();
    const settled = foldable.filter((step) => !live(step));
    for (let index = settled.length - 1, kept = 0; index >= 0 && kept < keep; index--) {
      const step = settled[index]!;
      recent.add(step);
      if (isPresent(step, options)) kept += 1;
    }
    const earlier = foldable.filter((step) => !recent.has(step) && !step.ambiguous && !live(step) && step.status !== "failed");
    const earlierSteps = earlier.filter((step) => !step.notice && isPresent(step, options));
    if (earlierSteps.length < minHidden) continue;
    const anchor = earlier.find((step) => isPresent(step, options));
    if (!anchor) continue;
    // 运行中的段头没有失败计数（失败行保持显示，不计入 earlier）：自动展开只看用户显式开合。
    const expanded = userExpanded ?? false;
    const summary: FoldSummary = {
      segment: id,
      mode: "earlier",
      expanded,
      steps: countable.filter((step) => isPresent(step, options)).length,
      hidden: earlierSteps.length,
      counts: countLooks(earlierSteps),
      failed: 0,
      canceled: earlierSteps.filter((step) => step.status === "canceled").length,
      durationMs: null,
      endedAt: null,
      ...summarizeChanges(earlierSteps),
      turn,
      lastOfTurn: false,
    };
    if (turn !== null) lastOfTurn.set(turn, summary);
    info.mode = "earlier";
    info.anchor = anchor.key;
    for (const step of earlier) roles.set(step.key, step === anchor ? { kind: "fold", summary } : expanded ? SHOW : HIDE);
  }
  for (const summary of lastOfTurn.values()) summary.lastOfTurn = true;
  return { roles, segments: infos };
}

/** A segment's duration in the same words as the rows; null below one second (replayed sessions stamp every row alike). */
export function formatFoldDuration(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) || ms < 1000 ? null : formatDuration(ms);
}

/** Counts as shown: 「思考 2」「命令 5」…, unknown looks as 其他. */
export function foldCountParts(counts: ReadonlyArray<readonly [string, number]>): Array<{ look: LookKey; text: string }> {
  return counts.filter(([, n]) => n > 0).map(([look, n]) => {
    const key = isLookKey(look) ? look : "other";
    return { look: key, text: t("fold.categoryCount", { label: COUNT_LABELS[key], count: n }) };
  });
}

/** The summary's lead words: 「12 步」 or 「前面 7 步」. */
export function foldTitle(summary: Pick<FoldSummary, "mode" | "steps" | "hidden">): string {
  return summary.mode === "earlier" ? t("fold.earlier", { count: summary.hidden }) : t("fold.steps", { count: summary.steps });
}

/** Screen-reader label: 「展开 12 步：思考 2、命令 5，失败 1，用时 1 分 20 秒」. */
export function foldAccessibilityLabel(
  summary: Pick<FoldSummary, "mode" | "steps" | "hidden" | "expanded" | "failed" | "canceled" | "durationMs"> & Partial<Pick<FoldSummary, "files" | "added" | "removed" | "uncounted">> & { counts: ReadonlyArray<readonly [string, number]> },
): string {
  const parts = joinList(foldCountParts(summary.counts).map((part) => part.text));
  const extras = [
    summary.failed > 0 ? t("fold.failed", { count: summary.failed }) : null,
    summary.canceled > 0 ? t("fold.canceled", { count: summary.canceled }) : null,
    // 0.8.0: 「改动 3 个文件 +12 −4」, and the changes whose lines are not known: 「另有 1 处改动未计行数」.
    summary.files ? t("fold.changes", { files: t("fold.files", { count: summary.files }), added: summary.added ?? 0, removed: summary.removed ?? 0 }) : null,
    summary.uncounted ? t(summary.files ? "fold.uncountedLabel" : "fold.uncountedOnly", { count: summary.uncounted }) : null,
    summary.mode === "done" ? (formatFoldDuration(summary.durationMs) ? t("fold.duration", { duration: formatFoldDuration(summary.durationMs) }) : null) : null,
  ].filter(Boolean);
  return t(summary.expanded ? "fold.collapse" : "fold.expand", {
    title: foldTitle(summary),
    parts: parts ? t("fold.countsSuffix", { counts: parts }) : "",
    extras: extras.length ? t("fold.extrasSuffix", { extras: extras.join(t("fold.extrasSeparator")) }) : "",
  });
}
