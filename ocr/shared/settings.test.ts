import { describe, expect, it } from "vitest";
import {
  DEFAULT_NEW_AGENT_INSTRUCTIONS,
  MAX_SELECTION_BATCHES,
  mergeBatches,
  preferencesSchema,
  providerModelSchema,
  retainRecentBatches,
  selectionsSchema,
} from "./settings.js";
import type { SelectionBatch } from "./settings.js";

function makeBatch(overrides: Partial<SelectionBatch> & { id: string }): SelectionBatch {
  return {
    label: "1 findings",
    createdAt: "2026-01-01T00:00:00.000Z",
    workspaceId: "ws-1",
    workspaceName: "demo",
    worktreeRoot: "/repo/demo",
    sessionId: "sess-1",
    mode: "uncommitted",
    findingCount: 1,
    severitySummary: "1 medium",
    findingIds: ["a"],
    attachmentText: "findings",
    fileUrl: "file:///repo/demo",
    ...overrides,
  };
}

describe("providerModelSchema", () => {
  it("accepts provider/model values, including nested model paths", () => {
    expect(providerModelSchema.safeParse("acme/gpt-5-mini").success).toBe(true);
    expect(providerModelSchema.safeParse("opencode/openrouter/glm-5.3-flash").success).toBe(
      true,
    );
  });

  it("rejects bare providers, paths, and whitespace", () => {
    expect(providerModelSchema.safeParse("acme").success).toBe(false);
    expect(providerModelSchema.safeParse("acme/my model").success).toBe(false);
    expect(providerModelSchema.safeParse("/leading-slash").success).toBe(false);
    expect(providerModelSchema.safeParse("trailing-slash/").success).toBe(false);
    expect(providerModelSchema.safeParse("doubled//slash").success).toBe(false);
    expect(providerModelSchema.safeParse("").success).toBe(false);
  });
});

describe("preferencesSchema", () => {
  it("defaults instructions to the documented text and leaves model unset", () => {
    const parsed = preferencesSchema.parse({});
    expect(parsed.newAgentInstructions).toBe(DEFAULT_NEW_AGENT_INSTRUCTIONS);
    expect(parsed.defaultProviderModel).toBeUndefined();
  });

  it("rejects empty instructions and malformed models", () => {
    expect(() => preferencesSchema.parse({ newAgentInstructions: "   " })).toThrow();
    expect(() =>
      preferencesSchema.parse({ defaultProviderModel: "bare-provider" }),
    ).toThrow();
  });
});

describe("selectionsSchema", () => {
  it("defaults to an empty batch list", () => {
    expect(selectionsSchema.parse({}).batches).toEqual([]);
  });
});

describe("retainRecentBatches", () => {
  it("keeps only the 20 newest batches", () => {
    const batches = Array.from({ length: 25 }, (_, index) =>
      makeBatch({
        id: `batch-${index}`,
        createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const retained = retainRecentBatches(batches);
    expect(retained).toHaveLength(MAX_SELECTION_BATCHES);
    expect(retained[0]?.id).toBe("batch-24");
    expect(retained.map((batch) => batch.id)).not.toContain("batch-0");
  });

  it("limits batch count, not batch text", () => {
    const longText = "x".repeat(100_000);
    const retained = retainRecentBatches([makeBatch({ id: "big", attachmentText: longText })]);
    expect(retained[0]?.attachmentText).toBe(longText);
  });
});

describe("mergeBatches", () => {
  it("adds the incoming batch and replaces any batch with the same id", () => {
    const existing = [makeBatch({ id: "a" }), makeBatch({ id: "b" })];
    const incoming = makeBatch({ id: "b", label: "updated" });
    const merged = mergeBatches(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(merged.find((batch) => batch.id === "b")?.label).toBe("updated");
    expect(merged[0]?.id).toBe("b");
  });

  it("retains at most 20 batches after merging", () => {
    const existing = Array.from({ length: 20 }, (_, index) =>
      makeBatch({ id: `batch-${index}` }),
    );
    const merged = mergeBatches(existing, makeBatch({ id: "new" }));
    expect(merged).toHaveLength(MAX_SELECTION_BATCHES);
    expect(merged.some((batch) => batch.id === "new")).toBe(true);
  });
});
