import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isValidSessionId,
  listHistory,
  normalizeOcrEnvelope,
  runReviewJson,
  sessionComments,
  showSession,
} from "./ocr.js";

const previousBin = process.env.OCR_BIN;

afterEach(() => {
  if (previousBin === undefined) {
    delete process.env.OCR_BIN;
  } else {
    process.env.OCR_BIN = previousBin;
  }
});

function successEnvelope() {
  return {
    status: "success",
    sessionId: "sess-abc123",
    comments: [
      {
        path: "src/a.ts",
        content: "Avoid any",
        startLine: 10,
        endLine: 12,
        severity: "high",
        category: "correctness",
      },
      {
        path: "src/a.ts",
        content: "Avoid any",
        startLine: 10,
        endLine: 12,
        severity: "high",
        category: "correctness",
      },
      { path: "src/b.ts", content: "Naming", startLine: 1, endLine: 1, severity: "weird" },
    ],
    warnings: ["slow model"],
    counts: { filesReviewed: 3 },
  };
}

describe("normalizeOcrEnvelope", () => {
  it("maps success with findings to complete with deterministic ids", () => {
    const first = normalizeOcrEnvelope(successEnvelope());
    const second = normalizeOcrEnvelope(successEnvelope());
    expect(first.status).toBe("complete");
    expect(first.sessionId).toBe("sess-abc123");
    expect(first.findings).toHaveLength(3);
    expect(first.findings.map((finding) => finding.id)).toEqual(
      second.findings.map((finding) => finding.id),
    );
    // Duplicate canonical fields get distinct deterministic ids.
    expect(first.findings[0].id).not.toBe(first.findings[1].id);
    // Unknown severity normalizes to unspecified, never guessed.
    expect(first.findings[2].severity).toBe("unspecified");
    expect(first.warnings).toEqual(["slow model"]);
    expect(first.counts.filesReviewed).toBe(3);
  });

  it("maps success without findings to complete with empty findings", () => {
    const normalized = normalizeOcrEnvelope({ status: "success", sessionId: "s1", comments: [] });
    expect(normalized.status).toBe("complete");
    expect(normalized.findings).toEqual([]);
  });

  it("maps skipped status", () => {
    const normalized = normalizeOcrEnvelope({ status: "skipped", sessionId: "s1", comments: [] });
    expect(normalized.status).toBe("skipped");
  });

  it("maps warning/error and manifest failed terminals to partial", () => {
    expect(
      normalizeOcrEnvelope({ status: "completed_with_warnings", comments: [] }).status,
    ).toBe("partial");
    expect(
      normalizeOcrEnvelope({
        status: "success",
        manifest: { terminal_state: "failed" },
        comments: [],
      }).status,
    ).toBe("partial");
    expect(
      normalizeOcrEnvelope({
        manifest: { terminal_state: "partial" },
        comments: [],
      }).status,
    ).toBe("partial");
  });

  it("rejects malformed envelopes", () => {
    expect(() => normalizeOcrEnvelope(null)).toThrow(/Malformed/);
    expect(() => normalizeOcrEnvelope("nope")).toThrow(/Malformed/);
    expect(() => normalizeOcrEnvelope([1, 2])).toThrow(/Malformed/);
  });
});

describe("session id validation", () => {
  it("accepts safe ids and rejects the rest", () => {
    expect(isValidSessionId("abc-123_XY")).toBe(true);
    expect(isValidSessionId("../evil")).toBe(false);
    expect(isValidSessionId("a b")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
  });
});

function writeFakeOcr(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocr-fake-"));
  const script = join(dir, "opencodereview");
  writeFileSync(
    script,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("opencodereview 9.9.9-test");
  process.exit(0);
}
if (args[0] === "review") {
  console.log(JSON.stringify({
    status: "success",
    sessionId: "fake-session-1",
    comments: [{ path: "src/a.ts", content: "Fake finding", startLine: 1, endLine: 2, severity: "medium" }],
    warnings: [],
    counts: {},
  }));
  process.exit(0);
}
if (args[0] === "session" && args[1] === "list") {
  console.log("null");
  process.exit(0);
}
console.error("unexpected args: " + args.join(" "));
process.exit(1);
`,
  );
  chmodSync(script, 0o755);
  return script;
}

describe("fake executable", () => {
  it("runs review json and normalizes history null to []", async () => {
    process.env.OCR_BIN = writeFakeOcr();
    const dir = mkdtempSync(join(tmpdir(), "ocr-work-"));
    const outcome = await runReviewJson({ cwd: dir, mode: "uncommitted" });
    expect(outcome.status).toBe("complete");
    expect(outcome.sessionId).toBe("fake-session-1");
    expect(outcome.findings).toHaveLength(1);

    const history = await listHistory(dir);
    expect(history).toEqual([]);
  });

  it("rejects invalid session ids without spawning", async () => {
    process.env.OCR_BIN = writeFakeOcr();
    const dir = mkdtempSync(join(tmpdir(), "ocr-work-"));
    await expect(showSession(dir, "../evil")).rejects.toThrow(/Invalid session id/);
    await expect(sessionComments(dir, "bad id!")).rejects.toThrow(/Invalid session id/);
  });

  it("rejects sessions absent from history (cross-repo protection)", async () => {
    process.env.OCR_BIN = writeFakeOcr();
    const dir = mkdtempSync(join(tmpdir(), "ocr-work-"));
    await expect(showSession(dir, "ghost-session")).rejects.toThrow(/not found for this worktree/);
  });
});
