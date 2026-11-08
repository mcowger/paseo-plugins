import { t } from "./text";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import type { ExpansionMode } from "./settings";
import { reasoningKey, toolKey } from "./fold";
import { noticeHeadline, noticeIcon, noticeLook, noticeTextZh, readTaskNotice } from "./notice";
import { isPiNotice, piNoticeStatus, type PiNotice, type PiNoticeLook } from "./pi-notice";
import {
  formatError,
  formatReasoningText,
  normalizeToolCallDetail,
  resolveToolCallPresentation,
  toJsonValue,
  withMetadataEditDiff,
} from "./presentation";

export const REASONING_RENDERER_KIND = "colorful-reasoning";
export const TOOL_CALL_RENDERER_KIND = "colorful-tool-call";
export const REASONING_RENDERER_VERSION = 1;
export const TOOL_CALL_RENDERER_VERSION = 1;

export const reasoningItemDataSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
  // 本地补丁：折叠键（原文哈希，见 shared/fold.ts），行组件据此向折叠索引报到。
  fold: z.string().optional(),
});

export const diffStatsSchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const toolCallPresentationSchema = z.object({
  category: z.enum([
    "shell",
    "file",
    "search",
    "agent",
    "plan",
    "communication",
    "unknown",
  ]),
  icon: z.string(),
  label: z.string(),
  summary: z.string().optional(),
  filePath: z.string().optional(),
  fileIcon: z.string().optional(),
  language: z.string().optional(),
  diffStats: diffStatsSchema.optional(),
});

export const taskNoticeDataSchema = z.object({
  /** 中文的一行说明，例如 后台命令「构建」已完成（退出码 0）。 */
  text: z.string(),
  // 0.6.0：通知的种类和结局（shared/notice.ts）。行头的标题和摘要是 noticeHeadline() 的结果，info（提醒、事件）不带状态标记。
  kind: z.enum(["command", "agent", "monitor", "event", "remote", "task", "workflow", "repeat", "other"]),
  state: z.enum(["done", "failed", "stopped", "blocked", "info"]),
  taskId: z.string().optional(),
  outputFile: z.string().optional(),
});

/**
 * 0.6.0-local.5 (merged with the lazy release): the Pi notice reader (shared/pi-notice.ts readPiNotice) is not part of the
 * resident timeline: pi-chunk.client.tsx brings it the first time a Pi notice row is drawn (only Pi and OMP Agents send
 * them), and client/transform.ts then draws the rows again.
 */
export type PiNoticeReader = (item: Extract<AgentTimelineItem, { type: "tool_call" }>) => PiNotice | null;
let piNoticeReader: PiNoticeReader | null = null;
/**
 * 0.6.0-local.5 (codex-vivid-merge-F2): where the reader is while it is not here: "idle" (nobody asked for it, as while the
 * plugin starts or stops), "loading" (on its way) or "failed" (its download failed; client/transform.ts tries again).
 * Until it is here a Pi notice row is a neutral row saying which (`unreadPiNotice`), never an ordinary tool row: Paseo marks
 * every Pi custom message completed, so a failed or stopped task would show as done.
 */
export type PiNoticeReaderPhase = "idle" | "loading" | "failed";
let piNoticePhase: PiNoticeReaderPhase = "idle";
export function setPiNoticeReader(reader: PiNoticeReader | null): void {
  piNoticeReader = reader;
}
export function setPiNoticePhase(phase: PiNoticeReaderPhase): void {
  piNoticePhase = phase;
}
export function hasPiNoticeReader(): boolean {
  return piNoticeReader !== null;
}

/** 0.6.0 (opus-B30): most characters of a Pi notice's body and of one of its fields kept in the row's data. */
export const PI_NOTICE_BODY_CHARS = 12_000;
const PI_NOTICE_FIELD_CHARS = 2_000;
const PI_NOTICE_FIELDS = 16;

export const piNoticeDataSchema = z.object({
  customType: z.string(),
  state: z.enum(["done", "failed", "stopped", "running", "info"]),
  look: z.enum(["shell", "agent", "web", "plan", "other"]),
  fields: z.array(z.object({ id: z.string().optional(), label: z.string(), value: z.string(), mono: z.boolean().optional() })),
  body: z.string().optional(),
  /** The body was longer than PI_NOTICE_BODY_CHARS. */
  cut: z.boolean().optional(),
  /** 0.6.0-local.5 (codex-vivid-merge-F2): drawn without the reader, and why (the body is then the message as sent). */
  reader: z.enum(["idle", "loading", "failed"]).optional(),
});
export type PiNoticeData = z.output<typeof piNoticeDataSchema>;

const PI_LOOKS: Record<PiNoticeLook, { icon: string; category: "shell" | "agent" | "search" | "plan" | "unknown" }> = {
  shell: { icon: "SquareTerminal", category: "shell" },
  agent: { icon: "Bot", category: "agent" },
  web: { icon: "Globe", category: "search" },
  plan: { icon: "Target", category: "plan" },
  other: { icon: "Bell", category: "unknown" },
};

/**
 * 0.6.0-local.5 (codex-vivid-merge-F2): a Pi notice row drawn without the reader: no state mark (info), what happened, and
 * except while the reader is on its way the message as sent, so it can still be read.
 */
const PI_NOTICE_UNREAD: Record<PiNoticeReaderPhase, { summary: string; note: string }> = {
  loading: { get summary() { return t("timelinePi.loadingSummary"); }, get note() { return t("timelinePi.loadingNote"); } },
  failed: { get summary() { return t("timelinePi.failedSummary"); }, get note() { return t("timelinePi.failedNote"); } },
  idle: { get summary() { return t("timelinePi.idleSummary"); }, get note() { return t("timelinePi.idleNote"); } },
};
function unreadPiNotice(customType: string, raw: string, phase: PiNoticeReaderPhase): PiNoticeData {
  const body = phase === "loading" ? "" : raw;
  return {
    customType,
    state: "info",
    look: "other",
    fields: [{ label: t("timelinePi.note"), value: PI_NOTICE_UNREAD[phase].note }],
    ...(body ? { body: body.slice(0, PI_NOTICE_BODY_CHARS) } : {}),
    ...(body.length > PI_NOTICE_BODY_CHARS ? { cut: true } : {}),
    reader: phase,
  };
}

export const toolCallItemDataSchema = z.object({
  // 本地补丁：带上 callId，行组件据此认出「等你批准」的那一行。
  callId: z.string().optional(),
  // 本地补丁：折叠键（`t:<callId>`）。
  fold: z.string().optional(),
  // 0.6.0：一次补丁拆成多张卡时，第二张起的序号（同一个折叠键；钉住的提问只画在第一张上方）。
  part: z.number().int().positive().optional(),
  // 本地补丁：Claude Code 的后台任务通知（Paseo 合成的 task_notification 行）。
  notice: taskNoticeDataSchema.optional(),
  // 0.6.0：Pi 扩展的通知（Paseo 合成的 customType 行，shared/pi-notice.ts）。
  pi: piNoticeDataSchema.optional(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  detail: z.json(),
  errorText: z.string().optional(),
  presentation: toolCallPresentationSchema,
});

/** 本地补丁：折叠摘要行（「12 步 思考 2 · 命令 5…」或运行中的「前面 N 步」）。数据由转换器按折叠索引写入。 */
export const FOLD_RENDERER_KIND = "vivid-fold";
export const FOLD_RENDERER_VERSION = 1;
export const foldItemDataSchema = z.object({
  segment: z.string(),
  mode: z.enum(["done", "earlier"]),
  expanded: z.boolean(),
  steps: z.number().int().nonnegative(),
  hidden: z.number().int().nonnegative(),
  counts: z.array(z.tuple([z.string(), z.number().int().nonnegative()])),
  failed: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative().nullable(),
  endedAt: z.number().nonnegative().nullable().default(null),
  // 0.8.0: what the segment changed (shared/fold.ts summarizeChanges) and the turn whose tokens its last segment shows.
  files: z.number().int().nonnegative().optional(),
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
  uncounted: z.number().int().nonnegative().optional(),
  changed: z.array(z.object({ key: z.string(), file: z.string(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() })).optional(),
  fails: z.array(z.object({ key: z.string(), exit: z.number().int().nullable() })).optional(),
  turn: z.string().nullable().optional(),
  lastOfTurn: z.boolean().optional(),
});
export type FoldItemData = z.output<typeof foldItemDataSchema>;

export type ReasoningItemData = z.output<typeof reasoningItemDataSchema>;
export type ToolCallItemData = z.output<typeof toolCallItemDataSchema>;

export function resolveExpansion(mode: ExpansionMode, isLatest: boolean, userExpanded: boolean | null, isFailed = false): boolean {
  if (userExpanded !== null) return userExpanded;
  if (mode === "always") return true;
  if (mode === "never") return false;
  // 0.11.0:「失败」档：只展开失败的行；运行中的行失败后即时展开（状态翻转驱动重渲染）。
  if (mode === "failures") return isFailed;
  return isLatest;
}

export function isLatestTaskUpdate(timestamp: number, latestTimestamp: number): boolean {
  return latestTimestamp > 0 && timestamp >= latestTimestamp;
}

export interface TaskUpdateExpansionOverride {
  expanded: boolean;
  latestTimestamp: number;
}

export function resolveTaskUpdateExpansion(
  mode: ExpansionMode,
  isLatest: boolean,
  latestTimestamp: number,
  userOverride: TaskUpdateExpansionOverride | null,
): boolean {
  const userExpanded =
    mode !== "latest" || userOverride?.latestTimestamp === latestTimestamp
      ? userOverride?.expanded ?? null
      : null;
  return resolveExpansion(mode, isLatest, userExpanded);
}

export function createReasoningData(
  item: Extract<AgentTimelineItem, { type: "reasoning" }>,
  phase: ReasoningItemData["phase"],
): ReasoningItemData {
  return { text: formatReasoningText(item.text), phase, fold: reasoningKey(item.text) };
}

export function createToolCallData(
  source: Extract<AgentTimelineItem, { type: "tool_call" }>,
): ToolCallItemData {
  const item = withMetadataEditDiff(source);
  const detail = normalizeToolCallDetail(item.detail, item.name);
  const notice = readTaskNotice(item);
  const noticeText = notice ? noticeTextZh(notice) : null;
  // 本地补丁：Claude Code 的后台任务通知画成中文的「后台命令」「后台 Agent」「监控」……行（上游是灰色拼图 + 英文原文）。
  // 0.6.0：子 Agent、远程任务用子 Agent 品红，其余用命令橙；状态按 Claude Code 发来的原值（daemon 把 killed 也记成完成）。
  const headline = notice ? noticeHeadline(notice) : null;
  // 0.6.0 (opus-B30): a Pi extension's notice (background task, sub-agent, web search, goal…) as a Chinese card.
  const pi = notice || !piNoticeReader ? null : piNoticeReader(item);
  // 0.6.0-local.5 (codex-vivid-merge-F2): no reader (on its way, failed, not asked for): a neutral row saying which.
  const unread = !notice && !piNoticeReader && isPiNotice(item) ? piNoticePhase : null;
  const presentation = notice && headline
    ? { category: noticeLook(notice.kind) === "agent" ? ("agent" as const) : ("shell" as const), icon: noticeIcon(notice.kind), label: headline.title, summary: headline.summary || undefined }
    : pi
      ? { category: PI_LOOKS[pi.look].category, icon: PI_LOOKS[pi.look].icon, label: pi.title, summary: pi.summary || undefined }
      : unread
        ? { category: PI_LOOKS.other.category, icon: PI_LOOKS.other.icon, label: t("timelinePi.notice"), summary: PI_NOTICE_UNREAD[unread].summary }
        : resolveToolCallPresentation({ name: item.name, detail });
  const errorText = formatError(item.error);
  return {
    ...(item.callId ? { callId: item.callId, fold: toolKey(item.callId) } : {}),
    ...(notice && noticeText
      ? {
          notice: {
            text: noticeText,
            kind: notice.kind,
            state: notice.state,
            ...(notice.taskId ? { taskId: notice.taskId } : {}),
            ...(notice.outputFile ? { outputFile: notice.outputFile } : {}),
          },
        }
      : {}),
    ...(pi
      ? {
          pi: {
            customType: pi.customType,
            state: pi.state,
            look: pi.look,
            fields: pi.fields.slice(0, PI_NOTICE_FIELDS).map((field) => ({ ...field, ...(field.id ? { id: field.id } : {}), value: field.value.slice(0, PI_NOTICE_FIELD_CHARS) })),
            ...(pi.body ? { body: pi.body.slice(0, PI_NOTICE_BODY_CHARS) } : {}),
            ...(pi.body && pi.body.length > PI_NOTICE_BODY_CHARS ? { cut: true } : {}),
          },
        }
      : unread
        ? { pi: unreadPiNotice(item.name, detail?.type === "plain_text" ? detail.text ?? "" : "", unread) }
        : {}),
    name: item.name,
    status: notice ? notice.status : pi ? piNoticeStatus(pi.state) : item.status,
    detail: toJsonValue(detail),
    ...(errorText ? { errorText } : {}),
    presentation: {
      category: presentation.category,
      icon: presentation.icon,
      label: presentation.label,
      ...(presentation.summary ? { summary: presentation.summary } : {}),
      ...(presentation.filePath ? { filePath: presentation.filePath } : {}),
      ...(presentation.fileIcon ? { fileIcon: presentation.fileIcon } : {}),
      ...(presentation.language ? { language: presentation.language } : {}),
      ...(presentation.diffStats ? { diffStats: presentation.diffStats } : {}),
    },
  };
}
