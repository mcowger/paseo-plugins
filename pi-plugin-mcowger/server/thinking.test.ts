import { describe, expect, test } from "vitest";

import type { PiModel } from "./rpc-types.js";
import { mapPiCatalogModel, normalizePiModelLabel, normalizePiThinkingOption, thinkingConfigForModel } from "./thinking.js";

const restricted: PiModel = {
  provider: "kimi-coding",
  id: "kimi-k3",
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  },
};

describe("Pi thinking capabilities", () => {
  test("advertises only mapped levels and clamps the default upward", () => {
    expect(thinkingConfigForModel(restricted)).toEqual({
      thinkingOptions: [
        { id: "low", label: "Low", description: "Faster reasoning" },
        { id: "high", label: "High", description: "Deeper reasoning", isDefault: true },
        { id: "max", label: "Max", description: "Extreme reasoning" },
      ],
      defaultThinkingOptionId: "high",
    });
  });

  test("does not infer extended thinking levels without explicit mappings", () => {
    const config = thinkingConfigForModel({
      provider: "openai",
      id: "model",
      reasoning: true,
    });

    expect(config.thinkingOptions.map((option) => option.id)).toEqual([
      "off", "minimal", "low", "medium", "high",
    ]);
    expect(config.defaultThinkingOptionId).toBe("medium");
  });

  test("does not expose thinking configuration for non-reasoning models", () => {
    expect(thinkingConfigForModel({ provider: "openai", id: "model", reasoning: false })).toEqual({
      thinkingOptions: [],
      defaultThinkingOptionId: undefined,
    });
  });

  test("defaults to medium when available", () => {
    const config = thinkingConfigForModel({ provider: "openai", id: "model", reasoning: true });
    expect(config.defaultThinkingOptionId).toBe("medium");
    expect(config.thinkingOptions.find((option) => option.id === "medium")).toMatchObject({ isDefault: true });
  });

  test("falls back to the highest remaining level when nothing is at or above medium", () => {
    const config = thinkingConfigForModel({
      provider: "openai",
      id: "model",
      reasoning: true,
      thinkingLevelMap: { off: "off", minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null },
    });
    expect(config.thinkingOptions.map((option) => option.id)).toEqual(["off", "low"]);
    expect(config.defaultThinkingOptionId).toBe("low");
  });
});

describe("Pi model label normalization", () => {
  test("trims and collapses separators", () => {
    expect(normalizePiModelLabel("  gpt__5   mini ")).toBe("gpt 5 mini");
  });

  test("strips a vendor prefix", () => {
    expect(normalizePiModelLabel("Anthropic: claude-opus-4")).toBe("claude-opus-4");
  });

  test("keeps labels without a vendor separator", () => {
    expect(normalizePiModelLabel("kimi-k3")).toBe("kimi-k3");
  });
});

describe("normalizePiThinkingOption", () => {
  test("passes valid levels through", () => {
    expect(normalizePiThinkingOption("high")).toBe("high");
  });

  test("rejects unknown, empty, and nullish values", () => {
    expect(normalizePiThinkingOption("ultra")).toBeNull();
    expect(normalizePiThinkingOption("")).toBeNull();
    expect(normalizePiThinkingOption(null)).toBeNull();
    expect(normalizePiThinkingOption(undefined)).toBeNull();
  });
});

describe("mapPiCatalogModel", () => {
  test("normalizes slash labels and keeps the full native id as description", () => {
    expect(mapPiCatalogModel({
      provider: "anthropic",
      id: "claude",
      name: "Anthropic: claude_opus",
      reasoning: true,
    })).toMatchObject({
      id: "anthropic/claude",
      label: "claude opus",
      description: "anthropic/claude",
      defaultThinkingOptionId: "medium",
    });
  });

  test("uses the composite id when no display name is present", () => {
    expect(mapPiCatalogModel({ provider: "openai", id: "model" })).toMatchObject({
      id: "openai/model",
      label: "model",
      description: "openai/model",
    });
  });

  test("attaches map-filtered thinking only for reasoning models", () => {
    expect(mapPiCatalogModel(restricted).thinkingOptions?.map((option) => option.id)).toEqual(["low", "high", "max"]);
    expect(mapPiCatalogModel({ provider: "openai", id: "model", reasoning: false }).thinkingOptions).toBeUndefined();
  });

  test("carries the context window when present", () => {
    expect(mapPiCatalogModel({ provider: "openai", id: "model", contextWindow: 128000 }).contextWindowMaxTokens).toBe(128000);
  });
});
