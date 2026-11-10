import { t, type MessageId } from "../shared/text";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { childLoaded, childReadable, CHILD_TIMELINE_PAGE_SIZE, recentChildTimelineEntries, type ChildRecord } from "../shared/child-agent";
import type { ChildSummaryInput, ChildSummaryOutput, ChildSummaryRow } from "../shared/child-summary";
import { formatReasoningText, resolveToolCallPresentation } from "../shared/presentation";
import { TURN_TIME_RENDERER_KIND } from "../shared/turn-time";
import { zh } from "../shared/vivid-model";
import { hostRoute } from "./host-routes";

const LEVELS: Record<string, MessageId> = { info: "childSummary.notification", warning: "childSummary.warning", warn: "childSummary.warning", error: "childSummary.error", success: "childSummary.success" };

/** Byte limits include multibyte Chinese/emoji and JSON escapes, so previews stay small for every language. */
function clip(value: string | undefined, bytes: number): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (Buffer.byteLength(JSON.stringify(text)) - 2 <= bytes) return text;
  let result = "";
  for (const point of text) {
    if (Buffer.byteLength(JSON.stringify(result + point + "…")) - 2 > bytes) break;
    result += point;
  }
  return result + "…";
}

export function childSummaryRow(entry: { seqStart: number; seqEnd: number; item: AgentTimelineItem }): ChildSummaryRow {
  const item = entry.item;
  const row: ChildSummaryRow = { k: String(entry.seqStart), i: "Puzzle", t: t("childSummary.activity"), c: "unknown" };
  switch (item.type) {
    case "reasoning": Object.assign(row, { i: "Brain", t: t("childSummary.thinking"), x: formatReasoningText(item.text), c: "reasoning" }); break;
    case "tool_call": {
      const presentation = resolveToolCallPresentation(item);
      Object.assign(row, { i: presentation.icon, t: zh(presentation.label), x: presentation.summary, c: presentation.category, s: item.status });
      break;
    }
    case "assistant_message": Object.assign(row, { i: "MessageSquare", t: t("childSummary.agent"), x: item.text, c: "communication" }); break;
    case "user_message": Object.assign(row, { i: "MessageSquare", t: t("childSummary.prompt"), x: item.text, c: "communication" }); break;
    case "todo": Object.assign(row, { i: "ListChecks", t: t("childSummary.tasks"), x: t("childSummary.completed", { done: item.items.filter((task) => task.completed).length, total: item.items.length }), c: "plan" }); break;
    case "error": Object.assign(row, { i: "CircleX", t: t("childSummary.error"), x: item.message, c: "failed" }); break;
    case "notification": Object.assign(row, { i: "Bell", t: LEVELS[item.level] ? t(LEVELS[item.level]!) : item.level, x: item.message, c: item.level === "error" ? "failed" : "communication" }); break;
    case "compaction": Object.assign(row, { i: "Archive", t: t("childSummary.compacted"), c: "plan", s: item.status }); break;
    case "plugin": row.t = item.kind; break;
  }
  row.t = clip(row.t, 36) ?? t("childSummary.activity");
  row.x = clip(row.x, 72);
  return row;
}

/**
 * The child's status for the card: closed when archived or not loaded. 0.6.0 (codex-F18): loaded means a live record, the
 * one carrying `activeTurn` (shared/child-agent.ts childLoaded): a daemon that went down leaves its Agents stored as
 * running or idle, and reading one of those would load it.
 */
function cardStatus(agent: ChildRecord): string | null {
  return agent.archivedAt || !childLoaded(agent) ? "closed" : agent.status ?? null;
}

const TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
/** The first line of an error, short, with common token shapes masked: the phone shows it on the parent's row. */
export function errorLine(value: unknown): string | null {
  const line = typeof value === "string" ? value.split("\n").map((part) => part.trim()).find(Boolean) : undefined;
  if (!line) return null;
  const masked = line.replace(TOKEN, "[redacted]").replace(/\b(Bearer|token=|api[_-]?key=)\s*\S+/gi, "$1 [redacted]");
  return masked.length > 150 ? `${masked.slice(0, 149)}…` : masked;
}

/** What the card shows of the child: its status, and (0.10) whether it waits for you or why it failed. */
function cardAgent(agent: ChildRecord & { pendingPermissions?: unknown; lastError?: unknown }, status: string): NonNullable<ChildSummaryOutput["agent"]> {
  const pending = Array.isArray(agent.pendingPermissions) ? agent.pendingPermissions : [];
  const waiting = status === "closed" || !pending.length ? null
    : pending.every((item) => !!item && typeof item === "object" && (item as { kind?: unknown }).kind === "question") ? "question" as const : "approval" as const;
  const error = status === "error" ? errorLine(agent.lastError) : null;
  return { status, ...(waiting ? { waiting } : {}), ...(error ? { error } : {}) };
}

/**
 * Reads where the child runs; the phone receives only the three compact rows it actually draws. 0.6.0 merge: the card's
 * 0.6.0 rules for reading a child (loaded by its record, fail closed when the status check fails) moved here with the
 * reading. 0.9.1: a child `create_agent` put on another host (Paseo 0.13) is read there by the same rules (host-routes.ts).
 */
export async function handleChildSummary(input: ChildSummaryInput, context: PluginHandlerContext): Promise<ChildSummaryOutput> {
  if (input.agentId.startsWith("provider:")) return { status: "missing", agent: null, rows: [] };
  const route = await hostRoute(context.paseo, input.serverId);
  if (route.kind === "local") return summarize(input, context.paseo, null);
  if (route.kind === "offline") return { status: "offline", agent: null, rows: [], host: route.host };
  let broken = true;
  try {
    const output = await summarize(input, route.api, route.host);
    broken = output.status === "offline";
    return output;
  } finally {
    route.release(broken);
  }
}

async function summarize(input: ChildSummaryInput, paseo: PluginHandlerContext["paseo"], host: string | null): Promise<ChildSummaryOutput> {
  const where = host ? { host } : {};
  const missing: ChildSummaryOutput = { status: "missing", agent: null, rows: [], ...where };
  const handle = paseo.agents.ref(input.agentId);
  // `fetch_agent` reads the stored record of an Agent that is not loaded and never loads it.
  let agent: ChildRecord | null | undefined;
  try {
    agent = (await handle.refresh())?.agent ?? null;
  } catch (error) {
    if (/not found/i.test(error instanceof Error ? error.message : String(error))) return missing;
    // 0.9.1: on another host a failed check most often means the way there went away; the next read connects again.
    if (host) return { status: "offline", agent: null, rows: [], host };
    // 0.6.0 (grok-F9, pi-F2): no answer, so no telling whether reading would load the child: read nothing by itself.
    // The user's own read still goes ahead, as it would for a closed child.
    if (!input.manual) return { status: "unconfirmed", agent: null, rows: [] };
    agent = undefined;
  }
  if (agent === null) return missing;
  const status = agent ? cardStatus(agent) : null;
  const current = status && agent ? cardAgent(agent, status) : null;
  if (!input.manual && !childReadable(status)) return { status: "closed", agent: current, rows: [], ...where };
  if (input.statusOnly) return { status: "ok", agent: current, rows: [], ...where };
  const page = await handle.timeline.refetch({ direction: "tail", limit: CHILD_TIMELINE_PAGE_SIZE, projection: "projected" });
  const after = page.agent ? cardStatus(page.agent) : status;
  const output: ChildSummaryOutput = {
    status: "ok",
    agent: after ? cardAgent({ ...agent, ...page.agent }, after) : null,
    // This plugin's turn-end time row (server/turn-time.ts) is not something the child did: it never takes one of the three places.
    rows: recentChildTimelineEntries(page.entries.filter((entry) => !(entry.item.type === "plugin" && entry.item.kind === TURN_TIME_RENDERER_KIND)))
      .slice(-3)
      .map(childSummaryRow),
    ...where,
  };
  // Keep even three long tool summaries below ~10 KiB/min (12 responses plus RPC envelopes and 4/3 relay expansion).
  // Sequence start is stable for an updated entry; the revision sequence need not cross the wire just to key a row.
  // A failed child's error line (0.10) comes on top: it doesn't take the rows' room.
  const limit = 500 + (output.agent?.error ? Buffer.byteLength(JSON.stringify(output.agent.error)) : 0);
  while (Buffer.byteLength(JSON.stringify(output)) > limit) {
    const candidates = output.rows.filter((row) => row.x && Buffer.byteLength(row.x) > 3);
    const longest = candidates.sort((left, right) => Buffer.byteLength(right.x!) - Buffer.byteLength(left.x!))[0];
    if (longest) {
      const budget = Buffer.byteLength(longest.x!) - 12;
      longest.x = budget < 6 ? undefined : clip(longest.x, budget);
      continue;
    }
    const title = output.rows.filter((row) => Buffer.byteLength(row.t) > 12).sort((left, right) => Buffer.byteLength(right.t) - Buffer.byteLength(left.t))[0];
    if (!title) break;
    title.t = clip(title.t, 12)!;
  }
  return output;
}
