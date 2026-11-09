import { t, type MessageId } from "./text";
/**
 * 本地补丁：Claude Code 的后台任务通知。
 *
 * Paseo 0.11.1 把 Claude Code 的 `system/task_notification` 变成一条合成的工具行：`name: "task_notification"`，
 * `detail: { type: "plain_text", label: <summary>, icon: "wrench", text: <整段 <task-notification>> }`，
 * `metadata: { synthetic, source: "claude_task_notification", taskId, toolUseId, status, outputFile }`。行状态由 daemon 换算：
 * failed/error 记失败，canceled/cancelled 记取消，其余（包括 Claude Code 的 killed、stopped、blocked）一律记完成，所以颜色要看
 * `metadata.status` 的原值。
 *
 * 0.6.0：按 Claude Code 2.1（2.1.294 实查）的 summary 模板分类，不再只认 `Background …` 开头：
 * - 后台命令 `Background command "构建" completed (exit code 0)`、`… failed with exit code 1`、`… was stopped`，
 *   以及中途提醒 `… is still running after …`、`… appears to be waiting for interactive input`；
 * - 后台 Agent `Agent "审查登录模块" finished`、`… failed: <错误>`、`… was stopped by user`、`… stopped at its N-turn limit …`；
 * - 监控 `Monitor "x" stream ended` 等，监控事件 `Monitor event: "x"`（不带 tool-use-id）；
 * - 远程任务 `Remote task "x" completed successfully` / `failed` / `is blocked` / `was stopped`；`Task "x" was stopped by …`。
 * 这些都是独立的事件，单独成行；子 Agent 失败显示红色，完成显示绿色。
 * 只有「前台重复」并进它自己的那一行：Claude Code 把运行中转到后台的前台调用的结果再发一遍
 * （`<task-type>tool_call</task-type>`，`The Bash call finished; its result follows. …`），更早的版本是带 `timeout` 的
 * 前台 Bash，summary 就是命令的 description。0.5 之前把不以 Background 开头的都当前台重复，子 Agent 的完成、失败通知
 * 因此被藏掉（opus-F51）。
 */
import { stripAnsi } from "./presentation";

export type NoticeKind = "command" | "agent" | "monitor" | "event" | "remote" | "task" | "workflow" | "repeat" | "other";
/** How the notice ended: done 绿、failed 红、stopped 灰、blocked 红（卡住了，要人处理）、info 不带状态（提醒、事件）。 */
export type NoticeState = "done" | "failed" | "stopped" | "blocked" | "info";
export type NoticeStatus = "completed" | "failed" | "canceled";

export interface TaskNotice {
  /** The tool call the task belongs to (`metadata.toolUseId`). */
  ref: string | null;
  taskId: string | null;
  /** The row's status as this plugin shows it (from `metadata.status` when Claude Code sent one). */
  status: NoticeStatus;
  /** Provider summary as sent (English). */
  summary: string;
  kind: NoticeKind;
  state: NoticeState;
  /** The quoted name: the command's or agent's description, the monitor's name. */
  subject: string | null;
  outputFile: string | null;
  /** 0.6.0-local.2: the notice brings a `<result>` of its own (a detached foreground call's real result). */
  carriesResult: boolean;
  /**
   * 0.6.0-local.3: that `<result>`, XML escapes undone; null without one. 0.6.0-local.4: as Claude Code wrote it, only the
   * line breaks its template puts around it dropped (spaces that start it stay, for comparing with the row).
   */
  result: string | null;
  /** 0.6.0-local.3: `metadata.status` as Claude Code sent it (completed, failed, killed, stopped, blocked), null when absent. */
  hostStatus: string | null;
}

type NoticeSource = {
  name: string;
  status?: string;
  detail?: unknown;
  metadata?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const TASK_NOTICE_TOOL = "task_notification";

/** The words that open a notice with a quoted name (Claude Code 2.1.294 and earlier), up to the name's opening quote. */
const QUOTED_START = /^(Background command|Background workflow|Background agent|Background task|Background job|Agent|Remote task|Monitor|Task)\s+["“]/i;
/**
 * Last resort for an ending no template below knows (another Claude Code version, a hand-written summary): the name ends
 * at the first closing quote that a state word follows. The name may be empty (0.6.0-local.4, codex-vivid-F9).
 */
const QUOTED_LOOSE = /^(.*?)["”]\s+((?:finished|failed|was|were|stopped|completed|succeeded|done|is|appears|ended|script|stream|timed)\b[\s\S]*)$/i;
const QUOTED_KIND: Record<string, NoticeKind> = {
  "background command": "command",
  "background workflow": "workflow",
  "background agent": "agent",
  "background task": "task",
  "background job": "task",
  agent: "agent",
  "remote task": "remote",
  monitor: "monitor",
  task: "task",
};
/**
 * 0.6.0-local.4 (codex-vivid-F8): a summary is read in two bounded parts, never cut before it is read. The opening, the
 * name and a free-text ending (`failed: …`) are looked for in its first SUMMARY_HEAD characters; the fixed endings, which
 * close the summary, in its last ENDING_WINDOW. Before, the summary was cut to 2 000 characters first, so a longer name
 * lost the ending that tells how the task ended, and the state came from words left in the cut name.
 */
const SUMMARY_HEAD = 4_096;
const ENDING_WINDOW = 512;
/** The name and the words after it are shown up to this many characters, after the ending was read from the whole. */
const MAX_SHOWN_CHARS = 2_000;
function shown(value: string): string {
  if (value.length <= MAX_SHOWN_CHARS) return value;
  const cut = value.charCodeAt(MAX_SHOWN_CHARS - 1) >= 0xd800 && value.charCodeAt(MAX_SHOWN_CHARS - 1) <= 0xdbff ? MAX_SHOWN_CHARS - 1 : MAX_SHOWN_CHARS;
  return `${value.slice(0, cut)}…`;
}
/** English template words of a notice: a summary starting with one is never taken for a command's own description. */
const TEMPLATE_START = /^(Background|Agent|Remote|Monitor|Task|Cloud|The)\b|["“”]/i;

interface Parsed {
  kind: NoticeKind;
  subject: string | null;
  /** The Chinese words after the name, e.g. 已完成（退出码 0）. */
  tail: string;
  /** null: take the state from the status. */
  state: NoticeState | null;
}

const STATE_WORDS: Record<NoticeStatus, MessageId> = { completed: "notice.completed", failed: "notice.failed", canceled: "notice.stopped" };
const stateOf = (status: NoticeStatus): NoticeState => (status === "failed" ? "failed" : status === "canceled" ? "stopped" : "done");
const exitCode = (tail: string) => /exit(?: code)? (-?\d+)/i.exec(tail)?.[1];
const withCode = (words: string, tail: string) => {
  const code = exitCode(tail);
  return code !== undefined ? t("notice.exitCode", { words, code }) : words;
};
/** `failed: Unknown error` → 失败：Unknown error. */
const afterColon = (tail: string) => tail.replace(/^[^:]*:\s*/, "").trim();

/**
 * `is still running after 5m, with no new output for 2m.` → [5m, 2m], as `^is still running after (.+?), with no new output
 * for (.+?)\.?$` (i) read it. 0.6.0-local.2 (codex-vivid-F1): found by index; the lazy regex retried past every later
 * separator when the line held a line break.
 */
export function stillRunning(tail: string): [ran: string, quiet: string] | null {
  const start = /^is still running after /i.exec(tail);
  const rest = start ? tail.slice(start[0].length) : "";
  if (!start || /[\n\r\u2028\u2029]/.test(rest)) return null;
  const separator = /, with no new output for /gi;
  separator.lastIndex = 1;
  const found = separator.exec(rest);
  const quiet = found ? rest.slice(separator.lastIndex) : "";
  if (!found || !quiet) return null;
  return [rest.slice(0, found.index), quiet.length > 1 && quiet.endsWith(".") ? quiet.slice(0, -1) : quiet];
}

function commandTail(tail: string): Pick<Parsed, "tail" | "state"> {
  if (/^completed\b/i.test(tail)) return { tail: withCode(t("notice.completed"), tail), state: null };
  if (/^failed\b/i.test(tail)) return { tail: withCode(t("notice.failed"), tail), state: "failed" };
  if (/^was stopped because the system is running low on memory/i.test(tail)) return { tail: t("notice.lowMemory"), state: "stopped" };
  if (/^was stopped after reaching its background time limit/i.test(tail)) return { tail: t("notice.timeLimit"), state: "stopped" };
  if (/^was (stopped|killed)\b/i.test(tail)) return { tail: t("notice.stopped"), state: "stopped" };
  const running = stillRunning(tail);
  if (running) return { tail: t("notice.stillRunning", { ran: running[0], quiet: running[1] }), state: "info" };
  if (/^appears to be waiting for interactive input/i.test(tail)) return { tail: t("notice.waitingInput"), state: "blocked" };
  return { tail: "", state: null };
}

function agentTail(tail: string): Pick<Parsed, "tail" | "state"> {
  if (/^finished\b/i.test(tail)) return { tail: t("notice.completed"), state: "done" };
  const limit = /^stopped at its (\d+)-turn limit/i.exec(tail);
  if (limit) return { tail: t("notice.turnLimit", { count: limit[1] }), state: "stopped" };
  if (/^failed\b/i.test(tail)) {
    const reason = afterColon(tail);
    return { tail: reason && reason !== tail ? t("notice.failedReason", { reason }) : t("notice.failed"), state: "failed" };
  }
  if (/^was stopped by user\b/i.test(tail)) return { tail: t("notice.stoppedByUser"), state: "stopped" };
  if (/^was stopped by Claude\b/i.test(tail)) return { tail: t("notice.stoppedByClaude"), state: "stopped" };
  if (/^was stopped:/i.test(tail)) return { tail: t("notice.stoppedReason", { reason: afterColon(tail) }), state: "stopped" };
  if (/^was stopped\b/i.test(tail)) return { tail: t("notice.stopped"), state: "stopped" };
  if (/^was resumed by the user\b/i.test(tail)) return { tail: t("notice.resumedByUser"), state: "info" };
  if (/^was resumed by another agent\b/i.test(tail)) return { tail: t("notice.resumedByAgent"), state: "info" };
  return { tail: "", state: null };
}

function monitorTail(tail: string): Pick<Parsed, "tail" | "state"> {
  if (/^ended without producing output/i.test(tail)) return { tail: withCode(t("notice.endedNoOutput"), tail), state: "done" };
  if (/^stream ended\b/i.test(tail)) return { tail: t("notice.streamEnded"), state: "done" };
  if (/^script failed\b/i.test(tail)) return { tail: withCode(t("notice.scriptFailed"), tail), state: "failed" };
  if (/^stopped\b/i.test(tail)) return { tail: t("notice.stopped"), state: "stopped" };
  return { tail: "", state: null };
}

function remoteTail(tail: string): Pick<Parsed, "tail" | "state"> {
  if (/^completed\b/i.test(tail)) return { tail: t("notice.completed"), state: "done" };
  if (/^failed\b/i.test(tail)) return { tail: t("notice.failed"), state: "failed" };
  if (/^is blocked:/i.test(tail)) return { tail: t("notice.blockedReason", { reason: afterColon(tail) }), state: "blocked" };
  if (/^is blocked\b/i.test(tail)) return { tail: t("notice.blocked"), state: "blocked" };
  if (/^was stopped\b/i.test(tail)) return { tail: t("notice.stopped"), state: "stopped" };
  return { tail: "", state: null };
}

function taskTail(tail: string): Pick<Parsed, "tail" | "state"> {
  if (/^was stopped by the user\b/i.test(tail)) return { tail: t("notice.stoppedByUser"), state: "stopped" };
  const by = /^was stopped by (.+?)\.?$/i.exec(tail);
  if (by) return { tail: t("notice.stoppedBy", { name: by[1] }), state: "stopped" };
  return { tail: "", state: null };
}

/** Any other tail: the plain state words, with the exit code when there is one. */
function genericTail(tail: string): Pick<Parsed, "tail" | "state"> {
  if (/\b(fail|failed|error)\b/i.test(tail)) return { tail: withCode(t("notice.failed"), tail), state: "failed" };
  if (/\btimed out\b/i.test(tail)) return { tail: t("notice.timeout"), state: "stopped" };
  if (/\b(stopp?ed|killed|cancell?ed|interrupted)\b/i.test(tail)) return { tail: t("notice.stopped"), state: "stopped" };
  if (/\b(completed?|finished|succeeded|done)\b/i.test(tail)) return { tail: withCode(t("notice.completed"), tail), state: null };
  return { tail: "", state: null };
}

/** How the host says the task ended (`metadata.status`, as Claude Code sent it): killed and stopped read alike. */
type HostEnd = "completed" | "failed" | "stopped" | "blocked";
function hostEnd(raw: string | null | undefined): HostEnd | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "completed") return "completed";
  if (value === "failed" || value === "error") return "failed";
  if (value === "killed" || value === "stopped" || value === "canceled" || value === "cancelled") return "stopped";
  return value === "blocked" ? "blocked" : null;
}

/**
 * The endings Claude Code 2.1.294 writes after a quoted name, by kind, with the host status each comes with. `re` is a
 * fixed ending, anchored at the end of the summary (closing quote included); `lead` opens free text (an error, a reason)
 * and is taken at its first occurrence after a closing quote. Names and errors keep their quotes unescaped, so neither
 * the first nor the last quote can tell where a name ends (codex-vivid-F5): `Agent "Investigate why "job" finished early"
 * stopped at its 30-turn limit (…)` ends with the turn limit, `Agent "审查" failed: Hook "validate" finished …` is a failure.
 */
type Ending = { end: HostEnd | null; re?: RegExp; lead?: string };
const ENDINGS: Partial<Record<NoticeKind, readonly Ending[]>> = {
  agent: [
    { end: "completed", re: /["”] finished$/ },
    { end: "completed", re: /["”] stopped at its \d+-turn limit \(partial result[^"”]*\)$/ },
    { end: "stopped", re: /["”] was stopped(?: by (?:Claude|user))?$/ },
    { end: null, re: /["”] was resumed by (?:the user|another agent and now reports to it; its completion will not be delivered here\.)$/ },
    { end: "failed", lead: " failed: " },
    { end: "stopped", lead: " was stopped: " },
    // `Background agent "x" was checkpointed for the background fork but …`.
    { end: "failed", lead: " was checkpointed for the background fork but " },
  ],
  command: [
    { end: "completed", re: /["”] completed(?: \(exit code -?\d+(?:: [^"”]*)?\))?$/ },
    { end: "failed", re: /["”] failed(?: with exit code -?\d+)?$/ },
    { end: "stopped", re: /["”] was stopped(?: because the system is running low on memory| after reaching its background time limit)?$/ },
    { end: null, re: /["”] is still running after [^"”]+, with no new output for [^"”]+$/ },
    { end: null, re: /["”] appears to be waiting for interactive input$/ },
  ],
  monitor: [
    { end: "completed", re: /["”] ended without producing output(?: \(exit -?\d+\))?$/ },
    { end: "completed", re: /["”] stream ended$/ },
    { end: "failed", re: /["”] script failed(?: \(exit -?\d+\))?$/ },
    { end: "stopped", re: /["”] stopped$/ },
  ],
  remote: [
    { end: "completed", re: /["”] completed(?: successfully)?$/ },
    { end: "failed", re: /["”] failed$/ },
    { end: "blocked", re: /["”] is blocked$/ },
    { end: "stopped", re: /["”] was stopped$/ },
    { end: "blocked", lead: " is blocked: " },
  ],
  task: [{ end: "stopped", lead: " was stopped by " }],
  workflow: [{ end: "failed", lead: " was checkpointed for the background fork but " }],
};

/**
 * Where the quoted name that starts at `start` ends in `value` (the whole summary): the endings that go with the host's
 * status first, fixed before free, then the others. `known` is false for the last resort, the first closing quote that a
 * state word follows: its words may be the name's own. 0.6.0-local.3 (codex-vivid-F5): 0.6.0-local.2 always took that
 * last rule, so a name holding 「"job" finished」 read as finished. 0.6.0-local.4 (codex-vivid-F8): fixed endings are
 * matched in the summary's last ENDING_WINDOW characters (they end it, and their patterns stay cheap there), free ones
 * in its first SUMMARY_HEAD characters or that window. The name may be empty, its closing quote right at `start`
 * (codex-vivid-F9: Claude Code's Agent tool takes an empty or all-blank description and sends `Agent "" stopped at its
 * 30-turn limit (…)`); whether there is a name to show is the caller's question, not the ending's.
 */
function splitQuoted(kind: NoticeKind, value: string, start: number, host: HostEnd | null): { name: string; tail: string; known: boolean } | null {
  const endings = ENDINGS[kind] ?? [];
  const fits = (ending: Ending) => host !== null && ending.end === host;
  const head = value.slice(0, SUMMARY_HEAD);
  const from = Math.max(start, value.length - ENDING_WINDOW);
  const last = value.slice(from);
  const split = (at: number) => ({ name: value.slice(start, at), tail: value.slice(at + 2, at + 2 + SUMMARY_HEAD), known: true });
  for (const group of [endings.filter(fits), endings.filter((ending) => !fits(ending))]) {
    for (const ending of group) {
      const found = ending.re?.exec(last);
      if (found && from + found.index >= start) return split(from + found.index);
    }
    for (const ending of group) {
      if (!ending.lead) continue;
      const inHead = quoteBefore(head, ending.lead, start);
      if (inHead >= start) return split(inHead);
      const inLast = quoteBefore(last, ending.lead, 0);
      if (inLast >= 0 && from + inLast >= start) return split(from + inLast);
    }
  }
  const loose = QUOTED_LOOSE.exec(head.slice(start));
  return loose ? { name: loose[1]!, tail: loose[2]!, known: false } : null;
}
/** `text` up to its last closing quote (`"` or `”`), or all of it when it has none. */
function beforeLastQuote(text: string): string {
  const at = Math.max(text.lastIndexOf('"'), text.lastIndexOf("”"));
  return at < 0 ? text : text.slice(0, at);
}
/** Index of the first closing quote (`"` or `”`) right before `lead` in `text`, at `from` or later; -1 when there is none. */
function quoteBefore(text: string, lead: string, from: number): number {
  for (let at = text.indexOf(lead, from + 1); at >= 0; at = text.indexOf(lead, at + 1)) {
    if (text[at - 1] === '"' || text[at - 1] === "”") return at - 1;
  }
  return -1;
}

/**
 * Reads a notice summary by Claude Code's templates; `taskType` is the `<task-type>` of the raw text, when there is one,
 * and `hostStatus` the status Claude Code sent (`metadata.status`), which tells the template where a quoted name ends.
 */
export function parseNoticeSummary(summary: string, taskType: string | null = null, hostStatus: string | null = null): Parsed {
  // Summaries are one line, but a name can be as long as its writer made it: read in bounded parts (SUMMARY_HEAD).
  const value = summary.trim();
  const head = value.slice(0, SUMMARY_HEAD);
  if (taskType === "tool_call" || /^The \S+ call (finished|ended without a result)\b/i.test(head)) {
    const tool = /^The (\S+) call/i.exec(head)?.[1] ?? null;
    const failed = /^The \S+ call ended without a result/i.test(head);
    return { kind: "repeat", subject: tool && shown(tool), tail: failed ? t("notice.endedNoResult") : t("notice.resultDelivered"), state: failed ? "failed" : null };
  }
  // `Monitor event: "<name>"`; words after the closing quote (a hand-written or newer summary) stay, after a colon.
  const event = /^Monitor event:\s*(?:["“]([^"”]*)["”]\s*([\s\S]*)|([\s\S]*))$/i.exec(head);
  if (event) return { kind: "event", subject: shown((event[1] ?? event[3] ?? "").trim()) || null, tail: shown((event[2] ?? "").trim()), state: "info" };
  const opening = QUOTED_START.exec(head);
  if (opening) {
    const kind = QUOTED_KIND[opening[1]!.toLowerCase()] ?? "other";
    const quoted = splitQuoted(kind, value, opening[0].length, hostEnd(hostStatus));
    // 0.6.0-local.4 (codex-vivid-F9): an empty or all-blank name has nothing to show; the row reads 「后台 Agent」 and
    // its ending. Without any split the name is what comes before the last closing quote, never the words after it.
    const name = quoted ? quoted.name : beforeLastQuote(head.slice(opening[0].length));
    const subject = name.trim() ? shown(name) : null;
    // 0.6.0-local.4 (codex-vivid-F8): no ending Claude Code writes was found, so the words after the quote may be the
    // name's own (`Agent "Why "job" failed …"`): they say nothing about how the task ended; the host's status does.
    if (!quoted?.known) return { kind, subject, tail: "", state: null };
    const tail = quoted.tail.trim();
    const own = kind === "command" ? commandTail(tail)
      : kind === "agent" ? agentTail(tail)
      : kind === "monitor" ? monitorTail(tail)
      : kind === "remote" ? remoteTail(tail)
      : kind === "task" ? taskTail(tail)
      : /could not be resumed/i.test(tail) ? { tail: t("notice.resumeFailed"), state: "failed" as const } : { tail: "", state: null };
    const words = own.tail ? own : genericTail(tail);
    return { kind, subject, tail: shown(words.tail), state: words.state };
  }
  if (/^Remote workflow completed:/i.test(head)) return { kind: "remote", subject: null, tail: t("notice.remoteCompleted", { name: shown(afterColon(head)) }), state: "done" };
  if (/^Remote task blocked on input:/i.test(head)) return { kind: "remote", subject: null, tail: t("notice.remoteBlocked", { reason: shown(afterColon(head)) }), state: "blocked" };
  if (/^Cloud review completed\b/i.test(head)) return { kind: "remote", subject: null, tail: t("notice.cloudCompleted"), state: "done" };
  if (/^Cloud review failed:/i.test(head)) return { kind: "remote", subject: null, tail: t("notice.cloudFailed", { reason: shown(afterColon(head)) }), state: "failed" };
  // Paseo's own fallbacks when Claude Code sent no summary.
  if (/^Background task notification$/i.test(value)) return { kind: "other", subject: null, tail: "", state: "info" };
  if (!value || TEMPLATE_START.test(head)) return { kind: "other", subject: null, tail: genericTail(head).tail, state: genericTail(head).state };
  // Anything else names a call of its own: the foreground repeat of older Claude Code versions (summary = description).
  return { kind: "repeat", subject: shown(value), tail: "", state: null };
}

/** The row status from the raw status Claude Code sent (killed/stopped → 已停止), else from the row's own. */
function statusFrom(raw: string | null, rowStatus: string | undefined): NoticeStatus {
  const value = (raw ?? rowStatus ?? "").toLowerCase();
  if (value === "failed" || value === "error") return "failed";
  if (value === "killed" || value === "stopped" || value === "canceled" || value === "cancelled") return "canceled";
  return "completed";
}

const STATUS_OF_STATE: Record<NoticeState, NoticeStatus | null> = { done: "completed", failed: "failed", blocked: "failed", stopped: "canceled", info: null };

/** Claude Code escapes only `&`, `<` and `>` in a notification (its `Wt`); `&amp;` goes last. */
function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * The notice's `<result>`, XML escapes undone. Claude Code's template puts it on lines of its own (`<result>\n…\n</result>`):
 * only those two line breaks go, so spaces that start the result stay for comparing it with the row. Null when absent or
 * blank.
 */
function resultOf(raw: string): string | null {
  const open = raw.indexOf("<result>");
  if (open < 0) return null;
  const start = open + "<result>".length;
  const close = raw.indexOf("</result>", start);
  let value = close < 0 ? raw.slice(start) : raw.slice(start, close);
  if (value.startsWith("\n")) value = value.slice(1);
  if (value.endsWith("\n")) value = value.slice(0, -1);
  return value.trim() ? unescapeXml(value) : null;
}

/** `<tag>…</tag>` of the raw notification text, trimmed; null when absent. */
export function noticeTag(raw: string, tag: string): string | null {
  const open = raw.indexOf(`<${tag}>`);
  if (open < 0) return null;
  const start = open + tag.length + 2;
  const close = raw.indexOf(`</${tag}>`, start);
  const value = (close < 0 ? raw.slice(start) : raw.slice(start, close)).trim();
  return value || null;
}

/** Reads Paseo's synthetic task-notification row; null for every other tool call. */
export function readTaskNotice(item: NoticeSource): TaskNotice | null {
  if (item.name !== TASK_NOTICE_TOOL) return null;
  const meta = record(item.metadata);
  if (meta.source !== undefined && meta.source !== "claude_task_notification") return null;
  const detail = record(item.detail);
  const raw = typeof detail.text === "string" ? detail.text : "";
  const summary = text(detail.label) ?? (raw ? noticeTag(raw, "summary") : null) ?? text(detail.text) ?? "";
  const hostStatus = text(meta.status);
  const parsed = parseNoticeSummary(summary, raw ? noticeTag(raw, "task-type") : null, hostStatus);
  const reported = statusFrom(hostStatus, item.status);
  const result = raw ? resultOf(raw) : null;
  // 0.6.0-local.2 (codex-vivid-F2): a failed, killed or stopped notice is that, whatever its summary's words say (an error
  // reason may quote 「finished」). Only a completed one takes its ending from the summary's template: an agent stopped at
  // its turn limit, a reminder or event (no state), a remote task waiting for input.
  const state: NoticeState = reported === "failed"
    ? parsed.state === "blocked" ? "blocked" : "failed"
    : reported === "canceled" ? "stopped" : parsed.state ?? "done";
  return {
    ref: text(meta.toolUseId),
    taskId: text(meta.taskId),
    status: reported === "completed" ? STATUS_OF_STATE[state] ?? reported : reported,
    summary,
    kind: parsed.kind,
    state,
    subject: parsed.subject,
    outputFile: text(meta.outputFile),
    carriesResult: result !== null,
    result,
    hostStatus,
  };
}

/**
 * A notice that only repeats its own (foreground) tool row; it folds into that row when the row is known.
 * 0.6.0-local.2: not when it brings a result of its own. Claude Code moves a foreground call that is still loading to the
 * background when you send a message: a non-interactive session such as Paseo's gets the 「Still running」 placeholder as
 * the call's result, and the real result arrives in this notice; folding it would lose the result.
 * 0.6.0-local.3 (codex-vivid boundary): unless the row already shows it. 0.6.0-local.4 (codex-vivid-F7): only when the
 * row's final result, `row` (`comparableResult` of `rowResultText`, read once per row), reads the same as the notice's.
 * 0.6.0-local.3 took any row whose text held the notice's somewhere, spaces squeezed: a placeholder holding the word
 * 「running」 hid a result `running`, `errors: 10` hid `errors: 1`. A placeholder, another result, one over the budget or
 * a row not known: the notice stands on its own.
 */
export function isForegroundNotice(notice: TaskNotice | null, row?: ComparableResult | null): notice is TaskNotice & { ref: string } {
  return notice !== null && notice.kind === "repeat" && notice.ref !== null && (notice.result === null || sameResult(row, notice.result));
}

/** Results are compared up to this many characters on either side; a longer one is never taken for the same. */
const MAX_COMPARED_CHARS = 200_000;
/** A result as `comparableResult` reads it. */
export interface ComparableResult {
  readonly text: string;
}
/**
 * A result as compared (0.6.0-local.4, codex-vivid-F7): terminal escape sequences dropped, CRLF read as LF, spaces at the
 * end of each line and blank lines at either end dropped. Spaces inside a line and the lines themselves stay: `a  b` and
 * `a b`, or `1` over `23` and `1 23`, are different results. Null when there is nothing to compare with: no result, one
 * longer than MAX_COMPARED_CHARS (two long ones are never taken for the same on a common start), or a placeholder.
 */
export function comparableResult(value: string | null | undefined): ComparableResult | null {
  if (!value || value.length > MAX_COMPARED_CHARS) return null;
  const lines = stripAnsi(value).replace(/\r\n/g, "\n").split("\n");
  let first = 0;
  let last = lines.length;
  while (first < last && !lines[first]!.trimEnd()) first++;
  while (last > first && !lines[last - 1]!.trimEnd()) last--;
  const kept: string[] = [];
  for (let index = first; index < last; index++) kept.push(lines[index]!.trimEnd());
  const text = kept.join("\n");
  return text && !pendingResult(text) ? { text } : null;
}
/**
 * A result that only says the real one is still to come: Claude Code's placeholder for a call it moved to the background
 * when you sent a message (2.1.294: `[Still running. The user sent a message while this call loads, … Its result will be
 * delivered to you on its own, …]`), or the note of a command it started in the background. Such a row never takes a
 * notice in, whatever words they share.
 */
function pendingResult(text: string): boolean {
  return text.startsWith("[Still running") || text.startsWith("Command running in background with ID: ") || text.includes("Its result will be delivered to you on its own");
}
/** The row shows the notice's result: both read the same (`comparableResult`). Unsure → false. */
export function sameResult(row: ComparableResult | null | undefined, noticeResult: string): boolean {
  // Reading only ever shortens a text, so a shorter notice result cannot read as the row's.
  if (!row || noticeResult.length < row.text.length) return false;
  return comparableResult(noticeResult)?.text === row.text;
}
/**
 * A finished tool row's result as text, for telling whether a notice repeats it: shell output, plain text, a read's
 * content, an error's message, or else the output as JSON; null when the row has none.
 */
export function rowResultText(item: { detail?: unknown; error?: unknown }): string | null {
  const detail = record(item.detail);
  for (const value of [detail.output, detail.text, detail.content, detail.result]) if (typeof value === "string" && value) return value;
  const error = record(item.error);
  if (typeof error.message === "string" && error.message) return error.message;
  if (detail.output === undefined || detail.output === null) return null;
  try {
    return JSON.stringify(detail.output);
  } catch {
    return null;
  }
}

const NOUNS: Record<NoticeKind, MessageId> = {
  command: "notice.backgroundCommand",
  agent: "notice.backgroundAgent",
  monitor: "notice.monitor",
  event: "notice.monitorEvent",
  remote: "notice.remoteTask",
  task: "notice.backgroundTask",
  workflow: "notice.backgroundWorkflow",
  repeat: "notice.foregroundCall",
  other: "notice.backgroundTask",
};

/** Row look of a notice: sub-agent magenta for agents and remote tasks, command orange for the rest. */
export function noticeLook(kind: NoticeKind): "agent" | "shell" {
  return kind === "agent" || kind === "remote" ? "agent" : "shell";
}

/** Row icon of a notice. */
export function noticeIcon(kind: NoticeKind): string {
  switch (kind) {
    case "agent":
      return "Bot";
    case "remote":
      return "Cloud";
    case "monitor":
    case "event":
      return "Activity";
    case "workflow":
      return "Workflow";
    default:
      return "SquareTerminal";
  }
}

/**
 * The row header: title 「后台 Agent」 and summary 「审查登录模块」已完成; a repeat whose own row is not on screen says so
 * by itself. Paseo's fallbacks ("Background task completed") get fixed words.
 */
export function noticeHeadline(
  notice: Pick<TaskNotice, "summary" | "status" | "kind" | "state" | "subject"> & Partial<Pick<TaskNotice, "hostStatus">>,
): { title: string; summary: string } {
  const title = t(NOUNS[notice.kind]);
  const parsed = parseNoticeSummary(notice.summary, null, hostStatusOf(notice));
  // The summary's own words, unless they say another ending than the notice's status (the host's status wins, see readTaskNotice).
  const implied = parsed.state === null ? "completed" : STATUS_OF_STATE[parsed.state];
  const tail = implied === null || implied === notice.status ? parsed.tail : "";
  const words = tail || (notice.state === "info" ? "" : t(STATE_WORDS[notice.status]));
  if (notice.kind === "repeat") {
    return notice.subject && /^The \S+ call/i.test(notice.summary)
      ? { title, summary: words ? t("notice.subjectState", { subject: notice.subject, words }) : t("notice.eventSubject", { subject: notice.subject }) }
      : { title, summary: notice.subject ?? words };
  }
  if (notice.kind === "event") return { title, summary: notice.subject ? words ? t("notice.eventSubjectWords", { subject: notice.subject, words }) : t("notice.eventSubject", { subject: notice.subject }) : words };
  if (notice.subject) return { title, summary: words ? t("notice.subjectState", { subject: notice.subject, words }) : t("notice.eventSubject", { subject: notice.subject }) };
  return { title, summary: words };
}

/** The status Claude Code sent, or for a notice built by hand the one its row status stands for. */
function hostStatusOf(notice: Pick<TaskNotice, "status"> & Partial<Pick<TaskNotice, "hostStatus">>): string | null {
  if (notice.hostStatus !== undefined) return notice.hostStatus;
  return notice.status === "canceled" ? "stopped" : notice.status;
}

/** 「后台 Agent」 and words without a name before them get a space between: 后台 Agent 到了 30 轮上限 (codex-vivid-F9). */
function joined(title: string, words: string): string {
  return /[A-Za-z0-9]$/.test(title) && words && !/^[\s「]/.test(words) ? t("notice.joinedSpaced", { title, words }) : t("notice.joined", { title, words });
}

/** The notice's one-line Chinese text: 后台命令「构建」已完成（退出码 0）. */
export function noticeTextZh(notice: Pick<TaskNotice, "summary" | "status"> & Partial<Pick<TaskNotice, "kind" | "state" | "subject" | "hostStatus">>): string {
  const parsed = parseNoticeSummary(notice.summary, null, hostStatusOf(notice));
  const kind = notice.kind ?? parsed.kind;
  const state = notice.state ?? parsed.state ?? stateOf(notice.status);
  // As in readTaskNotice: a completed row takes its ending from the summary's template, any other status stands.
  const status = notice.status === "completed" ? STATUS_OF_STATE[state] ?? "completed" : notice.status;
  const { title, summary } = noticeHeadline({ summary: notice.summary, status, kind, state, subject: notice.subject ?? parsed.subject, hostStatus: hostStatusOf(notice) });
  if (kind === "repeat" && !/^The \S+ call/i.test(notice.summary)) return summary || joined(title, t(STATE_WORDS[status]));
  if (!summary) return state === "info" && kind === "other" ? t("notice.backgroundNotification") : joined(title, t(STATE_WORDS[status]));
  return joined(title, summary);
}

/** What the raw `<task-notification>` adds for a person: the agent's result, its usage, a note, an event. */
export interface NoticeSections {
  result: string | null;
  note: string | null;
  event: string | null;
  usage: { tokens: number | null; toolUses: number | null; durationMs: number | null } | null;
}

const count = (raw: string, tag: string): number | null => {
  const value = Number(noticeTag(raw, tag));
  return Number.isFinite(value) && value >= 0 && noticeTag(raw, tag) !== null ? value : null;
};

/** Sections of the raw notification text (Paseo puts it in `detail.text`); all null for a plain summary. */
export function noticeSections(raw: string | null | undefined): NoticeSections {
  const value = raw ?? "";
  if (!value.includes("<task-notification>")) return { result: null, note: null, event: null, usage: null };
  const usage = noticeTag(value, "usage");
  const parsedUsage = usage
    ? { tokens: count(usage, "subagent_tokens") ?? count(usage, "total_tokens"), toolUses: count(usage, "tool_uses"), durationMs: count(usage, "duration_ms") }
    : null;
  return {
    result: noticeTag(value, "result"),
    note: noticeTag(value, "note"),
    event: noticeTag(value, "event"),
    usage: parsedUsage && (parsedUsage.tokens !== null || parsedUsage.toolUses !== null || parsedUsage.durationMs !== null) ? parsedUsage : null,
  };
}
