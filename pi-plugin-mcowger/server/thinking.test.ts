import { describe, expect, it } from "vitest";

import type { PiModel } from "../shared/rpc-types.js";
import {
  clampThinkingLevel,
  defaultThinkingOptionForModel,
  mapPiModel,
  supportedThinkingLevels,
  thinkingOptionsForModel,
} from "./thinking.js";

function model(overrides: Partial<PiModel> = {}): PiModel {
  return { provider: "anthropic", id: "claude-opus", reasoning: true, ...overrides };
}

describe("supportedThinkingLevels", () => {
  it("returns all levels when the model has no thinkingLevelMap", () => {
    expect(supportedThinkingLevels(model())).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("returns no levels for non-reasoning models", () => {
    expect(supportedThinkingLevels(model({ reasoning: false }))).toEqual([]);
    expect(supportedThinkingLevels(model({ reasoning: undefined }))).toEqual([]);
  });

  it("excludes levels mapped to null", () => {
    const levels = supportedThinkingLevels(
      model({ thinkingLevelMap: { medium: null, xhigh: "xhigh" } }),
    );
    expect(levels).not.toContain("medium");
    expect(levels).toContain("low");
    expect(levels).toContain("high");
  });

  it("requires explicit mapping for extended levels", () => {
    const levels = supportedThinkingLevels(model({ thinkingLevelMap: { high: "high" } }));
    expect(levels).not.toContain("xhigh");
    expect(levels).not.toContain("max");
    expect(levels).toContain("high");
    expect(levels).toContain("off");
  });

  it("supports sparse maps like low/high/max", () => {
    const levels = supportedThinkingLevels(
      model({ thinkingLevelMap: { medium: null, minimal: null, max: "max" } }),
    );
    expect(levels).toEqual(["off", "low", "high", "max"]);
  });
});

describe("clampThinkingLevel", () => {
  it("returns the requested level when supported", () => {
    expect(clampThinkingLevel("medium", ["low", "medium", "high"])).toBe("medium");
  });

  it("clamps upward first", () => {
    expect(clampThinkingLevel("medium", ["off", "high", "max"])).toBe("high");
  });

  it("falls back to the highest lower level", () => {
    expect(clampThinkingLevel("high", ["off", "low", "medium"])).toBe("medium");
  });

  it("returns null when nothing is supported", () => {
    expect(clampThinkingLevel("medium", [])).toBeNull();
  });
});

describe("thinkingOptionsForModel", () => {
  it("marks the clamped default level", () => {
    const options = thinkingOptionsForModel(
      model({ thinkingLevelMap: { medium: null, max: "max" } }),
    );
    expect(options).toBeDefined();
    const defaultOption = options?.find((option) => option.isDefault);
    expect(defaultOption?.id).toBe("high");
    expect(options?.map((option) => option.id)).toEqual([
      "off",
      "minimal",
      "low",
      "high",
      "max",
    ]);
  });

  it("returns undefined for non-reasoning models", () => {
    expect(thinkingOptionsForModel(model({ reasoning: false }))).toBeUndefined();
  });
});

describe("mapPiModel", () => {
  it("maps per-model thinking options and default", () => {
    const mapped = mapPiModel(
      model({ thinkingLevelMap: { xhigh: null, max: null } }),
    );
    expect(mapped.id).toBe("anthropic/claude-opus");
    expect(mapped.thinkingOptions?.map((option) => option.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(mapped.defaultThinkingOptionId).toBe("medium");
  });

  it("omits thinking fields for non-reasoning models", () => {
    const mapped = mapPiModel(model({ reasoning: false }));
    expect(mapped.thinkingOptions).toBeUndefined();
    expect(mapped.defaultThinkingOptionId).toBeUndefined();
  });

  it("normalizes labels", () => {
    const mapped = mapPiModel(model({ name: "Anthropic: Claude_Opus 4" }));
    expect(mapped.label).toBe("Claude Opus 4");
  });

  it("includes context window when present", () => {
    expect(mapPiModel(model({ contextWindow: 200_000 })).contextWindowMaxTokens).toBe(200_000);
  });

  it("defaultThinkingOptionForModel respects sparse maps", () => {
    expect(
      defaultThinkingOptionForModel(
        model({ thinkingLevelMap: { medium: null, minimal: null, low: null, high: null } }),
      ),
    ).toBe("off");
  });
});
