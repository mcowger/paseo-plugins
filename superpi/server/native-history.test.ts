import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeBranchEntries,
  buildActiveUserTokenMap,
  createRewindToken,
  findActiveBranchUserEntry,
  isUserMessageEntry,
  parseNativeEntries,
  readPiTranscriptMessages,
  readPiTranscriptSnapshot,
  resolveRewindToken,
  userTimelineItemId,
} from "./native-history.js";

function entry(
  id: string,
  parentId: string | null,
  role?: string,
  timestamp?: number,
): Record<string, unknown> {
  return {
    id,
    parentId,
    type: role ? "message" : "custom",
    ...(role ? { message: { role, ...(timestamp !== undefined ? { timestamp } : {}) } } : {}),
  };
}

describe("parseNativeEntries", () => {
  it("keeps only entries with a usable string id and strips unknown shapes", () => {
    const parsed = parseNativeEntries([
      entry("u1", null, "user", 1),
      { id: 5 },
      null,
      "nope",
      { parentId: "u1" },
    ]);
    expect(parsed.map((value) => value.id)).toEqual(["u1"]);
  });
});

describe("activeBranchEntries", () => {
  it("walks parentId from the leaf to the root in root->leaf order", () => {
    const entries = parseNativeEntries([
      entry("root", null, "user", 1),
      entry("mid", "root", "assistant", 2),
      entry("leaf", "mid", "user", 3),
      entry("abandoned", "root", "assistant", 4),
    ]);
    expect(activeBranchEntries(entries, "leaf").map((value) => value.id)).toEqual([
      "root",
      "mid",
      "leaf",
    ]);
  });

  it("returns an empty chain for an unknown leaf and stops on cycles", () => {
    const entries = parseNativeEntries([entry("a", "b", "user", 1), entry("b", "a", "user", 2)]);
    expect(activeBranchEntries(entries, "missing")).toEqual([]);
    expect(activeBranchEntries(entries, "a").map((value) => value.id)).toEqual(["b", "a"]);
  });
});

describe("user entry helpers", () => {
  it("identifies user messages and builds the matching timeline id", () => {
    const user = parseNativeEntries([entry("u1", null, "user", 42)])[0]!;
    const assistant = parseNativeEntries([entry("a1", "u1", "assistant", 43)])[0]!;
    expect(isUserMessageEntry(user)).toBe(true);
    expect(isUserMessageEntry(assistant)).toBe(false);
    expect(userTimelineItemId(user)).toBe("user:42");
    expect(userTimelineItemId(assistant)).toBe("user:43");
  });

  it("finds only active-branch user entries", () => {
    const entries = parseNativeEntries([
      entry("root", null, "user", 1),
      entry("mid", "root", "assistant", 2),
      entry("abandoned", "root", "user", 3),
    ]);
    expect(findActiveBranchUserEntry(entries, "mid", "root")?.id).toBe("root");
    expect(findActiveBranchUserEntry(entries, "mid", "abandoned")).toBeUndefined();
    expect(findActiveBranchUserEntry(entries, "mid", "mid")).toBeUndefined();
  });
});

describe("rewind tokens", () => {
  it("resolves only when the version and owner match", () => {
    const token = createRewindToken("owner-1", "u1");
    expect(resolveRewindToken(token, "owner-1")).toBe("u1");
    expect(resolveRewindToken(token, "owner-2")).toBeUndefined();
    expect(resolveRewindToken({ version: 2, owner: "owner-1", entryId: "u1" }, "owner-1")).toBeUndefined();
    expect(resolveRewindToken(null, "owner-1")).toBeUndefined();
    expect(resolveRewindToken("nope", "owner-1")).toBeUndefined();
  });

  it("maps every active user timeline id to its token", () => {
    const entries = parseNativeEntries([
      entry("root", null, "user", 1),
      entry("mid", "root", "assistant", 2),
      entry("leaf", "mid", "user", 3),
      entry("abandoned", "root", "user", 4),
    ]);
    const tokens = buildActiveUserTokenMap(entries, "leaf", "owner-1");
    expect([...tokens.keys()]).toEqual(["user:1", "user:3"]);
    expect(tokens.get("user:1")).toEqual({ version: 1, owner: "owner-1", entryId: "root" });
    expect(tokens.has("user:4")).toBe(false);
  });
});

describe("streamed native transcript", () => {
  async function withFile(lines: unknown[], run: (file: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "superpi-transcript-"));
    const file = path.join(dir, "session.jsonl");
    await fs.writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    try {
      await run(file);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  const header = { type: "session", version: 3, id: "native-1", cwd: "/workspace" };

  it("builds a minimal index and yields only active-branch messages", async () => {
    await withFile(
      [
        header,
        { type: "message", id: "u1", parentId: null, timestamp: "t1", message: { role: "user", timestamp: 1, content: "one" } },
        { type: "message", id: "a1", parentId: "u1", timestamp: "t2", message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "two" }] } },
        { type: "message", id: "abandoned", parentId: "u1", timestamp: "t3", message: { role: "assistant", timestamp: 3, content: [{ type: "text", text: "gone" }] } },
        { type: "message", id: "u2", parentId: "a1", timestamp: "t4", message: { role: "user", timestamp: 4, content: "four" } },
      ],
      async (file) => {
        const snapshot = await readPiTranscriptSnapshot(file);
        expect(snapshot.hasHeader).toBe(true);
        expect(snapshot.version).toBe(3);
        expect(snapshot.leafId).toBe("u2");
        expect(snapshot.activeEntries.map((entry) => entry.id)).toEqual(["u1", "a1", "u2"]);
        const messages = await readPiTranscriptMessages(file, snapshot.activeEntries);
        expect(messages.map((message) => (message as { timestamp: number }).timestamp)).toEqual([1, 2, 4]);
      },
    );
  });

  it("flags a legacy v1 header so callers can fall back to RPC", async () => {
    await withFile([{ type: "session", version: 1, id: "native-1" }], async (file) => {
      const snapshot = await readPiTranscriptSnapshot(file);
      expect(snapshot.hasHeader).toBe(true);
      expect(snapshot.version).toBe(1);
    });
  });

  it("reports a missing header so callers do not trust an unrelated file", async () => {
    await withFile([{ role: "user" }], async (file) => {
      const snapshot = await readPiTranscriptSnapshot(file);
      expect(snapshot.hasHeader).toBe(false);
      expect(snapshot.entries).toEqual([]);
    });
  });

  it("applies the latest context_edit to an active message", async () => {
    await withFile(
      [
        header,
        { type: "message", id: "u1", parentId: null, timestamp: "t1", message: { role: "user", timestamp: 1, content: "one" } },
        { type: "context_edit", id: "e1", parentId: "u1", timestamp: "t2", targetId: "u1", replacement: { content: [{ type: "text", text: "edited" }] } },
      ],
      async (file) => {
        const snapshot = await readPiTranscriptSnapshot(file);
        const messages = await readPiTranscriptMessages(file, snapshot.activeEntries);
        expect(messages).toEqual([{ role: "user", timestamp: 1, content: [{ type: "text", text: "edited" }] }]);
      },
    );
  });
});
