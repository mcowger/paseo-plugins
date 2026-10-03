import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  subpiBridgeRecordSchema,
  type SubpiBridgeRecord,
} from "../shared/subagents.js";

/**
 * Durable, append-only child journal.
 *
 * The journal is the recovery authority for child lifecycle and finalized
 * activity that is not present in the root Pi JSONL: one JSON record per line at
 * `<store.directory>/child-journal.jsonl`, private `0700` directory and `0600`
 * file. Appends are serialized so concurrent callers cannot interleave a line,
 * and terminal records are fsynced before the caller publishes them.
 *
 * Records larger than `CHILD_JOURNAL_MAX_RECORD_BYTES` are rewritten into an
 * explicit omission record that keeps run/sequence identity and, for terminals,
 * the outcome, reason, and a bounded result. Loading streams the file
 * incrementally and never applies a lifetime/prefix row or byte cutoff, so a
 * tail after hundreds of items or megabytes remains recoverable.
 */

export const CHILD_JOURNAL_FILE = "child-journal.jsonl";
export const CHILD_JOURNAL_DIRECTORY_MODE = 0o700;
export const CHILD_JOURNAL_FILE_MODE = 0o600;
export const CHILD_JOURNAL_MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const CHILD_JOURNAL_MAX_RETAINED_RESULT_BYTES = 64 * 1024;

export type ChildJournalEntry =
  | { kind: "record"; record: SubpiBridgeRecord }
  | { kind: "omission"; omittedBytes: number };

export interface ChildJournal {
  readonly filePath: string;
  /** Append without forcing a disk flush; safe to coalesce across activity. */
  append(record: SubpiBridgeRecord): Promise<void>;
  /** Append and fsync; used for records the caller is about to publish. */
  appendDurable(record: SubpiBridgeRecord): Promise<void>;
  /** Stream every retained record in append order. */
  entries(): AsyncGenerator<ChildJournalEntry>;
  /** Flush pending appends and close the file; idempotent. */
  close(): Promise<void>;
}

function retainResult(value: unknown): unknown {
  if (value === undefined) return null;
  let text: string;
  try {
    const json = JSON.stringify(value);
    text = json === undefined ? String(value) : json;
  } catch {
    text = String(value);
  }
  if (Buffer.byteLength(text) <= CHILD_JOURNAL_MAX_RETAINED_RESULT_BYTES) return value;
  return `${text.slice(0, CHILD_JOURNAL_MAX_RETAINED_RESULT_BYTES)}\n…[result truncated; ${Buffer.byteLength(text)} bytes total]`;
}

function omitRecord(record: SubpiBridgeRecord, omittedBytes: number): SubpiBridgeRecord {
  const omitted: SubpiBridgeRecord = {
    version: record.version,
    runId: record.runId,
    sequence: record.sequence,
    type: record.type,
    omitted: true,
    omittedBytes,
  };
  if (record.parentRunId !== undefined) omitted.parentRunId = record.parentRunId;
  if (record.parentSessionId !== undefined) omitted.parentSessionId = record.parentSessionId;
  if (record.childSessionId !== undefined) omitted.childSessionId = record.childSessionId;
  if (record.toolCallId !== undefined) omitted.toolCallId = record.toolCallId;
  if (record.title !== undefined) omitted.title = record.title;
  if (record.timestamp !== undefined) omitted.timestamp = record.timestamp;
  if (record.transcriptPath !== undefined) omitted.transcriptPath = record.transcriptPath;
  if (record.type === "terminal") {
    if (record.outcome !== undefined) omitted.outcome = record.outcome;
    if (record.reason !== undefined) omitted.reason = record.reason;
    omitted.result = retainResult(record.result);
  }
  return omitted;
}

/** Serialize one record to a single bounded NDJSON line. */
export function serializeChildJournalLine(record: SubpiBridgeRecord): string {
  const line = JSON.stringify(record);
  const bytes = Buffer.byteLength(line);
  if (bytes <= CHILD_JOURNAL_MAX_RECORD_BYTES) return line;
  return JSON.stringify(omitRecord(record, bytes));
}

function parseLine(line: string): ChildJournalEntry | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  const parsed = subpiBridgeRecordSchema.safeParse(json);
  if (!parsed.success) return undefined;
  return { kind: "record", record: parsed.data };
}

class ChildJournalFile implements ChildJournal {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    readonly filePath: string,
    private readonly handle: FileHandle,
  ) {}

  append(record: SubpiBridgeRecord): Promise<void> {
    return this.enqueue(record, false);
  }

  appendDurable(record: SubpiBridgeRecord): Promise<void> {
    return this.enqueue(record, true);
  }

  private enqueue(record: SubpiBridgeRecord, durable: boolean): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Child journal is closed"));
    const operation = this.queue.then(() => this.write(record, durable));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async write(record: SubpiBridgeRecord, durable: boolean): Promise<void> {
    await this.handle.write(`${serializeChildJournalLine(record)}\n`);
    if (durable) await this.handle.sync();
  }

  async *entries(): AsyncGenerator<ChildJournalEntry> {
    let stream: ReturnType<typeof createReadStream>;
    try {
      stream = createReadStream(this.filePath, { encoding: "utf8" });
    } catch {
      return;
    }
    let buffer = "";
    let skipping = false;
    let skippedBytes = 0;
    try {
      for await (const chunk of stream) {
        buffer += chunk as string;
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) {
            if (Buffer.byteLength(buffer) > CHILD_JOURNAL_MAX_RECORD_BYTES) {
              skippedBytes += Buffer.byteLength(buffer);
              buffer = "";
              skipping = true;
            }
            break;
          }
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (skipping) {
            skippedBytes += Buffer.byteLength(line);
            skipping = false;
            yield { kind: "omission", omittedBytes: skippedBytes };
            skippedBytes = 0;
            continue;
          }
          const entry = parseLine(line);
          if (entry) yield entry;
        }
      }
      if (skipping) {
        yield { kind: "omission", omittedBytes: skippedBytes + Buffer.byteLength(buffer) };
      } else if (buffer.trim().length > 0) {
        const entry = parseLine(buffer);
        if (entry) yield entry;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    } finally {
      stream.destroy();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.catch(() => undefined);
    await this.handle.close();
  }
}

/**
 * A crash can leave a torn final line with no newline. Appending the next
 * record directly would concatenate it onto that fragment, making one
 * unparseable line and losing the first record written after the crash.
 * Terminate the fragment first; it is then ignored as malformed while every
 * later record stays recoverable.
 */
async function terminateTornLine(handle: FileHandle, filePath: string): Promise<void> {
  const { size } = await handle.stat();
  if (size === 0) return;
  const lastByte = Buffer.alloc(1);
  // Append handles are write-only on some platforms, so read through a
  // separate descriptor opened for reading.
  const reader = await fs.open(filePath, "r");
  try {
    const { bytesRead } = await reader.read(lastByte, 0, 1, size - 1);
    if (bytesRead === 1 && lastByte[0] !== 0x0a) await handle.write("\n");
  } finally {
    await reader.close();
  }
}

/** Open (creating if needed) the private child journal under `directory`. */
export async function openChildJournal(directory: string): Promise<ChildJournal> {
  await fs.mkdir(directory, { recursive: true, mode: CHILD_JOURNAL_DIRECTORY_MODE });
  await fs.chmod(directory, CHILD_JOURNAL_DIRECTORY_MODE);
  const filePath = path.join(directory, CHILD_JOURNAL_FILE);
  const handle = await fs.open(filePath, "a", CHILD_JOURNAL_FILE_MODE);
  try {
    await handle.chmod(CHILD_JOURNAL_FILE_MODE);
  } catch {
    // Older platforms may not support chmod on an open handle; the open mode still applies.
  }
  await terminateTornLine(handle, filePath);
  return new ChildJournalFile(filePath, handle);
}
