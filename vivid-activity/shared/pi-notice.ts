import { t, type MessageId } from "./text";
import { joinList } from "./i18n";
/**
 * 本地补丁（0.6.0，opus-B30，格式整理借鉴 springkill/paseo-pi-kit 的 Pi 消息对照表）：Pi 扩展发来的通知画成中文卡片。
 *
 * Paseo 0.11.1 的 Pi provider 把扩展用 `pi.sendMessage({ customType, content, display, details })` 发的 `role: "custom"`
 * 消息变成一条合成的工具行（`agent/providers/custom-message.js` 的 mapCustomMessageToToolCall；实时走 `pi/agent.js` 的
 * handleMessageEnd，回放走 `pi/history-mapper.js`，OMP 用的是同一个函数）：
 *
 *   { type: "tool_call", callId: "pi-custom-…", name: <customType>, status: "completed",
 *     detail: { type: "plain_text", text }, metadata: { synthetic: true, customType, details? }, error: null }
 *
 * - 只有 `display !== false` 且有正文的消息才会进时间线：pi-subagents 成功的后台完成、goal-contract 这类只给模型看的不会出现。
 * - `details` 是扩展给自己渲染器的结构化字段（Pi 不把它发给模型），Paseo 原样放进 metadata；正文是写给模型的 XML、
 *   英文模板和「不要轮询」之类的指令。以前这一行画成灰色的「其他」，展开就是这段原文。
 *
 * 这里按各扩展的源码（只读核对，版本见每一节）认出常见的几类：先用 details，没有、或形状不认识，再解析正文；取不到的字段
 * 留空，不让整张卡片失败。没见过的 customType 画成通用的「Pi 通知」（名字前缀认得出是哪个扩展的，沿用那一类的外观）。
 * 状态只认明确的词，认不出的一律是 info，绝不当成完成。写给父 Agent 的通知（子 Agent 的请求、控制与纠偏提醒、监督提醒）
 * 只说发生了什么，不写成要你去做的事。名字、路径、错误等数据保持原文（只还原 XML 转义）。
 * 纯函数，不依赖 react-native，不抛异常。
 */
import { formatDuration } from "./timing";

/** done 绿、failed 红、stopped 灰（停止、暂停、取消）、running 蓝、info 不带状态（提醒、事件、写给父 Agent 的话）。 */
export type PiNoticeState = "done" | "failed" | "stopped" | "running" | "info";
export type PiNoticeLook = "shell" | "agent" | "web" | "plan" | "other";
export interface PiNoticeField {
  readonly id?: string;
  label: string;
  value: string;
  mono?: boolean;
}
export interface PiNotice {
  customType: string;
  /** Row look (shared/vivid-model.ts LookKey): "shell" background task, "agent" sub-agent/supervisor, "web" web search/fetch, "plan" goals, "other" otherwise. */
  look: PiNoticeLook;
  /** Short Chinese row title: 后台任务 / 子 Agent / 子 Agent 请求 / 监督提醒 / 联网搜索 / 目标 / Pi 通知. */
  title: string;
  /** One-line Chinese header summary, e.g. 「构建」已完成（退出码 0）. Data (names, paths, errors) stays as sent. */
  summary: string;
  state: PiNoticeState;
  /** Expanded body fields with Chinese labels (任务、状态、退出码、错误、输出文件、会话…); labels are unique. */
  fields: PiNoticeField[];
  /** Optional long plain text for the body (result preview, error output, child outputs); not truncated here. */
  body?: string;
}

type PiNoticeSource = { name: string; status?: string; detail?: unknown; metadata?: unknown };
type Draft = Omit<PiNotice, "customType">;
type Rec = Record<string, unknown>;
interface Input {
  customType: string;
  text: string;
  details: unknown;
}

// ── 小工具 ──────────────────────────────────────────────────────────────

function rec(value: unknown): Rec | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
/** An integer from a number or a digit string; `null`, `"null"` and anything else are no number. */
function int(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  return typeof value === "string" && /^\s*-?\d+\s*$/.test(value) ? Number(value) : undefined;
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function records(value: unknown): Rec[] {
  return list(value).map(rec).filter((entry): entry is Rec => entry !== null);
}
/** Pi writes `unavailable` where it has no value. */
function real(value: string | undefined): string | undefined {
  return value && value !== "unavailable" ? value : undefined;
}
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function lines(text: string): string[] {
  return text.split(/\r?\n/);
}
/** What `.` in a regex does not match: a capture made of `.` holds none of these. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const LINE_ENDS = ["\n", "\r", "\u2028", "\u2029"];
const quoted = (name: string | undefined) => (name ? t("piNotice.quoted", { name }) : "");

/**
 * Undoes the extensions' XML escaping. Every producer escapes `&` first (pi-background-tasks `escapeXml()`: & < > only;
 * pi-subagents' watchdog adds `&quot;` in attributes; gotgenes also `&quot;` and `&apos;`), so `&amp;` goes last:
 * a name that really contains the five characters `&lt;` arrives as `&amp;lt;` and must come back as `&lt;`.
 */
export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const SPACE = /\s/;
/** With `at` just past a `<name`: the end of that opening tag (`<name>` or `<name attr…>`, just past its `>`), or -1. */
function openingEnd(text: string, at: number): number {
  if (text[at] === ">") return at + 1;
  if (!SPACE.test(text[at] ?? "")) return -1;
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === ">") return i + 1;
    if (text[i] === "<") return -1;
  }
  return -1;
}
/** Start and end of the first `</name>` (spaces allowed before `>`) at or after `from`. */
function closingTag(text: string, name: string, from: number): readonly [start: number, end: number] | null {
  const lead = `</${name}`;
  for (let at = text.indexOf(lead, from); at >= 0; at = text.indexOf(lead, at + 1)) {
    let i = at + lead.length;
    while (i < text.length && SPACE.test(text[i]!)) i++;
    if (text[i] === ">") return [at, i + 1];
  }
  return null;
}
/**
 * The inner text of `<name>…</name>` blocks (attributes allowed on the opening tag), in order and raw (still escaped): each
 * opening tag up to the first closing tag after it, what `<name(?:\s[^<>]*)?>([\s\S]*?)</name\s*>` matches.
 * 0.6.0-local.2 (codex-vivid-F1): a plain scan. The regex searched to the end of the text again from every unclosed opening
 * tag, so 256 KB of `<status>` took seconds; once an opening tag has no closing tag after it, no later one has either.
 */
export function tagBlocks(text: string, name: string, limit = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  const open = `<${name}`;
  let from = 0;
  while (out.length < limit) {
    let inner = -1;
    for (let at = text.indexOf(open, from); at >= 0; at = text.indexOf(open, at + 1)) {
      inner = openingEnd(text, at + open.length);
      if (inner >= 0) break;
    }
    const close = inner < 0 ? null : closingTag(text, name, inner);
    if (!close) break;
    out.push(text.slice(inner, close[0]));
    from = close[1];
  }
  return out;
}
/** `<name>value</name>` (attributes allowed), unescaped and trimmed; independent of line breaks. */
function tag(text: string, name: string): string | undefined {
  const value = tagBlocks(text, name, 1)[0]?.trim();
  return value ? unescapeXml(value) : undefined;
}
/** Every `<name>…</name>` block's inner text, raw (still escaped). */
function blocks(text: string, name: string): string[] {
  return tagBlocks(text, name);
}
/** `name="value"` on the first tag that carries it. */
function attr(text: string, name: string): string | undefined {
  const match = new RegExp(`\\s${escapeRe(name)}="([^"]*)"`).exec(text);
  const value = match?.[1]?.trim();
  return value ? unescapeXml(value) : undefined;
}
/** `Label: value` at a line start. */
function lineValue(text: string, label: string): string | undefined {
  const match = new RegExp(`^${escapeRe(label)}:[ \\t]*(.+)$`, "m").exec(text);
  return str(match?.[1]);
}

/** Drops leading and trailing blank lines and squeezes runs of blank lines to one. */
function tidy(rows: readonly string[]): string {
  const out: string[] = [];
  for (const row of rows) {
    const line = row.trimEnd();
    if (!line && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

const XML_TAG = /<(\/?)([A-Za-z][\w.:-]*)(?:\s[^<>]*)?\/?>/g;
/**
 * Plain text of an unknown notice: XML-ish tags that are closed somewhere in the text are removed (so `Array<string>` in
 * prose stays), their entities unescaped and their lines trimmed; any other text keeps its indentation.
 */
function plainText(text: string): string {
  const closed = new Set(Array.from(text.matchAll(/<\/([A-Za-z][\w.:-]*)\s*>/g), (match) => match[1]!.toLowerCase()));
  if (closed.size === 0) return tidy(lines(text));
  let stripped = false;
  const out = text.replace(XML_TAG, (whole: string, slash: string, name: string, at: number, all: string) => {
    if (!closed.has(name.toLowerCase())) return whole;
    stripped = true;
    // `</a><b>` on one line: keep the two values apart.
    return slash && all[at + whole.length] === "<" ? "\n" : "";
  });
  return stripped ? tidy(lines(unescapeXml(out)).map((line) => line.trim())) : tidy(lines(text));
}

/** The first line worth a header: markdown list, quote and heading marks and bold stripped; rules and fences skipped. */
function headline(text: string | undefined): string {
  for (const row of lines(text ?? "")) {
    const line = row
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+•]\s+)/, "")
      .replace(/\*\*|__/g, "")
      .trim();
    if (line && !/^[-=_*`~]{3,}/.test(line)) return line;
  }
  return "";
}

const SUMMARY_MAX = 200;
/**
 * Each run of spaces that holds a line break becomes one space. 0.6.0-local.2 (codex-vivid-F1): the pattern `\s*[\r\n]+\s*`
 * tried again from every space of a long run without a line break (200 000 spaces took seconds); `\s+` takes each run once.
 */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, (run) => (run.includes("\n") || run.includes("\r") ? " " : run)).trim();
}
function clip(value: string, max = SUMMARY_MAX): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
}
/** The body when it says more than the header line already does. */
function extra(body: string | undefined, header: string): string | undefined {
  const text = body?.trim();
  return text && text !== header.trim() ? text : undefined;
}

type FieldSpec = readonly [label: string, value: unknown, mono?: boolean, id?: string];
/** Non-empty fields in order; a repeated label gets a number so labels stay unique (UI keys use them). */
function fields(...specs: ReadonlyArray<FieldSpec | null | undefined | false>): PiNoticeField[] {
  const out: PiNoticeField[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (!spec) continue;
    const [label, raw, mono, id] = spec;
    const value = typeof raw === "number" ? (Number.isFinite(raw) ? String(raw) : "") : typeof raw === "string" ? raw.trim() : "";
    if (!value) continue;
    let unique = label;
    for (let n = 2; seen.has(unique); n++) unique = `${label} ${n}`;
    seen.add(unique);
    const field: PiNoticeField = mono ? { label: unique, value, mono: true } : { label: unique, value };
    // Presentation identity is metadata: preserve the parser’s enumerable output contract, and let the timeline
    // projection copy the id explicitly when it serializes the field for a renderer.
    if (id) Object.defineProperty(field, "id", { value: id });
    out.push(field);
  }
  return out;
}

function duration(ms: number | undefined): string | undefined {
  return ms !== undefined && ms > 0 ? (formatDuration(ms) ?? undefined) : undefined;
}

// ── 状态 ────────────────────────────────────────────────────────────────

// 0.6.0-local.5: every module-level value here is built without side effects (`@__PURE__`), so a bundle that takes only
// `isPiNotice` or `piNoticeStatus` (the resident timeline) leaves the parsers out; they ship in pi-chunk.client.tsx.
const STATUS: ReadonlyMap<string, { state: PiNoticeState; words: MessageId; sentence: MessageId }> = /* @__PURE__ */ statusTable();
function statusTable(): Map<string, { state: PiNoticeState; words: MessageId; sentence: MessageId }> {
  const table = new Map<string, { state: PiNoticeState; words: MessageId; sentence: MessageId }>();
  const define = (state: PiNoticeState, words: MessageId, sentence: MessageId, keys: readonly string[]) => {
    for (const key of keys) table.set(key, { state, words, sentence });
  };
  define("done", "piNotice.completed", "piNotice.completedSentence", ["completed", "complete", "success", "succeeded", "successful", "done", "finished"]);
  define("failed", "piNotice.failed", "piNotice.failedSentence", ["failed", "failure", "error", "errored"]);
  define("stopped", "piNotice.stopped", "piNotice.stoppedSentence", ["killed", "stopped", "aborted", "interrupted"]);
  define("stopped", "piNotice.canceled", "piNotice.canceledSentence", ["cancelled", "canceled"]);
  define("stopped", "piNotice.paused", "piNotice.pausedSentence", ["paused"]);
  define("stopped", "piNotice.timeout", "piNotice.timeoutSentence", ["timed out", "timed_out", "timeout"]);
  define("running", "piNotice.running", "piNotice.runningSentence", ["running", "in_progress", "in-progress", "in progress", "started"]);
  define("running", "piNotice.queued", "piNotice.queuedSentence", ["queued", "pending"]);
  return table;
}

function statusKey(status: unknown): string {
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}
/**
 * 0.6.0: how a notice ends its row (and counts in a fold summary): failed red, stopped gray; events, reminders and progress
 * reports are finished rows, never a spinner (the work they talk about goes on elsewhere).
 */
export function piNoticeStatus(state: PiNoticeState): "completed" | "failed" | "canceled" {
  return state === "failed" ? "failed" : state === "stopped" ? "canceled" : "completed";
}

/**
 * A status word → state: completed/success/succeeded/done → done; failed/error → failed; killed/stopped/cancelled/paused → stopped;
 * running/in_progress (and queued) → running. Anything else, or nothing, is info: an unknown status is never shown as done.
 */
export function piNoticeState(status: unknown): PiNoticeState {
  return STATUS.get(statusKey(status))?.state ?? "info";
}
/** Chinese words for a status (已完成、失败、已停止、已暂停、运行中…); an unknown one stays as sent. */
export function piStatusWords(status: unknown): string {
  const id = STATUS.get(statusKey(status))?.words;
  return id ? t(id) : (typeof status === "string" ? status.trim() : "");
}
/** 已完成（退出码 0）; an unknown status reads 状态：<raw>. */
function outcome(status: string | undefined, extraWords?: string, sentence = true): string {
  const known = STATUS.get(statusKey(status));
  const words = status === undefined ? "" : known ? t(sentence ? known.sentence : known.words) : t("piNotice.rawStatus", { status });
  if (!extraWords) return words;
  return words ? t("piNotice.outcomeDetail", { words, detail: extraWords }) : extraWords;
}
/** The state of several runs together: any failure is red, then any stop, then anything still running; all done is done. */
function overall(states: readonly PiNoticeState[]): PiNoticeState {
  if (states.length === 0) return "info";
  if (states.includes("failed")) return "failed";
  if (states.includes("stopped")) return "stopped";
  if (states.includes("running")) return "running";
  return states.every((state) => state === "done") ? "done" : "info";
}
/** 2 个已完成、1 个失败. */
function tally(words: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return joinList(Array.from(counts, ([word, count]) => t("piNotice.tallyCount", { count, word })));
}

// ── 后台任务：pi-background-tasks 的 background-task-notification ─────────────
// 2.6.x `src/core/registry.ts` notifyCompletion()：正文是 XML（task-id、task-name、status、exit-code、error、output-file、
// summary、guidance），名字、错误、路径过了 escapeXml（只转 & < >）。status 取自 TASK_STATUS_VALUES =
// running | completed | failed | killed（没有 stopped）；`<exit-code>` 被信号杀掉时是字面的 null，不能当成 0。
// details 是 snapshot(task)（BgTaskSnapshot）：id、name、command、status、exitCode（number | null）、signal、error、
// outputPath、startTime、endTime、isAgent、model…。summary 是名字加状态的复述，guidance 是给模型的「别轮询」，都不显示。

function backgroundTask({ text, details }: Input): Draft | null {
  const d = rec(details) ?? {};
  const xml = /<background-task-notification\b/.test(text) ? text : "";
  const name = str(d.name) ?? tag(xml, "task-name") ?? str(d.description);
  const status = str(d.status) ?? tag(xml, "status");
  const exit = d.exitCode !== undefined ? int(d.exitCode) : int(tag(xml, "exit-code"));
  const signal = exit === undefined ? str(d.signal) : undefined;
  const start = num(d.startTime);
  const end = num(d.endTime);
  const error = str(d.error) ?? tag(xml, "error");
  const outputFile = str(d.outputPath) ?? tag(xml, "output-file");
  const id = str(d.id) ?? tag(xml, "task-id");
  if (!name && !status && exit === undefined && !error && !outputFile && !id) return null;
  const result = outcome(status, exit !== undefined ? t("piNotice.exitCode", { code: exit }) : signal ? t("piNotice.signalCode", { signal }) : undefined);
  return {
    look: "shell",
    title: t("piNotice.backgroundTask"),
    summary: name ? t("piNotice.namedOutcome", { name: quoted(name), outcome: result }) : result || t("piNotice.backgroundNotice"),
    state: piNoticeState(status),
    fields: fields(
      [t("piNotice.task"), name],
      [t("piNotice.status"), status ? piStatusWords(status) : undefined, false, "status"],
      [t("piNotice.exitCodeLabel"), exit],
      [t("piNotice.signal"), signal, true],
      [t("piNotice.error"), error],
      [t("piNotice.command"), str(d.command), true],
      [t("piNotice.type"), d.isAgent === true ? t("piNotice.backgroundAgent") : undefined],
      [t("piNotice.model"), str(d.model), true],
      [t("piNotice.outputFile"), outputFile, true],
      [t("piNotice.duration"), start !== undefined && end !== undefined ? duration(end - start) : undefined],
      [t("piNotice.taskId"), id, true],
    ),
  };
}

// ── 子 Agent 完成：pi-subagents 的 subagent-notify ──────────────────────────
// 0.77 `src/runs/background/notify.js` formatSingleCompletion() / formatGroupedCompletion()（Pi 自带的逆函数
// parseSubagentNotifyContent() 是切分依据）：
//   {Background task|Detached foreground task} {completed|failed|paused|stopped}: **{agent}**{taskInfo}
//   [Workflow receipt: …] / 空行 / [Scheduled run from **名称** (schedule id).] / 结果预览（失败时先有 `Error: …` 行，
//   单个结果以 `{agent}:` 开头，长输出带 `Output saved to: … Read this file if needed.`），[Child outputs: 区块]，
//   [Watchdog blockers:]，再是 Parallel handoff、Retention-managed async directory、Workflow run、Child runs、
//   Reconciled detached child、Session / Session file / Session share error 这些元信息行；需要父 Agent 动手时末尾还有一段
//   `Parent action: …`（给模型的指令，不显示）。
// 合批的头是 `Background tasks completed (n): **a**, **b**`，下面每节以 `1. a…` 起头；只有成功的才合批（失败、暂停、停止
// 绕开合批立即发），所以头里的 completed 是真的。0.77 起 details = { runs: [...] }（每个 run 有 agent、status、source、
// taskInfo、scheduleOrigin、durationMs、runId、childRuns、childOutputs（不带预览）、sessionLabel/sessionValue…），
// 更早的版本 details 是 null。成功的后台完成 display 为 false，Paseo 不画；会出现的是失败、暂停、停止、前台转后台和定时任务。

const RUN_HEADER_START = /^(Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*/;
const GROUP_HEADER = /^Background tasks completed \((\d+)\):(.*)$/;
const RUN_META = /^(Session|Session file|Session share error|Retention-managed async directory|Workflow run|Child runs|Reconciled detached child|Parallel handoff): (.*)$/;
const SAVED_OUTPUT = /^(?:Output saved to: (.+) \([^()\n]*\)\. Read this file if needed\.|Full output: (.+) \([^()\n]*\)\. Read it if needed\.)$/;
const ERROR_LINE = /^Error(?: \(([^)]*)\))?: (.+)$/;
const SESSION_ZH: Readonly<Record<string, MessageId>> = { session: "piNotice.session", "session file": "piNotice.sessionFile", "session share error": "piNotice.sessionShareFailed" };
const BLOCKER_ZH: Readonly<Record<string, MessageId>> = { addressed: "piNotice.addressed", unaddressed: "piNotice.unaddressed", stalemate: "piNotice.stalemate" };

// 0.6.0-local.2（codex-vivid-F1）：下面几段原来是正则，懒惰的名字遇到行里的换行符（`.` 不匹配它）会越过后面每个 `**`、
// ` (schedule ` 重试到行尾，平方级。现在按下标找，结果与原正则相同（shared/backtracking.test.ts 用随机输入对照）。
/** `Background task failed: **name**rest` → [kind, status, name, rest], what `^(…) (…): \*\*(.+?)\*\*(.*)$` read. */
export function runHeader(line: string): [kind: string, status: string, agent: string, rest: string] | null {
  const start = RUN_HEADER_START.exec(line);
  const rest = start ? line.slice(start[0].length) : "";
  const close = start && !LINE_BREAK.test(rest) ? rest.indexOf("**", 1) : -1;
  return start && close >= 0 ? [start[1]!, start[2]!, rest.slice(0, close), rest.slice(close + 2)] : null;
}
const SCHEDULE_START = "Scheduled run from **";
const SCHEDULE_MID = "** (schedule ";
/** `Scheduled run from **name** (schedule id).` → [name, id], what `^Scheduled run from \*\*(.+?)\*\* \(schedule (.+?)\)\.$` read. */
export function scheduleLine(line: string): [name: string, id: string] | null {
  if (!line.startsWith(SCHEDULE_START) || !line.endsWith(").") || line.length < SCHEDULE_START.length + 2) return null;
  const rest = line.slice(SCHEDULE_START.length, -2);
  const at = LINE_BREAK.test(rest) ? -1 : rest.indexOf(SCHEDULE_MID, 1);
  return at >= 0 && at + SCHEDULE_MID.length < rest.length ? [rest.slice(0, at), rest.slice(at + SCHEDULE_MID.length)] : null;
}
const SCHEDULED_RUN = " — scheduled run from ";
const SCHEDULED_ID = " (schedule ";
/** `label — scheduled run from name (schedule id)` → where the suffix starts, name and id: `/ — scheduled run from (.+?) \(schedule (.+?)\)$/`. */
export function scheduledRun(header: string): { index: number; name: string; id: string } | null {
  const lastBreak = Math.max(...LINE_ENDS.map((mark) => header.lastIndexOf(mark)));
  const index = header.endsWith(")") ? header.indexOf(SCHEDULED_RUN, lastBreak + 1) : -1;
  const rest = index >= 0 ? header.slice(index + SCHEDULED_RUN.length, -1) : "";
  const at = index >= 0 ? rest.indexOf(SCHEDULED_ID, 1) : -1;
  return at >= 0 && at + SCHEDULED_ID.length < rest.length ? { index, name: rest.slice(0, at), id: rest.slice(at + SCHEDULED_ID.length) } : null;
}
const BLOCKER_STATES = ["addressed", "unaddressed", "stalemate"] as const;
/** `- what: detail (state)` → [what, detail, state]: `/^- (.+?): (.+) \((addressed|unaddressed|stalemate)\)$/`. */
export function blockerParts(line: string): [what: string, detail: string, state: string] | null {
  const state = line.startsWith("- ") && !LINE_BREAK.test(line) ? BLOCKER_STATES.find((word) => line.endsWith(` (${word})`)) : undefined;
  const middle = state ? line.slice(2, line.length - state.length - 3) : "";
  const at = state ? middle.indexOf(": ", 1) : -1;
  return state && at >= 0 && at + 2 < middle.length ? [middle.slice(0, at), middle.slice(at + 2), state] : null;
}
const PARENT_ACTION = "\n\nParent action: ";
/** The text without a closing `Parent action: …` line (blank space after it allowed): `text.replace(/\n\nParent action: [^\n]*\s*$/, "")`. */
export function withoutParentAction(text: string): string {
  const at = text.lastIndexOf(PARENT_ACTION);
  return at >= 0 && !text.slice(at + PARENT_ACTION.length).trimEnd().includes("\n") ? text.slice(0, at) : text;
}
const SUBAGENT_OPEN = 'Subagent "';
/** The name in `Subagent "name"<ending>`, up to the last `"<ending>`: `/Subagent "([\s\S]*)"<ending>/`. */
export function quotedSubagent(summary: string, ending: string): string | undefined {
  const start = summary.indexOf(SUBAGENT_OPEN);
  const end = start >= 0 ? summary.lastIndexOf(`"${ending}`) : -1;
  return end >= start + SUBAGENT_OPEN.length ? summary.slice(start + SUBAGENT_OPEN.length, end) : undefined;
}
/** The ids in `… request IDs: a, b.`: `/request IDs: ([^\n]+?)\.(?:\s|$)/i`, each line scanned once. */
export function requestIdList(text: string): string | undefined {
  const label = /request IDs: /gi;
  for (let match = label.exec(text); match; match = label.exec(text)) {
    const start = label.lastIndex;
    let at = start + 1;
    for (; at < text.length && text[at - 1] !== "\n"; at++) {
      if (text[at] === "." && (at + 1 === text.length || /\s/.test(text[at + 1]!))) return text.slice(start, at);
    }
    label.lastIndex = at;
  }
  return undefined;
}

interface Run {
  agent?: string;
  status?: string;
  foreground?: boolean;
  taskInfo?: string;
  schedule?: string;
  receipt?: string;
  handoff?: string;
  workflowRunId?: string;
  runId?: string;
  childRuns?: string;
  reconciled?: string;
  session?: { label: string; value: string };
  durationMs?: number;
  errors?: string[];
  outputFile?: string;
  body?: string;
  hasChildOutputs?: boolean;
}

/** Later sources win, but only with values they actually have. */
function merged<T extends object>(...parts: ReadonlyArray<Partial<T> | undefined>): Partial<T> {
  const out: Partial<T> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part ?? {})) {
      if (value !== undefined && !(Array.isArray(value) && value.length === 0)) (out as Rec)[key] = value;
    }
  }
  return out;
}

function scheduleText(name: string | undefined, id: string | undefined): string | undefined {
  if (!id) return name;
  return name && name !== id ? t("piNotice.scheduleName", { name, id }) : id;
}

/**
 * `name (status)` → [name, status]; [name, undefined] without a status; null when the name would hold a line break. What
 * `/^(.*?)(?: \(([^)]*)\))?$/` read: the status is inside a final ` (…)` holding no other `)`, the name everything before
 * the first such ` (`. 0.6.0-local.2 (codex-vivid-F1): found by index; the regex rescanned to the end from every ` (`.
 */
export function nameAndStatus(value: string): [name: string, status: string | undefined] | null {
  const lineBreak = value.search(LINE_BREAK);
  if (value.endsWith(")")) {
    const inner = value.length >= 2 ? value.lastIndexOf(")", value.length - 2) : -1;
    const at = value.indexOf(" (", Math.max(0, inner - 1));
    if (at >= 0 && at <= value.length - 3 && (lineBreak < 0 || at <= lineBreak)) return [value.slice(0, at), value.slice(at + 2, -1)];
  }
  return lineBreak < 0 ? [value, undefined] : null;
}

/** `review=run-1 (completed), tests=run-2 (failed)` → one line per child: review · run-1 · 已完成. */
function childRunsText(value: string): string | undefined {
  const rows = value.split(/,\s+/).map((part) => {
    const match = nameAndStatus(part.trim());
    const raw = match?.[0] ?? part.trim();
    const at = raw.indexOf("=");
    const key = at >= 0 ? raw.slice(0, at) : undefined;
    const run = real(at >= 0 ? raw.slice(at + 1) : raw);
    return [key, run, match?.[1] ? piStatusWords(match[1]) : undefined].filter(Boolean).join(t("piNotice.factSeparator"));
  });
  return str(rows.filter(Boolean).join("\n"));
}
function childRunsFromDetails(value: unknown): string | undefined {
  const rows = records(value).map((child) =>
    [str(child.workflowKey) ?? str(child.agent), real(str(child.runId)), str(child.status) ? piStatusWords(child.status) : undefined].filter(Boolean).join(t("piNotice.factSeparator")),
  );
  return str(rows.filter(Boolean).join("\n"));
}

/** One line of a `Child outputs:` block in Chinese; null drops it. */
function childOutputLine(line: string): string | null {
  const head = /^- key=(\S*) run=(\S*) status=(\S*)$/.exec(line);
  if (head) {
    const status = real(head[3]);
    return `• ${[real(head[1]) ?? t("piNotice.childTask"), status ? piStatusWords(status) : undefined, real(head[2]) ? t("piNotice.runReference", { id: head[2] }) : undefined].filter(Boolean).join(t("piNotice.factSeparator"))}`;
  }
  const omitted = /^- (\d+) additional child preview\(s\) omitted by notice budget/.exec(line);
  if (omitted) return t("piNotice.omittedPreviews", { count: omitted[1] });
  const preview = /^ {4}\| ?(.*)$/.exec(line);
  if (preview) return `  ${preview[1]}`;
  if (line === "  Preview:") return null;
  const unavailable = /^ {2}Preview: unavailable \((.+)\)$/.exec(line);
  if (unavailable) return t("piNotice.unavailablePreview", { reason: unavailable[1] });
  const saved = /^ {2}Saved output: (.+)$/.exec(line);
  if (saved) return real(saved[1]) ? t("piNotice.savedOutput", { path: saved[1] }) : null;
  const artifact = /^ {2}Output artifact \(retention-managed\): (.+)$/.exec(line);
  if (artifact) return t("piNotice.outputArtifact", { path: artifact[1] });
  const structured = /^ {2}Structured output \(retention-managed\): (.+)$/.exec(line);
  if (structured) return t("piNotice.structuredOutput", { path: structured[1] });
  const failed = /^ {2}(Output artifact|Structured output) verification failed: (.+)$/.exec(line);
  if (failed) return t(failed[1] === "Output artifact" ? "piNotice.outputVerificationFailed" : "piNotice.structuredVerificationFailed", { error: failed[2] });
  const error = /^ {2}Error: (.+)$/.exec(line);
  if (error) return t("piNotice.indentedError", { error: error[1] });
  if (line === "  Full output unavailable") return t("piNotice.fullOutputUnavailable");
  return line;
}

/** The result preview in Chinese wrapping: the child outputs and watchdog sections translated, the rest as sent. */
function previewText(rows: readonly string[]): string {
  const out: string[] = [];
  let section: "text" | "children" | "blockers" | "concerns" = "text";
  for (const line of rows) {
    if (line === "Child outputs:") {
      section = "children";
      out.push(t("piNotice.childOutputs"));
      continue;
    }
    if (line === "Watchdog blockers:") {
      section = "blockers";
      out.push(t("piNotice.watchdogBlockers"));
      continue;
    }
    if (line === "High-importance watchdog concerns:") {
      section = "concerns";
      out.push(t("piNotice.watchdogConcerns"));
      continue;
    }
    if (section === "children") {
      const converted = childOutputLine(line);
      if (converted !== null) out.push(converted);
      continue;
    }
    if (section === "blockers") {
      const blocker = blockerParts(line);
      if (blocker) {
        out.push(t("piNotice.blockerDetails", { name: blocker[0], detail: blocker[1], status: t(BLOCKER_ZH[blocker[2]]!) }));
        continue;
      }
      section = "text";
    }
    if (section === "concerns") {
      out.push(line.replace(/^Evidence: /, t("piNotice.evidencePrefix")).replace(/^Recommended action: /, t("piNotice.recommendationPrefix")));
      continue;
    }
    out.push(line);
  }
  const text = tidy(out);
  return text === "(no output)" ? "" : text;
}

/**
 * One run's lines after its header (single notice: everything after line 1; grouped: one numbered section). Leading
 * `Error: …` lines are the run's errors only when it did not complete; a completed run's output may start that way.
 */
function runFromLines(source: readonly string[], agent: string | undefined, status: string | undefined): Run {
  // 0.6.0-local.3 (codex-vivid-F4): the rows still to read are source[start..end), moved by index. `rows.shift()` moved every
  // later row each time, so a notice of 64 000 blank lines (64 KB) took more than five seconds.
  let start = 0;
  let end = source.length;
  const run: Run = {};
  const skipBlank = () => {
    while (start < end && !source[start]!.trim()) start++;
  };
  if (start < end && source[start]!.startsWith("Workflow receipt: ")) run.receipt = str(source[start++]!.slice("Workflow receipt: ".length));
  skipBlank();
  const schedule = scheduleLine(start < end ? source[start]! : "");
  if (schedule) {
    run.schedule = scheduleText(schedule[0], schedule[1]);
    start++;
  }
  // Metadata lines close the run; the session line is the last one, so a `Session file:` inside the output stays output.
  while (end > start) {
    const last = source[end - 1]!;
    if (!last.trim()) {
      end--;
      continue;
    }
    const meta = RUN_META.exec(last);
    if (!meta) break;
    const value = str(meta[2]);
    const label = meta[1]!;
    if (label === "Parallel handoff") run.handoff ??= value;
    else if (label === "Workflow run") run.workflowRunId ??= value;
    else if (label === "Child runs") run.childRuns ??= value ? childRunsText(value) : undefined;
    else if (label === "Reconciled detached child") run.reconciled ??= value;
    else if (label !== "Retention-managed async directory" && value) run.session ??= { label: label.toLowerCase(), value };
    end--;
  }
  skipBlank();
  const errors: string[] = [];
  const failed = piNoticeState(status) !== "done";
  while (failed && start < end) {
    const error = ERROR_LINE.exec(source[start]!);
    if (!error) break;
    errors.push(error[1] ? t("piNotice.errorDetail", { kind: error[1], error: error[2] }) : error[2]!);
    start++;
  }
  if (errors.length) run.errors = errors;
  skipBlank();
  if (agent && start < end && source[start]!.trim() === `${agent}:`) start++;
  const kept: string[] = [];
  for (let index = start; index < end; index++) {
    const row = source[index]!;
    const saved = SAVED_OUTPUT.exec(row.trim());
    if (saved) run.outputFile ??= str(saved[1] ?? saved[2]);
    else kept.push(row);
  }
  run.body = previewText(kept);
  run.hasChildOutputs = kept.includes("Child outputs:");
  return run;
}

function runFromDetails(details: Rec): Run {
  const origin = rec(details.scheduleOrigin);
  const sessionValue = str(details.sessionValue);
  return {
    agent: str(details.agent),
    status: str(details.status),
    foreground: details.source === "foreground" ? true : undefined,
    taskInfo: str(details.taskInfo),
    schedule: origin ? scheduleText(str(origin.name), str(origin.id)) : undefined,
    receipt: str(details.workflowReceiptPath),
    handoff: str(details.handoffPath),
    workflowRunId: str(details.workflowRunId),
    runId: str(details.runId),
    childRuns: childRunsFromDetails(details.childRuns),
    reconciled: str(details.reconciledFromDetachedChild),
    session: sessionValue ? { label: (str(details.sessionLabel) ?? "session file").toLowerCase(), value: sessionValue } : undefined,
    durationMs: num(details.durationMs),
  };
}

/** `(2/3)` → 2/3; `(dispatch complete; 2 children running or uncollected)` → 已派发完，2 个子任务仍在运行或未收取. */
function taskInfoZh(raw: string | undefined): { text: string; dispatching: boolean } | undefined {
  const info = raw?.trim();
  if (!info) return undefined;
  const inner = /^\((.*)\)$/.exec(info)?.[1]?.trim() ?? info;
  const running = /^(dispatch complete; )?(\d+) (?:child|children) running or uncollected$/.exec(inner);
  if (running) return { text: t(running[1] ? "piNotice.dispatchedChildren" : "piNotice.runningChildren", { count: running[2] }), dispatching: true };
  return { text: inner, dispatching: false };
}

function namedOutcome(name: string | undefined, words: string): string {
  return name ? t("piNotice.namedOutcome", { name: quoted(name), outcome: words }) : words;
}
function runOutcome(name: string | undefined, info: string | undefined, words: string): string {
  return info ? t("piNotice.withInfo", { name: quoted(name), info, outcome: words }) : namedOutcome(name, words);
}

function runSummary(run: Run): { summary: string; state: PiNoticeState } {
  const info = taskInfoZh(run.taskInfo);
  // A workflow whose dispatch finished while children still run is not done yet: say so, without a green check.
  if (info?.dispatching && piNoticeState(run.status) === "done") return { summary: namedOutcome(run.agent, info.text), state: "info" };
  return { summary: runOutcome(run.agent, info?.text, outcome(run.status)), state: piNoticeState(run.status) };
}

function runFields(run: Run): PiNoticeField[] {
  const session = run.session;
  return fields(
    [t("piNotice.status"), run.status ? piStatusWords(run.status) : undefined, false, "status"],
    [t("piNotice.error"), run.errors?.join("\n")],
    [t("piNotice.source"), run.foreground ? t("piNotice.detached") : undefined],
    [t("piNotice.schedule"), run.schedule],
    [t("piNotice.duration"), duration(run.durationMs)],
    [t("piNotice.outputFile"), run.outputFile, true],
    // The child outputs in the body already name every child run.
    [t("piNotice.childRun"), run.hasChildOutputs ? undefined : run.childRuns],
    [t("piNotice.workflow"), run.workflowRunId, true],
    [t("piNotice.workflowReceipt"), run.receipt, true],
    [t("piNotice.parallelHandoff"), run.handoff, true],
    [t("piNotice.reconciledRun"), run.reconciled, true],
    session ? [SESSION_ZH[session.label] ? t(SESSION_ZH[session.label]!) : t("piNotice.session"), session.value, session.label !== "session share error"] : null,
    [t("piNotice.runId"), run.runId !== run.workflowRunId ? run.runId : undefined, true],
  );
}

function subagentNotify({ text, details }: Input): Draft | null {
  const runs = records(rec(details)?.runs).filter((run) => str(run.agent) || str(run.status));
  const rows = lines(withoutParentAction(text));
  const single = runHeader(rows[0] ?? "");
  const group = GROUP_HEADER.exec(rows[0] ?? "");
  if (group || runs.length > 1) return groupedRuns(rows, group, runs);
  if (!single && runs.length === 0) return null;
  const head: Run = single
    ? { agent: str(single[2]), status: single[1], foreground: single[0] === "Detached foreground task" ? true : undefined, taskInfo: str(single[3]) }
    : {};
  const fromDetails = runs[0] ? runFromDetails(runs[0]) : {};
  const agent = fromDetails.agent ?? head.agent;
  const run = merged<Run>(head, single ? runFromLines(rows.slice(1), agent, fromDetails.status ?? head.status) : {}, fromDetails) as Run;
  const { summary, state } = runSummary(run);
  return { look: "agent", title: t("piNotice.subagent"), summary: summary || t("piNotice.subagentNotice"), state, fields: runFields(run), ...(run.body ? { body: run.body } : {}) };
}

/** A grouped completion: the numbered sections, matched to the agents the header (or details) lists, in order. */
function groupedRuns(rows: readonly string[], group: RegExpExecArray | null, runs: readonly Rec[]): Draft {
  const headerAgents = Array.from((group?.[2] ?? "").matchAll(/\*\*(.+?)\*\*/g), (match) => match[1]!);
  const agents = runs.length ? runs.map((run) => str(run.agent)) : headerAgents;
  const count = Math.max(int(group?.[1]) ?? 0, runs.length, headerAgents.length);
  const starts: number[] = [];
  for (let index = 1, k = 1; index < rows.length && k <= count; index++) {
    const prefix = `${k}. `;
    const line = rows[index]!;
    const agent = agents[k - 1];
    if (line.startsWith(prefix) && (!agent || line.startsWith(`${prefix}${agent}`)) && !rows[index - 1]!.trim()) {
      starts.push(index);
      k++;
    }
  }
  const sections: Run[] = [];
  for (let k = 0; k < Math.max(starts.length, runs.length); k++) {
    const start = starts[k];
    const fromDetails = runs[k] ? runFromDetails(runs[k]!) : {};
    let fromText: Run = {};
    if (start !== undefined) {
      const header = rows[start]!.slice(`${k + 1}. `.length);
      const agent = fromDetails.agent ?? agents[k];
      const scheduled = scheduledRun(header);
      const label = scheduled ? header.slice(0, scheduled.index) : header;
      const taskInfo = agent && label.startsWith(agent) ? str(label.slice(agent.length)) : undefined;
      const end = starts[k + 1] ?? rows.length;
      fromText = merged<Run>(
        { agent: agent ?? str(label), status: "completed", taskInfo, schedule: scheduled ? scheduleText(scheduled.name, scheduled.id) : undefined },
        runFromLines(rows.slice(start + 1, end), agent, fromDetails.status ?? "completed"),
      ) as Run;
    }
    sections.push(merged<Run>(fromText, fromDetails) as Run);
  }
  // Pi only batches successful runs, so a header without sections or details still means every run completed.
  const states = sections.length ? sections.map((run) => piNoticeState(run.status)) : group ? ["done" as const] : [];
  const words = sections.map((run) => piStatusWords(run.status));
  const n = Math.max(count, sections.length);
  const state = overall(states);
  const allDone = states.length > 0 && states.every((each) => each === "done");
  const summary = allDone
    ? headerAgents.length && headerAgents.length <= 3 ? t("piNotice.groupCompletedNamed", { count: n, names: headerAgents.map(quoted).reduce((names, name) => names ? t("piNotice.nameList", { names, name }) : name, "") }) : t("piNotice.groupCompleted", { count: n })
    : t("piNotice.groupEnded", { count: n, outcomes: tally(words) });
  const body = sections
    .map((run) => {
      const info = taskInfoZh(run.taskInfo);
      // Not `1. scout`: previews are often numbered lists themselves.
      const head = runOutcome(run.agent ?? t("piNotice.subagent"), info?.text, outcome(run.status) || t("piNotice.unknownStatus"));
      const session = run.session;
      return tidy([
        head,
        ...(run.errors ?? []).map((error) => t("piNotice.errorText", { error })),
        run.schedule ? t("piNotice.scheduleText", { schedule: run.schedule }) : "",
        run.body ?? "",
        run.outputFile ? t("piNotice.outputFileText", { path: run.outputFile }) : "",
        session ? t("piNotice.fieldValue", { label: SESSION_ZH[session.label] ? t(SESSION_ZH[session.label]!) : t("piNotice.session"), value: session.value }) : "",
      ].filter((row, at) => at === 0 || row !== ""));
    })
    .join("\n\n");
  return {
    look: "agent",
    title: t("piNotice.subagent"),
    summary,
    state,
    fields: fields([t("piNotice.eachSubagent"), sections.map((run) => t("piNotice.fieldValue", { label: run.agent ?? t("piNotice.subagent"), value: outcome(run.status) || t("piNotice.unknownStatus") })).join("\n")]),
    ...(body ? { body } : {}),
  };
}

// ── 子 Agent 完成：@tintinweb/pi-subagents、@gotgenes/pi-subagents 的 subagent-notification ─────────
// tintinweb 0.21 `src/index.ts` 与 gotgenes 23.x `src/observation/notification.ts`：正文是仿 Claude Code 的
// `<task-notification>`（task-id、tool-use-id、output-file、status、summary、result、usage），后面跟
// `Full transcript available at: …` 和取结果的提示。details（NotificationDetails）：id、description、status
// （queued | running | completed | steered | aborted | stopped | error）、toolUses、turnCount、maxTurns、totalTokens、
// durationMs、outputFile、error、resultPreview；tintinweb 合批时其余的在 `others` 里，正文头是
// `Background agent group completed: 3 agent(s) finished[ (partial — others still running)]`。工作流完成也走这一类
// （description 是 `Workflow 名称`）。steered = 到了轮数上限、被引导收尾后完成；aborted = 超出轮数上限被中止。

interface AgentRun {
  id?: string;
  description?: string;
  status?: string;
  neverStarted?: boolean;
  error?: string;
  toolUses?: number;
  totalTokens?: number;
  turnCount?: number;
  maxTurns?: number;
  durationMs?: number;
  outputFile?: string;
  result?: string;
}

const NO_RESULT = /* @__PURE__ */ new Set(["No output.", "Never started — stopped while queued."]);

function agentRunFromDetails(details: Rec): AgentRun {
  return {
    id: str(details.id),
    description: str(details.description),
    status: str(details.status),
    neverStarted: str(details.resultPreview) === "Never started — stopped while queued." || undefined,
    error: str(details.error),
    toolUses: num(details.toolUses),
    totalTokens: num(details.totalTokens),
    turnCount: num(details.turnCount),
    maxTurns: num(details.maxTurns),
    durationMs: num(details.durationMs),
    outputFile: str(details.outputFile),
    result: str(details.resultPreview),
  };
}

function agentRunFromXml(block: string): AgentRun {
  const summary = tag(block, "summary") ?? "";
  const statusLabel = tag(block, "status");
  const usage = blocks(block, "usage")[0] ?? "";
  const named = /^(?:Agent|Subagent|Workflow) "([\s\S]*)" (\S+)/.exec(summary);
  const neverStarted = /\bwas stopped while queued\b/.test(summary) || statusLabel === "Stopped before starting";
  return {
    id: tag(block, "task-id"),
    description: named?.[1],
    status: neverStarted ? "stopped" : named?.[2],
    neverStarted: neverStarted || undefined,
    error: statusLabel?.startsWith("Error: ") ? str(statusLabel.slice("Error: ".length)) : undefined,
    toolUses: int(tag(usage, "tool_uses")),
    totalTokens: int(tag(usage, "total_tokens")),
    durationMs: int(tag(usage, "duration_ms")),
    outputFile: tag(block, "output-file"),
    result: tag(block, "result"),
  };
}

function agentRunOutcome(run: AgentRun, sentence = true): { state: PiNoticeState; words: string } {
  if (run.neverStarted) return { state: "stopped", words: t(sentence ? "piNotice.neverStartedSentence" : "piNotice.neverStarted") };
  const key = statusKey(run.status);
  if (key === "steered") return { state: "done", words: t(sentence ? "piNotice.steeredSentence" : "piNotice.steered") };
  if (key === "aborted") return { state: "stopped", words: t(sentence ? "piNotice.turnLimitStoppedSentence" : "piNotice.turnLimitStopped") };
  return { state: piNoticeState(run.status), words: outcome(run.status, undefined, sentence) };
}

function agentRunFields(run: AgentRun, words: string): PiNoticeField[] {
  return fields(
    [t("piNotice.status"), words, false, "status"],
    [t("piNotice.error"), run.error],
    [t("piNotice.toolCalls"), run.toolUses],
    [t("piNotice.tokens"), run.totalTokens],
    [t("piNotice.turnsLabel"), run.turnCount ? (run.maxTurns ? `${run.turnCount}/${run.maxTurns}` : run.turnCount) : undefined],
    [t("piNotice.duration"), duration(run.durationMs)],
    [t("piNotice.outputFile"), run.outputFile, true],
    [t("piNotice.agentId"), run.id, true],
  );
}

function subagentNotification({ text, details }: Input): Draft | null {
  const d = rec(details);
  const xmlRuns = blocks(text, "task-notification").map(agentRunFromXml);
  let runs: AgentRun[];
  if (d && (str(d.id) || str(d.description) || str(d.status))) {
    runs = [d, ...records(d.others)].map((entry, index) => {
      const own = agentRunFromDetails(entry);
      const xml = xmlRuns.find((run) => own.id !== undefined && run.id === own.id) ?? xmlRuns[index];
      return merged<AgentRun>(xml, own) as AgentRun;
    });
  } else runs = xmlRuns;
  if (runs.length === 0) return null;
  const footerFile = /^Full transcript available at: (.+)$/m.exec(text)?.[1]?.trim();
  if (runs.length === 1) {
    const run = merged<AgentRun>({ outputFile: footerFile }, runs[0]) as AgentRun;
    const { state, words } = agentRunOutcome(run);
    const result = run.result && !NO_RESULT.has(run.result) ? run.result : undefined;
    return {
      look: "agent",
      title: t("piNotice.subagent"),
      summary: namedOutcome(run.description, words) || t("piNotice.subagentNotice"),
      state,
      fields: agentRunFields(run, agentRunOutcome(run, false).words),
      ...(result ? { body: result } : {}),
    };
  }
  const outcomes = runs.map((run) => agentRunOutcome(run));
  const partial = /^Background agent group completed: .*\bpartial\b/m.test(text);
  const allDone = outcomes.every((each) => each.state === "done");

  const body = runs
    .map((run, index) => {
      const result = run.result && !NO_RESULT.has(run.result) ? run.result : "";
      return tidy([namedOutcome(run.description ?? run.id ?? t("piNotice.subagent"), outcomes[index]!.words), run.error ? t("piNotice.errorText", { error: run.error }) : "", result].filter((row, at) => at === 0 || row !== ""));
    })
    .join("\n\n");
  return {
    look: "agent",
    title: t("piNotice.subagent"),
    summary: allDone ? t(partial ? "piNotice.groupCompletedPartial" : "piNotice.groupCompleted", { count: runs.length }) : t(partial ? "piNotice.groupEndedPartial" : "piNotice.groupEnded", { count: runs.length, outcomes: tally(outcomes.map((each) => each.words)) }),
    state: overall(outcomes.map((each) => each.state)),
    fields: fields([t("piNotice.eachSubagent"), runs.map((run, index) => t("piNotice.fieldValue", { label: run.description ?? run.id ?? t("piNotice.subagent"), value: outcomes[index]!.words })).join("\n")]),
    ...(body ? { body } : {}),
  };
}

// gotgenes 23.x：仍在运行的子 Agent 给父 Agent 发的进展（subagent-update，details = { id, description, message }，
// 正文 `<subagent-update>…<message>…</message></subagent-update>` 加一句「可以 steer_subagent 它」），以及隔离工作区
// 拆掉时留下改动的说明（subagent-workspace-notice，details = { id, description, notice }）。

function subagentUpdate({ text, details }: Input): Draft | null {
  const d = rec(details) ?? {};
  const xml = /<subagent-update\b/.test(text) ? text : "";
  const description = str(d.description) ?? quotedSubagent(tag(xml, "summary") ?? "", " sent an update");
  const message = str(d.message) ?? tag(xml, "message") ?? (xml ? undefined : str(text));
  if (!description && !message) return null;
  const gist = clip(headline(message), 120);
  const summary = t(description ? (gist ? "piNotice.progressNamedDetail" : "piNotice.progressNamed") : (gist ? "piNotice.progressDetail" : "piNotice.progress"), { name: quoted(description), detail: gist });
  return {
    look: "agent",
    title: t("piNotice.subagent"),
    summary,
    state: "info",
    fields: fields([t("piNotice.agentId"), str(d.id) ?? tag(xml, "task-id"), true]),
    ...(extra(message, gist) ? { body: message } : {}),
  };
}

function workspaceNotice({ text, details }: Input): Draft | null {
  const d = rec(details) ?? {};
  const xml = /<workspace-notice\b/.test(text) ? text : "";
  const description = str(d.description) ?? quotedSubagent(tag(xml, "summary") ?? "", " left work behind");
  const notice = str(d.notice) ?? tag(xml, "notice");
  if (!description && !notice) return null;
  const gist = clip(headline(notice), 120);
  return {
    look: "agent",
    title: t("piNotice.subagent"),
    summary: t(description ? (gist ? "piNotice.workspaceNamedDetail" : "piNotice.workspaceNamed") : (gist ? "piNotice.workspaceDetail" : "piNotice.workspace"), { name: quoted(description), detail: gist }),
    state: "info",
    fields: fields([t("piNotice.agentId"), str(d.id) ?? tag(xml, "task-id"), true]),
    ...(extra(notice, gist) ? { body: notice } : {}),
  };
}

// ── 写给父 Agent 的：pi-subagents 的请求、提醒、控制、纠偏、监督 ─────────────────────────
// 这些都投给父 Agent 的上下文（triggerTurn 唤醒它处理），回复、steer、resume 只有模型能做；Paseo 真正问你的提问走权限框。
// 所以只写成一行「发生了什么」，状态是 info；只有真的报告了失败（子 Agent 失败、引导消息没送达）才是红色。
// 正文里 `Reply with: subagent_supervisor(…)`、`Hint:`、`Status: subagent(…)`、`Inspect the run status …` 这些给模型抄的
// 调用和指令一律不显示。

// 0.77 `src/intercom/native-supervisor-channel.js` requestVisibleText()：标题行（三种）、Run、Agent、Child index、空行、
// 子 Agent 的原话，[Structured response requested…][访谈 JSON]，`Reply with: …`，`Live guidance: …`。
// details：id、requestId、reason（need_decision | interview_request | progress_update）、expectsReply、runId、agent、
// childIndex、requestBody、replyHint。
const SUPERVISOR_HEADINGS: ReadonlyMap<string, string> = /* @__PURE__ */ new Map([
  ["Subagent needs a supervisor decision.", "need_decision"],
  ["Subagent progress update.", "progress_update"],
  ["Subagent requests a structured supervisor interview.", "interview_request"],
]);

function supervisorMessage(rows: readonly string[]): string | undefined {
  const start = rows.findIndex((row) => !row.trim());
  if (start < 0) return undefined;
  const out: string[] = [];
  for (const row of rows.slice(start + 1)) {
    if (/^(?:Structured response requested\.|Reply with: |Live guidance: )/.test(row)) break;
    out.push(row);
  }
  return str(tidy(out));
}

function supervisorRequest({ text, details }: Input): Draft | null {
  const d = rec(details) ?? {};
  const rows = lines(text);
  const reason = str(d.reason) ?? SUPERVISOR_HEADINGS.get(rows[0]?.trim() ?? "");
  const agent = str(d.agent) ?? lineValue(text, "Agent");
  const message = str(d.requestBody) ?? supervisorMessage(rows);
  if (!reason && !agent && !message) return null;
  const gist = clip(headline(message), 120);
  const messageId = reason === "progress_update" ? (gist ? "piNotice.requestProgressDetail" : "piNotice.requestProgress") : reason === "interview_request" ? (gist ? "piNotice.requestInterviewDetail" : "piNotice.requestInterview") : (gist ? "piNotice.requestDecisionDetail" : "piNotice.requestDecision");
  return {
    look: "agent",
    title: t("piNotice.subagentRequest"),
    summary: t(messageId, { name: agent ? quoted(agent) : t("piNotice.subagentLead"), detail: gist }),
    state: "info",
    fields: fields([t("piNotice.runId"), str(d.runId) ?? lineValue(text, "Run"), true], [t("piNotice.requestId"), str(d.requestId) ?? str(d.id) ?? /replyTo: "([^"]+)"/.exec(text)?.[1], true]),
    ...(extra(message, gist) ? { body: message } : {}),
  };
}

/** subagent-supervisor-unanswered / -blocked：父 Agent 这一轮结束了却没回复子 Agent 的请求（details.requestIds）。 */
function supervisorReminder({ customType, text, details }: Input): Draft {
  const d = rec(details) ?? {};
  const fromDetails = list(d.requestIds).map(str).filter((id): id is string => id !== undefined);
  const fromText = requestIdList(text)?.split(/,\s*/).map((id) => id.trim()).filter(Boolean) ?? [];
  const ids = fromDetails.length ? fromDetails : fromText;
  const blocked = customType === "subagent-supervisor-blocked" || d.blocked === true;
  const n = ids.length;
  return {
    look: "agent",
    title: t("piNotice.subagentRequest"),
    summary: blocked
      ? t(n ? "piNotice.requestsUnansweredCount" : "piNotice.requestsUnanswered", { count: n })
      : t(n ? "piNotice.requestReminderCount" : "piNotice.requestReminder", { count: n }),
    state: "info",
    fields: fields([t("piNotice.requestId"), ids.join("\n"), true]),
  };
}

/** Fixed sentences pi-subagents sends the parent (no details): completion reminders and the compaction resume. */
const PARENT_SENTENCES: ReadonlyMap<string, MessageId> = /* @__PURE__ */ new Map([
  ["subagent-completion-unanswered", "piNotice.completionReminder"],
  ["subagent-completion-unhandled", "piNotice.completionUnhandled"],
  ["subagent-compaction-resume", "piNotice.compactionResume"],
]);

// 0.77 `src/runs/shared/subagent-control.js` formatControlNoticeMessage()：首行 `Subagent needs attention: {agent}` 或
// `Subagent active but long-running: {agent}`（更早的版本还有 completion_guard 的 `Subagent failed: {agent}`），然后
// Run（可带 step N）、Signal、Facts（elapsed 120s | 14 turns | … ）、Recent failures，其余是给模型抄的 steer / status /
// interrupt 调用。details = { event: { type, agent, runId, index, message, reason（idle | tool_open_threshold |
// supervisor_request | tool_failures | …）, elapsedMs, turns, tokens, toolCount, currentTool, currentToolDurationMs,
// currentPath, recentFailureSummary }, source, noticeText }。
const CONTROL_HEADER = /^Subagent (needs attention|active but long-running|failed): (.+)$/;

function factsFromEvent(event: Rec): string | undefined {
  const elapsed = num(event.elapsedMs);
  const toolMs = num(event.currentToolDurationMs);
  const tool = str(event.currentTool);
  const facts = [
    elapsed !== undefined ? t("piNotice.elapsed", { duration: duration(elapsed) ?? t("piNotice.underSecond") }) : undefined,
    num(event.turns) !== undefined ? t("piNotice.turnCount", { count: num(event.turns) }) : undefined,
    num(event.tokens) !== undefined ? t("piNotice.tokenCount", { count: num(event.tokens) }) : undefined,
    num(event.toolCount) !== undefined ? t("piNotice.toolCount", { count: num(event.toolCount) }) : undefined,
    tool ? t(toolMs !== undefined && duration(toolMs) ? "piNotice.toolElapsed" : "piNotice.toolName", { tool, duration: duration(toolMs) }) : undefined,
    str(event.currentPath) ? t("piNotice.path", { path: str(event.currentPath) }) : undefined,
  ].filter(Boolean);
  return facts.length ? facts.join(t("piNotice.factSeparator")) : undefined;
}
function factsFromText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const facts = value.split(" | ").map((fact) => {
    const part = fact.trim();
    const elapsed = /^elapsed (\d+)s$/.exec(part);
    if (elapsed) return t("piNotice.elapsed", { duration: duration(Number(elapsed[1]) * 1000) ?? t("piNotice.underSecond") });
    const counted = /^(\d+) (turns|tokens|tools)$/.exec(part);
    if (counted) return t(counted[2] === "turns" ? "piNotice.turnCount" : counted[2] === "tokens" ? "piNotice.tokenCount" : "piNotice.toolCount", { count: counted[1] });
    const tool = /^tool (\S+)(?: (\d+)s)?$/.exec(part);
    if (tool) return t(tool[2] ? "piNotice.toolElapsed" : "piNotice.toolName", { tool: tool[1], duration: duration(Number(tool[2]) * 1000) ?? t("piNotice.seconds", { count: tool[2] }) });
    const path = /^path (.+)$/.exec(part);
    return path ? t("piNotice.path", { path: path[1] }) : part;
  });
  return str(facts.filter(Boolean).join(t("piNotice.factSeparator")));
}

function controlNotice({ text, details }: Input): Draft | null {
  const d = rec(details) ?? {};
  const event = rec(d.event) ?? {};
  const header = CONTROL_HEADER.exec(lines(text)[0]?.trim() ?? "");
  const type = str(event.type) ?? (header?.[1] === "active but long-running" ? "active_long_running" : header?.[1] === "failed" ? "failed" : header ? "needs_attention" : undefined);
  if (!type) return null;
  const reason = str(event.reason);
  const agent = str(event.agent) ?? str(header?.[2]);
  const runLine = lineValue(text, "Run");
  const index = int(event.index);
  const step = index !== undefined ? index + 1 : int(/\sstep (\d+)$/.exec(runLine ?? "")?.[1]);
  const name = agent ? quoted(agent) : t("piNotice.subagentLead");
  let summary: string;
  let state: PiNoticeState = "info";
  if (type === "failed" || reason === "completion_guard") {
    summary = t("piNotice.subagentFailed", { name });
    state = "failed";
  } else if (type === "active_long_running") {
    const elapsed = duration(num(event.elapsedMs));
    summary = t(elapsed ? "piNotice.longRunningDuration" : "piNotice.longRunning", { name, duration: elapsed });
  } else {
    const elapsed = duration(num(event.elapsedMs));
    const tool = str(event.currentTool);
    const toolTime = duration(num(event.currentToolDurationMs));
    const why =
      reason === "idle" && elapsed ? t("piNotice.idleDuration", { duration: elapsed })
      : reason === "tool_open_threshold" ? t(tool ? (toolTime ? "piNotice.toolElapsed" : "piNotice.toolLongRunning") : (toolTime ? "piNotice.unnamedToolElapsed" : "piNotice.unnamedToolLongRunning"), { tool, duration: toolTime })
      : reason === "supervisor_request" ? t("piNotice.waitingParent")
      : reason === "tool_failures" ? t("piNotice.toolFailures")
      : undefined;
    summary = t(why ? "piNotice.needsAttentionReason" : "piNotice.needsAttention", { name, reason: why });
  }
  return {
    look: "agent",
    title: t("piNotice.subagent"),
    summary,
    state,
    fields: fields(
      [t("piNotice.signal"), str(event.message) ?? lineValue(text, "Signal")],
      [t("piNotice.runFacts"), factsFromEvent(event) ?? factsFromText(lineValue(text, "Facts"))],
      [t("piNotice.recentFailures"), str(event.recentFailureSummary) ?? lineValue(text, "Recent failures")],
      [t("piNotice.step"), step],
      [t("piNotice.runId"), str(event.runId) ?? runLine?.split(/\s+/)[0], true],
    ),
  };
}

// 0.77 `src/extension/steering-notices.js` formatSteeringNotice()：`Subagent steering {failed|partial|recovered}: {runId}`、
// `Request: {requestId}`、说明、`Inspect the run status before sending another correction.`；details 带 state、runId、
// requestId、message。failed = 所有目标都没收到（或收到时已太晚），partial = 一部分没收到，recovered = 恢复运行后送达。
const STEERING_HEADER = /^Subagent steering (\S+): (.+)$/;

function steeringNotice({ text, details }: Input): Draft | null {
  const d = rec(details) ?? {};
  const rows = lines(text);
  const header = STEERING_HEADER.exec(rows[0]?.trim() ?? "");
  const state = str(d.state) ?? header?.[1];
  if (!state) return null;
  const message = str(d.message) ?? str(tidy(rows.slice(1).filter((row) => !/^Request:\s/.test(row) && row.trim() !== "Inspect the run status before sending another correction.")));
  const summary =
    state === "failed" ? t("piNotice.steeringFailed")
    : state === "partial" ? t("piNotice.steeringPartial")
    : state === "recovered" ? t("piNotice.steeringRecovered")
    : t("piNotice.steeringState", { state });
  return {
    look: "agent",
    title: t("piNotice.subagent"),
    summary,
    state: state === "failed" || state === "partial" ? "failed" : "info",
    fields: fields([t("piNotice.description"), message], [t("piNotice.runId"), str(d.runId) ?? real(str(header?.[2])), true], [t("piNotice.requestId"), str(d.requestId) ?? lineValue(text, "Request"), true]),
  };
}

// 0.77 `src/watchdog/warning-format.js` formatWatchdogWarningContent()：
//   <subagent_watchdog severity="concern|blocker" importance="low|medium|high" category="…" source="main|child|lsp"
//   guidance="weigh, don't blindly obey"> <summary> <evidence> <recommended_action> [<agent>][<run_id>][<state>][<stale>]
//   [<blocker_guidance>]（写死的模型指令）</subagent_watchdog>
// 文本过了 escapeXml，属性还多转 `&quot;`。details 是同一份 warning（多 error、stalemateRepeats 等）。Pi 自己说
// 「斟酌，别盲从」，所以这是提醒，不是结论：info，阻断级也一样。
const SEVERITY_ZH: Readonly<Record<string, MessageId>> = { concern: "piNotice.concern", blocker: "piNotice.blocker" };
const IMPORTANCE_ZH: Readonly<Record<string, MessageId>> = { low: "piNotice.low", medium: "piNotice.medium", high: "piNotice.high" };
const CATEGORY_ZH: Readonly<Record<string, MessageId>> = {
  correctness: "piNotice.correctness",
  "missed-constraint": "piNotice.missedConstraint",
  "test-gap": "piNotice.testGap",
  "unsafe-change": "piNotice.unsafeChange",
  "scope-drift": "piNotice.scopeDrift",
  "stale-fact": "piNotice.staleFact",
  "loop-risk": "piNotice.loopRisk",
  other: "piNotice.other",
};
const WATCHER_ZH: Readonly<Record<string, MessageId>> = { main: "piNotice.mainAgent", child: "piNotice.subagent", lsp: "piNotice.lsp" };
const WARNING_STATE_ZH: Readonly<Record<string, MessageId>> = { stale: "piNotice.stale", failed: "piNotice.reviewFailed", stalemate: "piNotice.stalemateStopped", resolved: "piNotice.resolved", suppressed: "piNotice.suppressed" };

function watchdogWarning({ text, details }: Input): Draft | null {
  const d = rec(details) ?? {};
  const xml = /<subagent_watchdog\b/.test(text) ? text : "";
  const severity = str(d.severity) ?? attr(xml, "severity");
  const agent = str(d.agent) ?? tag(xml, "agent");
  const point = str(d.summary) ?? tag(xml, "summary");
  if (!severity && !point) return null;
  const shownPoint = point ? clip(oneLine(point), 160) : "";
  const warningState = str(d.state) ?? tag(xml, "state");
  const stale = d.stale === true || tag(xml, "stale") === "true";
  const category = str(d.category) ?? attr(xml, "category");
  const importance = str(d.importance) ?? attr(xml, "importance");
  const source = str(d.source) ?? attr(xml, "source");
  const states = [warningState && warningState !== "displayed" && warningState !== "confirmed" && warningState !== "candidate" ? (WARNING_STATE_ZH[warningState] ? t(WARNING_STATE_ZH[warningState]!) : warningState) : undefined, stale && warningState !== "stale" ? t("piNotice.stale") : undefined];
  return {
    look: "agent",
    title: t("piNotice.watchdog"),
    summary: t(agent ? (severity === "blocker" ? (shownPoint ? "piNotice.watchdogBlockerDetail" : "piNotice.watchdogBlocker") : (shownPoint ? "piNotice.watchdogConcernDetail" : "piNotice.watchdogConcern")) : (severity === "blocker" ? (shownPoint ? "piNotice.watchdogBlockerUnnamedDetail" : "piNotice.watchdogBlockerUnnamed") : (shownPoint ? "piNotice.watchdogConcernUnnamedDetail" : "piNotice.watchdogConcernUnnamed")), { name: quoted(agent), detail: shownPoint }),
    state: "info",
    fields: fields(
      [t("piNotice.point"), point && shownPoint !== point ? point : undefined],
      [t("piNotice.severity"), severity ? (SEVERITY_ZH[severity] ? t(SEVERITY_ZH[severity]!) : severity) : undefined],
      [t("piNotice.importance"), importance ? (IMPORTANCE_ZH[importance] ? t(IMPORTANCE_ZH[importance]!) : importance) : undefined],
      [t("piNotice.category"), category ? (CATEGORY_ZH[category] ? t(CATEGORY_ZH[category]!) : category) : undefined],
      [t("piNotice.source"), source ? (WATCHER_ZH[source] ? t(WATCHER_ZH[source]!) : source) : undefined],
      [t("piNotice.evidence"), str(d.evidence) ?? tag(xml, "evidence")],
      [t("piNotice.recommendation"), str(d.recommendedAction) ?? tag(xml, "recommended_action")],
      [t("piNotice.watchdogStatus"), states.filter(Boolean).join(t("piNotice.commaSeparator"))],
      [t("piNotice.reviewError"), warningState === "failed" ? str(d.error) : undefined],
      [t("piNotice.runId"), str(d.runId) ?? tag(xml, "run_id"), true],
    ),
  };
}

/** subagent_watchdog_clarification：监督方让主 Agent 澄清（模型写的自由文本，没有 details）。 */
function watchdogClarification({ text }: Input): Draft {
  const body = plainText(text);
  const gist = clip(headline(body), 160);
  return {
    look: "agent",
    title: t("piNotice.watchdog"),
    summary: t(gist ? "piNotice.clarifyDetail" : "piNotice.clarify", { detail: gist }),
    state: "info",
    fields: [],
    ...(extra(body, gist) ? { body } : {}),
  };
}

// 0.77 `src/runs/background/wait-subscriptions.js` settle()：
//   `Wait subscription {token} fired for run {runId}: {outcome}. {detail}`，details = { token, runId, outcome, completions? }。
// outcome：completed / failed / stopped / paused（运行的结局）、timed out（等待超时，运行可能还在跑）、could not be
// reconciled / reconciliation failed（确认不了结局）、needs attention（在等父 Agent）。detail 是给模型的指令，只取其中的
// `Completion archive: …`。
const WAIT_TEXT = /^Wait subscription (\S+) fired for run (\S+): (.+?)\.(?:\s+([\s\S]*))?$/;

/**
 * The rest of the first `Completion archive: ` line, one final period and the spaces after it dropped (what
 * `/Completion archive: (.+?)\.?\s*$/m` captured). 0.6.0-local.2 (codex-vivid-F1): a plain scan; the lazy regex tried the
 * line's end again after every character, quadratic on a long run of spaces.
 */
export function completionArchive(text: string): string | undefined {
  const label = "Completion archive: ";
  for (let at = text.indexOf(label); at >= 0; at = text.indexOf(label, at + 1)) {
    const start = at + label.length;
    let end = start;
    while (end < text.length && !LINE_ENDS.includes(text[end]!)) end++;
    if (end === start) continue;
    const line = text.slice(start, end);
    const kept = line.trimEnd();
    if (!kept) return line[0];
    return kept.length > 1 && kept.endsWith(".") ? kept.slice(0, -1) : kept;
  }
  return undefined;
}

function waitSubscription({ text, details }: Input): Draft | null {
  const d = rec(details) ?? {};
  const parsed = WAIT_TEXT.exec(text.trim());
  const result = str(d.outcome) ?? parsed?.[3];
  if (!result) return null;
  const key = statusKey(result);
  let summary: string;
  let state: PiNoticeState;
  if (key === "timed out") [summary, state] = [t("piNotice.waitTimeout"), "info"];
  else if (key === "needs attention") [summary, state] = [t("piNotice.waitAttention"), "info"];
  else if (key === "could not be reconciled" || key === "reconciliation failed") [summary, state] = [t("piNotice.waitUnconfirmed"), "failed"];
  else [summary, state] = [t("piNotice.waitOutcome", { outcome: outcome(result) }), piNoticeState(result)];
  return {
    look: "agent",
    title: t("piNotice.subagent"),
    summary,
    state,
    fields: fields([t("piNotice.runId"), str(d.runId) ?? parsed?.[2], true], [t("piNotice.completionArchive"), completionArchive(parsed?.[4] ?? ""), true]),
  };
}

// 0.77 `src/runs/background/notify.js` formatIncrementalChildCompletion()：工作流每个子任务结束就发一条，不等整个工作流：
//   Workflow child {completed|failed|paused (needs attention)|stopped}: **{childKey}** / Workflow run / [Child run] / [Output] /
//   [Error] / Status: {workflow still running|workflow finished}。details = { childKey, outcome }。成功的那条 display 为 false。
const WORKFLOW_CHILD = /^Workflow child (completed|failed|paused(?: \(needs attention\))?|stopped): \*\*(.+?)\*\*$/;

function workflowChild({ text, details }: Input): Draft | null {
  const d = rec(details) ?? {};
  const header = WORKFLOW_CHILD.exec(lines(text)[0]?.trim() ?? "");
  const key = str(d.childKey) ?? header?.[2];
  const result = str(d.outcome) ?? header?.[1]?.replace(/ \(needs attention\)$/, "");
  if (!key && !result) return null;
  const status = lineValue(text, "Status");
  const running = status === undefined ? undefined : /still running/.test(status);
  return {
    look: "agent",
    title: t("piNotice.subagent"),
    summary: t(running === true ? "piNotice.workflowChildRunning" : running === false ? "piNotice.workflowChildEnded" : "piNotice.workflowChild", { name: quoted(key), outcome: outcome(result) || t("piNotice.hasResult") }),
    state: piNoticeState(result),
    fields: fields(
      [t("piNotice.error"), lineValue(text, "Error")],
      [t("piNotice.output"), real(lineValue(text, "Output")), true],
      [t("piNotice.workflowStatus"), running === true ? t("piNotice.stillRunning") : running === false ? t("piNotice.ended") : undefined],
      [t("piNotice.workflow"), real(lineValue(text, "Workflow run")), true],
      [t("piNotice.childRun"), real(lineValue(text, "Child run")), true],
    ),
  };
}

/** subagent-workflow-result-write-failed：工作流的结果文件没写成，正文就是错误。 */
function workflowResultWriteFailed({ text }: Input): Draft {
  return { look: "agent", title: t("piNotice.subagent"), summary: t("piNotice.workflowSaveFailed"), state: "failed", fields: fields([t("piNotice.error"), str(text)]) };
}

// ── 联网：pi-web-access ─────────────────────────────────────────────────
// 0.39 `index.ts`：后台抓全文结束时发 web-search-content-ready（`Content fetched for {ok}/{total} URLs [{fetchId}].
// {Full|Partial page content now available.|No page content was fetched. …}`）或 web-search-error（`Content fetch failed
// [{fetchId}]: {message}`），都没有 details。`/websearch` 之类命令的结果是 web-search-results：正文是搜索摘要 markdown，
// 后面 `---` 起是给模型的 responseId 用法；details = { queries, queryCount, successfulQueries, totalResults, … }。

/**
 * `Content fetched for 2/3 URLs [id]` → [ok, total, id]: the first such header with a `]` after it, as the regex
 * `Content fetched for (\d+)\/(\d+) URLs \[([^\]]*)\]` found it (0.6.0-local.2, codex-vivid-F1: its `[^\]]*` ran to the end
 * again from every header without a `]`).
 */
export function fetchedHeader(text: string): [ok: string, total: string, id: string] | null {
  const head = /Content fetched for (\d+)\/(\d+) URLs \[/.exec(text);
  const close = head ? text.indexOf("]", head.index + head[0].length) : -1;
  return head && close >= 0 ? [head[1]!, head[2]!, text.slice(head.index + head[0].length, close)] : null;
}
/** `Content fetch failed [id]: message` → [id, message]: `/Content fetch failed \[([^\]]*)\]:\s*([\s\S]*)$/`, scanned. */
export function fetchFailure(text: string): [id: string, message: string] | null {
  const label = "Content fetch failed [";
  for (let at = text.indexOf(label); at >= 0; ) {
    const close = text.indexOf("]", at + label.length);
    if (close < 0) return null;
    if (text[close + 1] === ":") return [text.slice(at + label.length, close), text.slice(close + 2).trimStart()];
    at = text.indexOf(label, close);
  }
  return null;
}

function webContentReady({ text }: Input): Draft | null {
  const match = fetchedHeader(text);
  const ok = int(match?.[0]);
  const total = int(match?.[1]);
  if (ok === undefined || total === undefined) return null;
  const [summary, state]: [string, PiNoticeState] =
    ok === 0 && total > 0 ? [t("piNotice.fetchNone", { total }), "failed"]
    : ok < total ? [t("piNotice.fetchPartial", { ok, total }), "done"]
    : [t("piNotice.fetchComplete", { ok, total }), "done"];
  return { look: "web", title: t("piNotice.webSearch"), summary, state, fields: fields([t("piNotice.webpage"), `${ok}/${total}`], [t("piNotice.fetchId"), str(match?.[2]), true]) };
}

function webError({ text }: Input): Draft {
  const match = fetchFailure(text.trim());
  return {
    look: "web",
    title: t("piNotice.webSearch"),
    summary: t("piNotice.fetchFailed"),
    state: "failed",
    fields: fields([t("piNotice.error"), match ? match[1] : plainText(text)], [t("piNotice.fetchId"), str(match?.[0]), true]),
  };
}

function webResults({ text, details }: Input): Draft {
  const d = rec(details) ?? {};
  const queries = list(d.queries).map(str).filter((query): query is string => query !== undefined);
  const total = num(d.totalResults);
  const ok = num(d.successfulQueries);
  const asked = num(d.queryCount) ?? (queries.length || undefined);
  // The guidance for the model starts at a `---` rule followed by responseId instructions.
  const guide = text.search(/\n---\n(?:Full content for|Content fetching in background|Full search results are stored)/);
  const body = plainText(guide >= 0 ? text.slice(0, guide) : text);
  const subject = queries.length === 1 ? t("piNotice.quotedQuery", { query: queries[0] }) : asked ? t("piNotice.queryCount", { count: asked }) : "";
  const failedQueries = asked !== undefined && ok !== undefined ? asked - ok : 0;
  const summary = subject
    ? t(total !== undefined ? (failedQueries > 0 ? "piNotice.searchCountFailed" : "piNotice.searchCount") : (failedQueries > 0 ? "piNotice.searchFailed" : "piNotice.search"), { subject, total, failed: failedQueries })
    : headline(body) || t("piNotice.searchResults");
  const state: PiNoticeState = asked !== undefined && ok !== undefined ? (ok === 0 && asked > 0 ? "failed" : "done") : "info";
  return {
    look: "web",
    title: t("piNotice.webSearch"),
    summary,
    state,
    fields: fields([t("piNotice.query"), queries.join("\n")], [t("piNotice.resultCount"), total]),
    ...(body ? { body } : {}),
  };
}

// ── 目标：@narumitw/pi-goal ──────────────────────────────────────────────
// 0.54 `src/goal-contract.ts`：goal-contract 是 display: false 的「目标约定」（Paseo 0.11.1 不画，别的宿主可能画），
// details = { version, state: active | inactive, goalId }，正文里 `<goal_objective>` 是用户给的目标。
// `src/runtime.ts`：token 预算用完时发 goal-budget-wrap-up（写死的收尾指令，details = { goalId }），对人只有一个事实。

function goalContract({ text, details }: Input): Draft {
  const d = rec(details) ?? {};
  const inactive = d.state === "inactive" || (d.state === undefined && text.trim().startsWith("Goal mode is inactive."));
  const objective = tag(text, "goal_objective");
  const gist = headline(objective);
  return {
    look: "plan",
    title: t("piNotice.goal"),
    summary: inactive ? t("piNotice.goalInactive") : t(gist ? "piNotice.goalUpdatedDetail" : "piNotice.goalUpdated", { detail: clip(gist, 160) }),
    state: "info",
    fields: fields([t("piNotice.goal"), inactive ? undefined : objective], [t("piNotice.goalId"), str(d.goalId) ?? tag(text, "goal_id"), true]),
  };
}

function goalBudget({ details }: Input): Draft {
  return {
    look: "plan",
    title: t("piNotice.goal"),
    summary: t("piNotice.goalBudget"),
    state: "info",
    fields: fields([t("piNotice.goalId"), str(rec(details)?.goalId), true]),
  };
}

// ── 入口 ─────────────────────────────────────────────────────────────────

const PARSERS: ReadonlyMap<string, (input: Input) => Draft | null> = /* @__PURE__ */ new Map<string, (input: Input) => Draft | null>([
  ["background-task-notification", backgroundTask],
  ["subagent-notify", subagentNotify],
  ["subagent-notification", subagentNotification],
  ["subagent-update", subagentUpdate],
  ["subagent-workspace-notice", workspaceNotice],
  ["subagent_supervisor_request", supervisorRequest],
  ["subagent-supervisor-unanswered", supervisorReminder],
  ["subagent-supervisor-blocked", supervisorReminder],
  ["subagent_control_notice", controlNotice],
  ["subagent_steering_notice", steeringNotice],
  ["subagent_watchdog_warning", watchdogWarning],
  ["subagent_watchdog_clarification", watchdogClarification],
  ["subagent-wait-subscription", waitSubscription],
  ["subagent-incremental-child-notify", workflowChild],
  ["subagent-workflow-result-write-failed", workflowResultWriteFailed],
  ["web-search-content-ready", webContentReady],
  ["web-search-error", webError],
  ["web-search-results", webResults],
  ["goal-contract", goalContract],
  ["goal-budget-wrap-up", goalBudget],
]);

/** An unknown type keeps its extension's look when the name says which one it is. */
function family(customType: string): Pick<Draft, "look" | "title"> {
  const type = customType.toLowerCase();
  if (/^subagents?[-_:]/.test(type)) return { look: "agent", title: t("piNotice.subagent") };
  if (/^(?:web-search|web-fetch|curator-config$|google-account$)/.test(type)) return { look: "web", title: t("piNotice.webSearch") };
  if (/^goal[-_]/.test(type)) return { look: "plan", title: t("piNotice.goal") };
  if (type.startsWith("background-task")) return { look: "shell", title: t("piNotice.backgroundTask") };
  return { look: "other", title: t("piNotice.piNotice") };
}

const MAX_LEAVES = 8;
/** `<a>x</a>` elements that hold only text, in order (unescaped, empty ones skipped): an unknown notice's own fields. */
function leaves(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const match of text.matchAll(/<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>([^<]*)<\/\1\s*>/g)) {
    const value = unescapeXml(match[2]!).trim();
    if (value) out.push([match[1]!, value]);
    if (out.length >= MAX_LEAVES) break;
  }
  return out;
}

/**
 * Any other notice: its first meaningful line, tags stripped; the body is the cleaned text (or the details as JSON).
 * 0.6.0: an XML notice made of several text elements reads as its first two values, and each element is a field.
 */
function generic({ customType, text, details }: Input): Draft {
  const sentenceId = PARENT_SENTENCES.get(customType);
  const sentence = sentenceId ? t(sentenceId) : undefined;
  const pairs = sentence ? [] : leaves(text);
  if (pairs.length >= 2) {
    return {
      ...family(customType),
      summary: clip(pairs.slice(0, 2).map(([, value]) => oneLine(value)).join(t("piNotice.factSeparator"))),
      state: "info",
      fields: fields([t("piNotice.type"), customType, true], ...pairs.map(([label, value]): FieldSpec => [label, value])),
    };
  }
  const body = plainText(text);
  let shown = body;
  if (!shown && details !== undefined && details !== null) {
    try {
      shown = JSON.stringify(details, null, 2) ?? "";
    } catch {
      shown = "";
    }
  }
  const summary = sentence ?? (clip(headline(body)) || customType);
  return {
    ...family(customType),
    summary,
    state: "info",
    fields: sentence ? [] : fields([t("piNotice.type"), customType, true]),
    ...(!sentence && extra(shown, summary) ? { body: shown } : {}),
  };
}

/**
 * 0.6.0-local.2 (codex-vivid-F1): what a notice's parsers get to see, bounded before any of them runs. Paseo passes an
 * extension's text and `details` on as sent, whatever their size, and the row shows at most 12 000 characters of body and
 * 2 000 per field. So the text is cut to `text` characters, and `details` is copied with each string cut to `string`
 * characters, at most `chars` characters of strings and keys in all, `entries` entries per array or object, `nodes` values
 * and `depth` levels; keys longer than `key` are skipped. What lies past a bound is left out.
 */
export const PI_NOTICE_LIMITS = { text: 64 * 1024, string: 8 * 1024, chars: 64 * 1024, entries: 200, nodes: 4_000, depth: 8, key: 256 } as const;

/** A bounded copy of an extension's `details` (PI_NOTICE_LIMITS): plain JSON values only; undefined if reading them throws. */
export function boundDetails(value: unknown): unknown {
  const limits = PI_NOTICE_LIMITS;
  let chars: number = limits.chars;
  let nodes: number = limits.nodes;
  const room = () => nodes > 0 && chars > 0;
  const copy = (item: unknown, depth: number): unknown => {
    nodes -= 1;
    if (typeof item === "string") {
      const kept = item.slice(0, Math.max(0, Math.min(limits.string, chars)));
      chars -= kept.length;
      return kept;
    }
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return item;
    if (typeof item !== "object" || depth >= limits.depth) return undefined;
    if (Array.isArray(item)) {
      const out: unknown[] = [];
      for (let i = 0; i < item.length && out.length < limits.entries && room(); i++) out.push(copy(item[i], depth + 1));
      return out;
    }
    const out: Rec = {};
    let entries = 0;
    for (const key of Object.keys(item)) {
      if (entries >= limits.entries || !room()) break;
      if (key.length > limits.key || key === "__proto__") continue;
      entries += 1;
      chars -= key.length;
      const kept = copy((item as Rec)[key], depth + 1);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  };
  try {
    return copy(value, 0);
  } catch {
    return undefined;
  }
}

/** The row is a Pi (or OMP) extension notice: Paseo's synthetic plain-text row named after its non-empty customType. */
export function isPiNotice(item: unknown): boolean {
  try {
    const row = rec(item);
    const meta = rec(row?.metadata);
    if (!row || !meta || meta.synthetic !== true) return false;
    const customType = meta.customType;
    if (typeof customType !== "string" || !customType.trim() || row.name !== customType) return false;
    return rec(row.detail)?.type === "plain_text";
  } catch {
    return false;
  }
}

/**
 * Reads Paseo 0.11.1's synthetic Pi notice row (`metadata.synthetic`, `metadata.customType` = the row's name, plain-text
 * detail); null for every other row, Claude Code's task_notification rows included. Never throws.
 */
export function readPiNotice(item: PiNoticeSource): PiNotice | null {
  try {
    if (!isPiNotice(item)) return null;
    const meta = rec(item.metadata)!;
    const customType = meta.customType as string;
    const rawText = rec(item.detail)!.text;
    const text = typeof rawText === "string" ? rawText.slice(0, PI_NOTICE_LIMITS.text) : "";
    const input: Input = { customType, text, details: boundDetails(meta.details) };
    let draft: Draft | null = null;
    try {
      draft = PARSERS.get(customType)?.(input) ?? null;
    } catch {
      draft = null;
    }
    const shaped = draft ?? generic(input);
    const summary = oneLine(shaped.summary) || customType;
    return { customType, ...shaped, summary: clip(summary) };
  } catch {
    return null;
  }
}
