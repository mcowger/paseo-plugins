import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { Finding } from "../shared/contracts.js";
import { MAX_SELECTION_BATCHES, retainRecentBatches } from "../shared/settings.js";
import {
  batchToAttachmentItem,
  buildBatchFromFindings,
  filterBatches,
} from "./selections.js";

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    path: "src/a.ts",
    content: "Issue",
    startLine: 1,
    endLine: 2,
    severity: "high",
    ...overrides,
  };
}

describe("selections", () => {
  it("builds an immutable batch with a validated file url", () => {
    const findings = [finding({ id: "f1" }), finding({ id: "f2", path: "src/b.ts" })];
    const batch = buildBatchFromFindings({
      workspaceId: "ws-1",
      workspaceName: "demo",
      worktreeRoot: "/repo/wt",
      session: { sessionId: "sess-1" },
      findings,
      mode: "branch",
      baseRef: "main",
      targetRef: "feature",
    });
    expect(batch.findingCount).toBe(2);
    expect(batch.findingIds).toEqual(["f1", "f2"]);
    expect(batch.fileUrl).toBe("file:///repo/wt/src/a.ts");
    expect(batch.attachmentText).toContain("sess-1");
    expect(batch.attachmentText).toContain("src/a.ts");
    expect(z.string().url().safeParse(batch.fileUrl).success).toBe(true);

    const item = batchToAttachmentItem(batch);
    expect(item.id).toBe(batch.id);
    expect(item.identifier).toBe(batch.id);
    expect(item.resourceType).toBe("ocr-selection");
    expect(z.string().url().safeParse(item.url).success).toBe(true);
    expect(item.text).toBe(batch.attachmentText);
  });

  it("falls back to the worktree directory for untrustworthy paths", () => {
    const traversal = buildBatchFromFindings({
      workspaceId: "ws-1",
      workspaceName: "demo",
      worktreeRoot: "/repo/wt",
      session: { sessionId: "sess-1" },
      findings: [finding({ id: "f1", path: "../../etc/passwd" })],
      mode: "uncommitted",
    });
    expect(traversal.fileUrl).toBe("file:///repo/wt");

    const absolute = buildBatchFromFindings({
      workspaceId: "ws-1",
      workspaceName: "demo",
      worktreeRoot: "/repo/wt",
      session: { sessionId: "sess-1" },
      findings: [finding({ id: "f1", path: "/etc/passwd" })],
      mode: "uncommitted",
    });
    expect(absolute.fileUrl).toBe("file:///repo/wt");
  });

  it("filters batches server-side by query", () => {
    const first = buildBatchFromFindings({
      workspaceId: "ws-1",
      workspaceName: "alpha",
      worktreeRoot: "/repo/alpha",
      session: { sessionId: "sess-alpha" },
      findings: [finding({ id: "f1" })],
      mode: "uncommitted",
    });
    const second = buildBatchFromFindings({
      workspaceId: "ws-2",
      workspaceName: "beta",
      worktreeRoot: "/repo/beta",
      session: { sessionId: "sess-beta" },
      findings: [finding({ id: "f2" })],
      mode: "uncommitted",
    });
    expect(filterBatches([first, second], "beta")).toHaveLength(1);
    expect(filterBatches([first, second], "")).toHaveLength(2);
  });

  it("retains only the newest batches up to the cap", () => {
    const batches = Array.from({ length: MAX_SELECTION_BATCHES + 5 }, (_, index) =>
      buildBatchFromFindings({
        workspaceId: "ws-1",
        workspaceName: "demo",
        worktreeRoot: "/repo/wt",
        session: { sessionId: `sess-${index}` },
        findings: [finding({ id: `f-${index}` })],
        mode: "uncommitted",
      }),
    );
    const retained = retainRecentBatches(batches);
    expect(retained).toHaveLength(MAX_SELECTION_BATCHES);
  });
});
