import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import {
  SUBPI_SUBSESSION_CAPABILITY,
  childOutcomeToTurnState,
  childSessionIdForRun,
  childTurnIdForRun,
  subpiActivityRecordSchema,
  subpiBridgeRecordSchema,
  type SubpiActivityRecord,
  type SubpiBridgeOutcome,
  type SubpiBridgeRecord,
} from "../shared/subagents.js";
import { openChildJournal, type ChildJournal } from "./child-journal.js";
import { createTimeline, type Timeline } from "./timeline.js";

/**
 * Read-only native provider subsession observer for owned pi-subagents runs.
 *
 * The observer turns bridge records into Paseo's public child-session vocabulary:
 * one `session.opened` per run with a stable `superpi-child:<runId>` provider
 * session id and the direct parent provider session id (root for direct
 * children, `superpi-child:<parentRunId>` for grandchildren), full
 * `timeline.item` snapshots folded through the same `createTimeline` rules as a
 * root session, and exactly one `session.turn` start/terminal pair per run.
 *
 * It never steers, resumes, or aborts a run. Terminal outcomes are sticky and a
 * canceled run never emits a clean `session.closed` that could overwrite the
 * canceled status with completed in the host adapter. Native reasons travel in
 * normal child `session.notice` data, which does not wake the parent.
 *
 * Durable append/restore is delegated to `child-journal.ts`. A terminal record is
 * fsynced before its terminal turn is published. Restore replays the whole
 * journal with no prefix/L2 cutoff, then reports any run that lacks a confirmed
 * terminal as an interrupted failure.
 */

/** Known native child follower limits; used only to flag possible host display truncation. */
const HOST_CHILD_ITEM_PREFIX_LIMIT = 200;
const HOST_CHILD_BYTE_PREFIX_LIMIT = 2 * 1024 * 1024;

const HOST_LIMIT_WARNING_ID = "child-history-display-limit";
const OMITTED_RECORD_WARNING_ID = "child-journal-omission";

/**
 * True for live-streaming activity that must be folded and forwarded but never
 * durably stored. Every delta carries the cumulative message, so journaling
 * each one grows the journal quadratically; the finalized `message_end` /
 * `tool_execution_end` record is the authoritative recovery shape.
 */
function isStreamingUpdate(record: SubpiBridgeRecord): boolean {
  if (record.type !== "activity" || record.omitted === true) return false;
  const raw = record.record;
  if (!raw || typeof raw !== "object") return false;
  const kind = (raw as { kind?: unknown }).kind;
  return kind === "message_update" || kind === "tool_execution_update";
}

/** Meaningful display text for a terminal result, or undefined when it has none. */
function terminalResultText(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") {
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["text", "summary", "result", "message"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    try {
      const json = JSON.stringify(result);
      return json !== undefined && json !== "{}" && json !== "[]" ? json : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** True when the run's final text is already present in the last assistant snapshot. */
function sameFinalText(last: string | undefined, result: string): boolean {
  if (last === undefined) return false;
  const left = last.trim();
  const right = result.trim();
  if (left.length === 0 || right.length === 0) return false;
  return left === right || left.includes(right);
}

interface ChildRunState {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly parentSessionId: string;
  readonly cwd: string;
  timeline: Timeline;
  readonly emittedSnapshots: Map<string, string>;
  readonly warnings: Set<string>;
  sequence: number;
  opened: boolean;
  turnStarted: boolean;
  terminal: SubpiBridgeOutcome | null;
  itemCount: number;
  approximateBytes: number;
}

export interface CreateSubagentObserverOptions {
  /** Root provider session id that directly parents top-level child runs. */
  rootSessionId: string;
  /** Root session key. Envelope filtering is done by the session handler. */
  sessionKey: string;
  /** Root working directory, used when a bridge record omits its own `cwd`. */
  rootCwd?: string;
  /** Parent session store directory; the journal is `<directory>/child-journal.jsonl`. */
  directory: string;
  /** Publishes validated provider events into the owning connection. */
  emit: (event: ProviderEvent) => void;
  /** Replay the durable journal and settle unfinished runs before returning. */
  restore?: boolean;
}

export interface SubagentObserver {
  /**
   * Accept one raw bridge record. The caller has already validated the companion
   * envelope and matched `sessionKey`; `accept` validates and ignores anything
   * that is not a version-1 bridge record.
   */
  accept(record: unknown): Promise<void>;
  /** Runs that have not reported a terminal outcome. */
  activeCount(): number;
  /** Settle still-running tracks and close the journal; idempotent. */
  close(reason?: string): Promise<void>;
}

class SubagentObserverImpl implements SubagentObserver {
  private readonly runs = new Map<string, ChildRunState>();
  private readonly journal: ChildJournal;
  private readonly rootSessionId: string;
  private readonly rootCwd: string | undefined;
  private readonly emit: (event: ProviderEvent) => void;
  private closed = false;

  constructor(
    options: CreateSubagentObserverOptions,
    journal: ChildJournal,
  ) {
    this.rootSessionId = options.rootSessionId;
    this.rootCwd = options.rootCwd;
    this.emit = options.emit;
    this.journal = journal;
  }

  activeCount(): number {
    let count = 0;
    for (const state of this.runs.values()) {
      if (!state.terminal) count += 1;
    }
    return count;
  }

  async accept(raw: unknown): Promise<void> {
    if (this.closed) return;
    const parsed = subpiBridgeRecordSchema.safeParse(raw);
    if (!parsed.success) return;
    const record = parsed.data;
    const existing = this.runs.get(record.runId);
    if (existing?.terminal) return;
    if (existing && record.sequence <= existing.sequence) return;
    // Streaming deltas are folded and forwarded live but never journaled; the
    // finalized end record is what makes recovery linear in reply size.
    if (!isStreamingUpdate(record)) {
      if (record.type === "terminal") await this.journal.appendDurable(record);
      else await this.journal.append(record);
    }
    if (this.closed) return;
    const state = existing ?? this.createRun(record);
    this.apply(state, record);
  }

  private createRun(record: SubpiBridgeRecord): ChildRunState {
    const sessionId = childSessionIdForRun(record.runId);
    const state: ChildRunState = {
      runId: record.runId,
      sessionId,
      turnId: childTurnIdForRun(record.runId),
      parentSessionId: this.parentSessionFor(record),
      cwd: this.cwdFor(record),
      timeline: null as unknown as Timeline,
      emittedSnapshots: new Map(),
      warnings: new Set(),
      sequence: 0,
      opened: false,
      turnStarted: false,
      terminal: null,
      itemCount: 0,
      approximateBytes: 0,
    };
    state.timeline = createTimeline({
      sessionId,
      emit: (event) => this.publishTimeline(state, event),
    });
    this.runs.set(record.runId, state);
    return state;
  }

  private parentSessionFor(record: SubpiBridgeRecord): string {
    return record.parentRunId
      ? childSessionIdForRun(record.parentRunId)
      : this.rootSessionId;
  }

  private cwdFor(record: SubpiBridgeRecord): string {
    // The bridge carries the actual child working directory; never infer it from
    // the transcript path. Fall back to the root session's directory.
    return record.cwd ?? this.rootCwd ?? process.cwd();
  }

  private apply(state: ChildRunState, record: SubpiBridgeRecord): void {
    state.sequence = Math.max(state.sequence, record.sequence);
    if (!state.opened) this.openRun(state, record);
    if (!state.turnStarted) this.startTurn(state);
    switch (record.type) {
      case "created":
        break;
      case "activity":
        this.foldActivity(state, record);
        break;
      case "terminal":
        this.finishRun(state, record);
        break;
    }
  }

  private openRun(state: ChildRunState, record: SubpiBridgeRecord): void {
    state.opened = true;
    this.emit({
      type: "session.opened",
      sessionId: state.sessionId,
      parentSessionId: state.parentSessionId,
      ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
      capabilities: [SUBPI_SUBSESSION_CAPABILITY],
      restoration: "parent",
      ...(record.title ? { title: record.title } : {}),
      cwd: state.cwd,
    });
  }

  private startTurn(state: ChildRunState): void {
    state.turnStarted = true;
    this.emit({
      type: "session.turn",
      sessionId: state.sessionId,
      turnId: state.turnId,
      state: "started",
    });
  }

  private publishTimeline(state: ChildRunState, event: ProviderEvent): void {
    if (event.type === "timeline.item") {
      const key = JSON.stringify(event.item);
      if (state.emittedSnapshots.get(event.item.id) === key) return;
      state.emittedSnapshots.set(event.item.id, key);
      state.itemCount += 1;
      state.approximateBytes += Buffer.byteLength(key);
    }
    this.emit(event);
  }

  private foldActivity(state: ChildRunState, record: SubpiBridgeRecord): void {
    if (record.omitted) {
      this.warnOmitted(state);
      return;
    }
    const parsed = subpiActivityRecordSchema.safeParse(record.record);
    if (!parsed.success) return;
    const mapped = timelineRecordForActivity(parsed.data);
    if (!mapped) return;
    state.timeline.accept(mapped, { turnId: state.turnId });
  }

  private finishRun(state: ChildRunState, record: SubpiBridgeRecord): void {
    if (state.terminal) return;
    const outcome = record.outcome ?? "completed";
    state.terminal = outcome;
    const turnState = childOutcomeToTurnState(outcome);
    this.emit({
      type: "session.turn",
      sessionId: state.sessionId,
      turnId: state.turnId,
      state: turnState,
      ...(turnState === "failed"
        ? { error: { message: record.reason?.trim() || "Child run failed" } }
        : {}),
    });
    this.emitTerminalNotice(state, outcome, record.reason);
    this.emitTerminalResult(state, record.result, outcome);
    this.warnHostDisplayLimit(state);
  }

  /**
   * A terminal result is the run's final answer. Paseo's native child view can
   * show only an early prefix of a long history, so when the result is not
   * already the last assistant snapshot it is surfaced as a visible notice
   * rather than left only in the durable journal.
   */
  private emitTerminalResult(
    state: ChildRunState,
    result: unknown,
    outcome: SubpiBridgeOutcome,
  ): void {
    const text = terminalResultText(result);
    if (!text || sameFinalText(this.lastAssistantText(state), text)) return;
    this.emit({
      type: "session.notice",
      sessionId: state.sessionId,
      notice: {
        id: `child-terminal-result:${state.runId}`,
        severity: outcome === "failed" ? "error" : outcome === "canceled" ? "warning" : "info",
        title: "Child result",
        description: text,
      },
    });
  }

  private lastAssistantText(state: ChildRunState): string | undefined {
    const items = state.timeline.items();
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.type === "assistant_message") return item.text;
    }
    return undefined;
  }

  private emitTerminalNotice(
    state: ChildRunState,
    outcome: SubpiBridgeOutcome,
    reason: string | undefined,
  ): void {
    const trimmed = reason?.trim();
    if (!trimmed && outcome === "completed") return;
    const description =
      trimmed ??
      (outcome === "steered"
        ? "The child reached its turn limit and wrapped up; the host records this as completed."
        : outcome === "canceled"
          ? "The child run was canceled before completion."
          : "The child run failed without a provider reason.");
    this.emit({
      type: "session.notice",
      sessionId: state.sessionId,
      notice: {
        id: `child-terminal:${state.runId}`,
        severity:
          outcome === "failed" ? "error" : outcome === "canceled" ? "warning" : "info",
        title: terminalNoticeTitle(outcome),
        description,
      },
    });
  }

  private warnHostDisplayLimit(state: ChildRunState): void {
    if (
      state.itemCount <= HOST_CHILD_ITEM_PREFIX_LIMIT &&
      state.approximateBytes <= HOST_CHILD_BYTE_PREFIX_LIMIT
    ) {
      return;
    }
    if (state.warnings.has(HOST_LIMIT_WARNING_ID)) return;
    state.warnings.add(HOST_LIMIT_WARNING_ID);
    this.emit({
      type: "session.notice",
      sessionId: state.sessionId,
      notice: {
        id: `${HOST_LIMIT_WARNING_ID}:${state.runId}`,
        severity: "info",
        title: "Child history may be truncated in this view",
        description: `The durable journal retained ${state.itemCount} items (~${state.approximateBytes} bytes). Paseo's native child view may show only an early prefix.`,
      },
    });
  }

  private warnOmitted(state: ChildRunState): void {
    if (state.warnings.has(OMITTED_RECORD_WARNING_ID)) return;
    state.warnings.add(OMITTED_RECORD_WARNING_ID);
    this.emit({
      type: "session.notice",
      sessionId: state.sessionId,
      notice: {
        id: `${OMITTED_RECORD_WARNING_ID}:${state.runId}`,
        severity: "warning",
        title: "A child activity record was omitted",
        description:
          "One child activity record exceeded the per-record size cap and was not forwarded. Identity and the native transcript reference are retained; the omitted payload was not replayed.",
      },
    });
  }

  private settleInterrupted(state: ChildRunState, reason: string): void {
    if (state.terminal) return;
    state.terminal = "failed";
    this.emit({
      type: "session.turn",
      sessionId: state.sessionId,
      turnId: state.turnId,
      state: "failed",
      error: { message: reason },
    });
    this.emit({
      type: "session.notice",
      sessionId: state.sessionId,
      notice: {
        id: `child-interrupted:${state.runId}`,
        severity: "warning",
        title: "Child run was interrupted",
        description: reason,
      },
    });
    this.warnHostDisplayLimit(state);
  }

  async restore(): Promise<void> {
    for await (const entry of this.journal.entries()) {
      if (entry.kind === "omission") {
        this.emit({
          type: "session.notice",
          sessionId: this.rootSessionId,
          notice: {
            id: OMITTED_RECORD_WARNING_ID,
            severity: "warning",
            title: "A child journal record was omitted during restore",
            description: `About ${entry.omittedBytes} bytes of an oversized line were skipped. Later records are still restored.`,
          },
        });
        continue;
      }
      const record = entry.record;
      const existing = this.runs.get(record.runId);
      if (existing?.terminal) continue;
      if (existing && record.sequence <= existing.sequence) continue;
      const state = existing ?? this.createRun(record);
      this.apply(state, record);
    }
    const reason =
      "The process ended before this child run reported a terminal record; it is shown as interrupted and is not resumed.";
    for (const state of this.runs.values()) this.settleInterrupted(state, reason);
  }

  async close(reason?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const description =
      reason?.trim() ||
      "The parent session closed while this child run was still active; the run was not resumed.";
    for (const state of this.runs.values()) this.settleInterrupted(state, description);
    await this.journal.close();
  }
}

function terminalNoticeTitle(outcome: SubpiBridgeOutcome): string {
  switch (outcome) {
    case "completed":
      return "Child run completed";
    case "steered":
      return "Child run wrapped up at its turn limit";
    case "canceled":
      return "Child run was canceled";
    case "failed":
      return "Child run failed";
  }
}

function timelineRecordForActivity(activity: SubpiActivityRecord): Record<string, unknown> {
  switch (activity.kind) {
    case "message_start":
      return { type: "message_start", message: activity.message };
    case "message_update":
      return {
        type: "message_update",
        message: activity.message,
        assistantMessageEvent: activity.assistantMessageEvent,
        usage: activity.usage,
      };
    case "message_end":
      return { type: "message_end", message: activity.message };
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: activity.toolCallId,
        toolName: activity.toolName,
        args: activity.args,
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        toolCallId: activity.toolCallId,
        toolName: activity.toolName,
        args: activity.args,
        partialResult: activity.partialResult,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolCallId: activity.toolCallId,
        toolName: activity.toolName,
        isError: activity.isError,
        result: activity.result,
      };
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
  }
}

// The capability constant is imported for documentation/validation parity with
// session.ts. Child sessions advertise it so a depth-enabled child can itself
// parent grandchildren without the host rejecting the nested open.

export async function createSubagentObserver(
  options: CreateSubagentObserverOptions,
): Promise<SubagentObserver> {
  const journal = await openChildJournal(options.directory);
  const observer = new SubagentObserverImpl(options, journal);
  if (options.restore) {
    try {
      await observer.restore();
    } catch (error) {
      await observer.close("Child journal restore failed.").catch(() => undefined);
      throw error;
    }
  }
  return observer;
}
