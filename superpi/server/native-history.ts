import { createReadStream } from "node:fs";
import { z } from "zod";

/**
 * Native Pi session-tree access for active-branch history and rewind tokens.
 *
 * Paseo's provider contract has no history reset/replace event, and its live
 * adapter history is append-only. The plugin therefore owns the correctness of
 * its own active-branch projection: it asks Pi for the public `get_entries`
 * result (`{ entries, leafId }`) and walks `parentId` from the active leaf to
 * the root. Append order is intentionally ignored because it also contains
 * abandoned branches.
 *
 * Rewind tokens are opaque host values bound to the owned session and to a
 * target Pi user entry. The token is attached to the `user_message` timeline
 * row; the host returns it on `session.revert`. A token is only resolved when
 * its namespace (`version`) and owner match the current owned store, and the
 * target is re-validated against the live active branch before any navigation.
 *
 * This module is pure data. It performs no I/O and imports no Pi internals.
 */

/** Versioned opaque rewind token, persisted by the host on a user timeline row. */
export const rewindTokenSchema = z.strictObject({
  version: z.literal(1),
  owner: z.string().min(1),
  entryId: z.string().min(1),
});
export type RewindToken = z.infer<typeof rewindTokenSchema>;

/** Structural view of a Pi session entry; only tree/history fields are read. */
export interface NativeSessionEntry {
  id: string;
  parentId?: string | null;
  type?: string;
  timestamp?: unknown;
  message?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function idText(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Normalize the public `get_entries` array into usable entries. */
export function parseNativeEntries(value: unknown): NativeSessionEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: NativeSessionEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : undefined;
    if (!id) continue;
    entries.push({
      ...(raw as { id: string }),
      id,
      ...(raw.parentId === null || typeof raw.parentId === "string"
        ? { parentId: raw.parentId as string | null }
        : {}),
      ...(typeof raw.type === "string" ? { type: raw.type } : {}),
      ...(raw.timestamp !== undefined ? { timestamp: raw.timestamp } : {}),
      ...(isRecord(raw.message) ? { message: raw.message } : {}),
    });
  }
  return entries;
}

/**
 * Walk `parentId` from `leafId` to the root and return entries in root→leaf
 * order. Unknown links stop the walk rather than fabricating history.
 */
export function activeBranchEntries(
  entries: readonly NativeSessionEntry[],
  leafId: string | null | undefined,
): NativeSessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain: NativeSessionEntry[] = [];
  const seen = new Set<string>();
  let current = idText(leafId);
  while (current && !seen.has(current)) {
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) break;
    chain.push(entry);
    current = typeof entry.parentId === "string" ? entry.parentId : undefined;
  }
  chain.reverse();
  return chain;
}

/** A message entry whose role is `user`. */
export function isUserMessageEntry(entry: NativeSessionEntry): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

/**
 * Timeline identity for a user entry. Matches the pure timeline's user id
 * (`user:<timestamp>`) so a later refresh updates the same row instead of
 * creating a duplicate.
 */
export function userTimelineItemId(entry: NativeSessionEntry): string | undefined {
  const timestamp = idText(entry.message?.timestamp) ?? idText(entry.timestamp);
  return timestamp ? `user:${timestamp}` : undefined;
}

/** Build the versioned token for one user entry. */
export function createRewindToken(owner: string, entryId: string): RewindToken {
  return { version: 1, owner, entryId };
}

/**
 * Resolve a host-supplied token against the owned session. Returns the target
 * entry id only when the namespace and owner match; entry existence is checked
 * separately against the live active branch.
 */
export function resolveRewindToken(token: unknown, owner: string): string | undefined {
  const parsed = rewindTokenSchema.safeParse(token);
  if (!parsed.success) return undefined;
  if (parsed.data.owner !== owner) return undefined;
  return parsed.data.entryId;
}

/** Active-branch user entry matching `targetEntryId`, or undefined. */
export function findActiveBranchUserEntry(
  entries: readonly NativeSessionEntry[],
  leafId: string | null | undefined,
  targetEntryId: string,
): NativeSessionEntry | undefined {
  return activeBranchEntries(entries, leafId).find(
    (entry) => entry.id === targetEntryId && isUserMessageEntry(entry),
  );
}

/**
 * Map every active-branch user timeline id to its rewind token. Called before
 * initial replay and after each settled turn so the same item ids receive the
 * same tokens.
 */
/**
 * Map every active-branch user timeline id to its rewind token. Called before
 * initial replay and after each settled turn so the same item ids receive the
 * same tokens.
 */
export function buildActiveUserTokenMap(
  entries: readonly NativeSessionEntry[],
  leafId: string | null | undefined,
  owner: string,
): Map<string, RewindToken> {
  const tokens = new Map<string, RewindToken>();
  for (const entry of activeBranchEntries(entries, leafId)) {
    if (!isUserMessageEntry(entry)) continue;
    const itemId = userTimelineItemId(entry);
    if (!itemId) continue;
    tokens.set(itemId, createRewindToken(owner, entry.id));
  }
  return tokens;
}

/**
 * Streamed view of the owned native Pi transcript (`.jsonl`).
 *
 * Pi's `get_entries`/`get_messages` return the whole lifetime tree in one RPC
 * frame, so a large session can exceed the transport frame budget and kill the
 * session on open or after a turn. Reading the authorized transcript directly
 * avoids that: a first streaming pass builds a minimal `id`/`parentId` index
 * (plus user timestamps), and a second streaming pass yields the active-branch
 * message payloads. Nothing is truncated by size.
 */
export interface PiTranscriptSnapshot {
  /** True when the file started with a recognizable Pi session header. */
  hasHeader: boolean;
  /** Session format version from the header, when present. */
  version: number | undefined;
  /** Minimal index of every entry in append order. */
  entries: NativeSessionEntry[];
  /** Last entry in the file, which Pi treats as the active leaf on load. */
  leafId: string | undefined;
  /** Active-branch entries in root→leaf order. */
  activeEntries: NativeSessionEntry[];
}

interface TranscriptRecord {
  id: string;
  parentId: string | null;
  type: string | undefined;
  timestamp: unknown;
  userTimestamp: unknown;
  role: string | undefined;
}

function transcriptRecord(raw: Record<string, unknown>): TranscriptRecord | undefined {
  if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
  const message = isRecord(raw.message) ? raw.message : undefined;
  const role = message && typeof message.role === "string" ? message.role : undefined;
  return {
    id: raw.id,
    parentId: raw.parentId === null || typeof raw.parentId === "string" ? raw.parentId : null,
    type: typeof raw.type === "string" ? raw.type : undefined,
    timestamp: raw.timestamp,
    userTimestamp: role === "user" ? message?.timestamp : undefined,
    role,
  };
}

/**
 * Iterate newline-delimited records without buffering the whole file. A final
 * fragment lacking a newline is parsed too: it is either a complete trailing
 * record or an in-progress append that fails JSON parsing and is skipped.
 */
async function forEachTranscriptLine(
  filePath: string,
  onLine: (line: string) => void,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  let buffer = "";
  const emit = (line: string): void => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  try {
    for await (const chunk of stream) {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        emit(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    }
  } finally {
    stream.destroy();
  }
  if (buffer.length > 0) emit(buffer);
}

/** Build the minimal active-branch index for a native Pi transcript file. */
export async function readPiTranscriptSnapshot(filePath: string): Promise<PiTranscriptSnapshot> {
  let hasHeader = false;
  let version: number | undefined;
  const entries: NativeSessionEntry[] = [];
  let leafId: string | undefined;
  await forEachTranscriptLine(filePath, (line) => {
    if (line.length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(raw)) return;
    if (raw.type === "session") {
      hasHeader = true;
      version = typeof raw.version === "number" ? raw.version : 1;
      return;
    }
    const record = transcriptRecord(raw);
    if (!record) return;
    entries.push({
      id: record.id,
      parentId: record.parentId,
      ...(record.type !== undefined ? { type: record.type } : {}),
      ...(record.timestamp !== undefined ? { timestamp: record.timestamp } : {}),
      ...(record.role === "user"
        ? {
            message: {
              role: record.role,
              ...(record.userTimestamp !== undefined ? { timestamp: record.userTimestamp } : {}),
            },
          }
        : {}),
    });
    leafId = record.id;
  });
  return {
    hasHeader,
    version,
    entries,
    leafId,
    activeEntries: activeBranchEntries(entries, leafId),
  };
}

/**
 * Second streaming pass over the transcript, returning active-branch message
 * payloads in active order and applying the latest `context_edit` per target.
 */
export async function readPiTranscriptMessages(
  filePath: string,
  activeEntries: readonly NativeSessionEntry[],
): Promise<unknown[]> {
  const activeIds = new Set(activeEntries.map((entry) => entry.id));
  const messages = new Map<string, Record<string, unknown>>();
  const edits = new Map<string, unknown>();
  await forEachTranscriptLine(filePath, (line) => {
    if (line.length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(raw) || typeof raw.id !== "string" || !activeIds.has(raw.id)) return;
    if (raw.type === "context_edit" && typeof raw.targetId === "string") {
      edits.set(raw.targetId, raw.replacement);
      return;
    }
    if (raw.type === "message" && isRecord(raw.message)) messages.set(raw.id, raw.message);
  });
  const projected: unknown[] = [];
  for (const entry of activeEntries) {
    const message = messages.get(entry.id);
    if (!message) continue;
    const edited = applyContextEdit(message, edits.get(entry.id));
    if (edited) projected.push(edited);
  }
  return projected;
}

function applyContextEdit(
  message: Record<string, unknown>,
  replacement: unknown,
): Record<string, unknown> | null {
  if (replacement === undefined) return message;
  if (replacement === null) return null;
  const role = message.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "custom") {
    return message;
  }
  if (!isRecord(replacement) || replacement.content === undefined) return message;
  const content = replacement.content;
  const normalized =
    (role === "assistant" || role === "toolResult") && typeof content === "string"
      ? [{ type: "text", text: content }]
      : content;
  return { ...message, content: normalized };
}
