import { z } from "zod";

/**
 * Shared contract for the owned pi-subagents child bridge.
 *
 * The `pi-subagents` extension emits one versioned record per child lifecycle
 * event on its in-process `pi.events` bus. The Superpi companion serializes each
 * record into a `ctx.ui.notify` envelope whose message text is
 * `superpi:child:v1:<json>`, where `<json>` is `{ version: 1, sessionKey,
 * record }`. `session.ts` unwraps that envelope, filters records whose
 * `sessionKey` does not match the live root session, and hands the raw bridge
 * record to the observer. Envelope and record parsing live here so client and
 * server agree on one shape.
 *
 * This module is pure data: no filesystem, process, or React Native access.
 */

/** Prefix of the companion notification that carries a child bridge record. */
export const SUBPI_CHILD_CHANNEL_PREFIX = "superpi:child:v1:";

/** Envelope and record schema versions. */
export const SUBPI_CHILD_ENVELOPE_VERSION = 1 as const;
export const SUBPI_BRIDGE_VERSION = 1 as const;

/**
 * Host capability that lets a provider session open direct children. The root
 * session advertises it, and every observer child advertises it too because the
 * owned extension loads itself into each child and an operator depth ceiling may
 * permit nesting. It is the only capability an observer child advertises; child
 * tracks stay read-only for prompt, permission, archive, and revert work.
 */
export const SUBPI_SUBSESSION_CAPABILITY = "session.subsession";

/** Stable provider-session id namespace for restored/live child tracks. */
export const SUBPI_CHILD_SESSION_PREFIX = "superpi-child:";

/** Stable turn id namespace for a child run. */
export const SUBPI_CHILD_TURN_PREFIX = "superpi-child-turn:";

export const subpiActivityKindSchema = z.enum([
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "turn_start",
  "turn_end",
]);

/** Bounded projection of one live child session event, as emitted by the bridge. */
export const subpiActivityRecordSchema = z
  .object({
    kind: subpiActivityKindSchema,
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    isError: z.boolean().optional(),
    parentToolCallId: z.string().optional(),
    message: z.unknown().optional(),
    assistantMessageEvent: z.unknown().optional(),
    usage: z.unknown().optional(),
    args: z.unknown().optional(),
    partialResult: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .strip();

export const subpiOutcomeSchema = z.enum([
  "completed",
  "steered",
  "canceled",
  "failed",
]);

/**
 * One versioned bridge record. `omitted`/`omittedBytes` mark a payload that
 * exceeded the per-record cap; identity and `transcriptPath` are retained, and
 * terminal outcome/reason/result are retained so the omission is explicit and
 * never hides the final outcome.
 */
export const subpiBridgeRecordSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1),
    sequence: z.number().int().positive(),
    type: z.enum(["created", "activity", "terminal"]),
    parentRunId: z.string().optional(),
    parentSessionId: z.string().optional(),
    childSessionId: z.string().optional(),
    toolCallId: z.string().optional(),
    title: z.string().optional(),
    timestamp: z.number().optional(),
    transcriptPath: z.string().optional(),
    /** Actual child working directory, when the extension knows it. */
    cwd: z.string().optional(),
    /** Activity payload for `type: "activity"`; absent for created/terminal. */
    record: z.unknown().optional(),
    outcome: subpiOutcomeSchema.optional(),
    result: z.unknown().optional(),
    reason: z.string().optional(),
    omitted: z.boolean().optional(),
    omittedBytes: z.number().int().nonnegative().optional(),
  })
  .strip();

export const subpiChildEnvelopeSchema = z
  .object({
    version: z.literal(1),
    sessionKey: z.string(),
    record: subpiBridgeRecordSchema,
  })
  .strip();

export type SubpiActivityKind = z.infer<typeof subpiActivityKindSchema>;
export type SubpiActivityRecord = z.infer<typeof subpiActivityRecordSchema>;
export type SubpiBridgeOutcome = z.infer<typeof subpiOutcomeSchema>;
export type SubpiBridgeType = z.infer<typeof subpiBridgeRecordSchema>["type"];
export type SubpiBridgeRecord = z.infer<typeof subpiBridgeRecordSchema>;
export type SubpiChildEnvelope = z.infer<typeof subpiChildEnvelopeSchema>;

export function childSessionIdForRun(runId: string): string {
  return `${SUBPI_CHILD_SESSION_PREFIX}${runId}`;
}

export function childTurnIdForRun(runId: string): string {
  return `${SUBPI_CHILD_TURN_PREFIX}${runId}`;
}

/**
 * Host turn state for a bridge outcome. `steered` is the extension's soft
 * turn-limit wrap-up; the host has no steered turn state, so it is reported as
 * completed and the native reason travels in a child notice.
 */
export function childOutcomeToTurnState(
  outcome: SubpiBridgeOutcome,
): "completed" | "canceled" | "failed" {
  switch (outcome) {
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "completed";
  }
}

/**
 * Parse a companion `notify` message into a validated child envelope. Returns
 * `undefined` for ordinary notifications, malformed JSON, wrong versions, or
 * unknown record shapes. Session-key matching stays with the caller so one
 * helper cannot silently accept another root session's records.
 */
export function parseSubpiChildEnvelope(message: unknown): SubpiChildEnvelope | undefined {
  if (typeof message !== "string" || !message.startsWith(SUBPI_CHILD_CHANNEL_PREFIX)) {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(message.slice(SUBPI_CHILD_CHANNEL_PREFIX.length));
  } catch {
    return undefined;
  }
  const parsed = subpiChildEnvelopeSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
