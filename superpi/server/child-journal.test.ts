import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHILD_JOURNAL_FILE,
  CHILD_JOURNAL_MAX_RECORD_BYTES,
  openChildJournal,
} from "./child-journal.js";
import type { SubpiBridgeRecord } from "../shared/subagents.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "superpi-child-journal-"));
  directories.push(directory);
  return directory;
}

function activity(runId: string, sequence: number, result?: unknown): SubpiBridgeRecord {
  return {
    version: 1,
    runId,
    sequence,
    type: "activity",
    record: { kind: "tool_execution_end", toolCallId: "call-1", toolName: "read", result },
  };
}

describe("child journal", () => {
  it("creates a private directory and file and round-trips records in order", async () => {
    const directory = await fixture();
    const journal = await openChildJournal(directory);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(journal.filePath)).mode & 0o777).toBe(0o600);
    expect(path.basename(journal.filePath)).toBe(CHILD_JOURNAL_FILE);

    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await journal.append(activity("run-1", sequence, { sequence }));
    }
    await journal.close();

    const records: SubpiBridgeRecord[] = [];
    const reader = await openChildJournal(directory);
    for await (const entry of reader.entries()) {
      if (entry.kind === "record") records.push(entry.record);
    }
    await reader.close();
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("serializes concurrent appends without interleaving lines", async () => {
    const directory = await fixture();
    const journal = await openChildJournal(directory);
    await Promise.all(
      Array.from({ length: 40 }, (_, index) => journal.append(activity("run-2", index + 1, index))),
    );
    await journal.close();

    const lines = (await fs.readFile(path.join(directory, CHILD_JOURNAL_FILE), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(40);
    expect(lines.map((line) => (JSON.parse(line) as SubpiBridgeRecord).sequence)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
  });

  it("omits an oversized payload explicitly and retains the terminal outcome and result", async () => {
    const directory = await fixture();
    const journal = await openChildJournal(directory);
    const huge = "x".repeat(CHILD_JOURNAL_MAX_RECORD_BYTES + 1024);
    await journal.append(activity("run-3", 1, huge));
    await journal.appendDurable({
      version: 1,
      runId: "run-3",
      sequence: 2,
      type: "terminal",
      outcome: "canceled",
      reason: "user stopped the child",
      result: huge,
    });
    await journal.close();

    const records: SubpiBridgeRecord[] = [];
    const reader = await openChildJournal(directory);
    for await (const entry of reader.entries()) {
      if (entry.kind === "record") records.push(entry.record);
    }
    await reader.close();

    expect(records.map((record) => record.sequence)).toEqual([1, 2]);
    const omittedActivity = records[0];
    expect(omittedActivity.omitted).toBe(true);
    expect(omittedActivity.omittedBytes).toBeGreaterThan(CHILD_JOURNAL_MAX_RECORD_BYTES);
    expect(omittedActivity.record).toBeUndefined();

    const omittedTerminal = records[1];
    expect(omittedTerminal.omitted).toBe(true);
    expect(omittedTerminal.outcome).toBe("canceled");
    expect(omittedTerminal.reason).toBe("user stopped the child");
    expect(typeof omittedTerminal.result).toBe("string");
    expect(omittedTerminal.result as string).toContain("result truncated");
  });

  it("streams more than 200 records and a multi-megabyte tail without a prefix cutoff", async () => {
    const directory = await fixture();
    const journal = await openChildJournal(directory);
    const text = "y".repeat(12 * 1024);
    for (let sequence = 1; sequence <= 240; sequence += 1) {
      await journal.append(
        activity("run-4", sequence, { text, sequence }),
      );
    }
    await journal.close();
    expect((await fs.stat(path.join(directory, CHILD_JOURNAL_FILE))).size).toBeGreaterThan(
      2 * 1024 * 1024,
    );

    const reader = await openChildJournal(directory);
    let count = 0;
    let last: SubpiBridgeRecord | undefined;
    for await (const entry of reader.entries()) {
      if (entry.kind === "record") {
        count += 1;
        last = entry.record;
      }
    }
    await reader.close();
    expect(count).toBe(240);
    expect(last?.sequence).toBe(240);
  });

  it("ignores malformed lines", async () => {
    const directory = await fixture();
    await fs.writeFile(path.join(directory, CHILD_JOURNAL_FILE), "not json\n{}\n");
    const reader = await openChildJournal(directory);
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    await reader.close();
    expect(entries).toEqual([]);
  });

  it("terminates a torn final line so the next record after a crash is recovered", async () => {
    const directory = await fixture();
    const filePath = path.join(directory, CHILD_JOURNAL_FILE);
    // A crash can leave a partial final line without a trailing newline.
    const partial = '{"version":1,"runId":"run-crash","sequence":1,"type":"cre';
    await fs.writeFile(filePath, partial);

    const journal = await openChildJournal(directory);
    await journal.appendDurable({
      version: 1,
      runId: "run-crash",
      sequence: 2,
      type: "terminal",
      outcome: "completed",
      result: "recovered terminal",
    });
    await journal.close();

    // The fragment is separated from the next record instead of swallowing it.
    const raw = await fs.readFile(filePath, "utf8");
    expect(raw.startsWith(`${partial}\n`)).toBe(true);

    const records: SubpiBridgeRecord[] = [];
    const reader = await openChildJournal(directory);
    for await (const entry of reader.entries()) {
      if (entry.kind === "record") records.push(entry.record);
    }
    await reader.close();
    expect(records.map((record) => [record.sequence, record.type])).toEqual([[2, "terminal"]]);
    expect(records[0].result).toBe("recovered terminal");
  });
});
