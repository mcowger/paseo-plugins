import { describe, expect, it } from "vitest";
import { alpha, darken, luminance, mix, parseHex, rule, sunken, tint } from "./color";

describe("parseHex", () => {
  it("parses 3, 6, and 8 digit hex", () => {
    expect(parseHex("#abc")).toEqual({ r: 170, g: 187, b: 204 });
    expect(parseHex("#1e2227")).toEqual({ r: 30, g: 34, b: 39 });
    expect(parseHex("#1e222780")).toEqual({ r: 30, g: 34, b: 39 });
    expect(parseHex("  #1E2227  ")).toEqual({ r: 30, g: 34, b: 39 });
  });

  it("rejects anything that is not hex", () => {
    for (const value of ["red", "rgb(1,2,3)", "hsl(1 2% 3%)", "#12345", "", "var(--x)"]) {
      expect(parseHex(value)).toBeNull();
    }
  });
});

describe("alpha", () => {
  it("appends the requested opacity", () => {
    expect(alpha("#3e4452", 0.6)).toBe("#3e445299");
  });

  it("returns the color unchanged at full opacity", () => {
    expect(alpha("#fff", 1)).toBe("#fff");
    expect(alpha("#000000", 4)).toBe("#000000");
  });

  it("clamps an out-of-range amount to transparent", () => {
    expect(alpha("#000000", -1)).toBe("#00000000");
  });

  it("passes non-hex colors through untouched", () => {
    expect(alpha("rgb(1,2,3)", 0.5)).toBe("rgb(1,2,3)");
    expect(rule("currentColor")).toBe("currentColor");
  });
});

describe("mix", () => {
  it("blends channel by channel", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#ffffff", "#000000", 0)).toBe("#ffffff");
    expect(mix("#ffffff", "#000000", 1)).toBe("#000000");
  });

  it("returns the source when either color is not hex", () => {
    expect(mix("#ffffff", "red", 0.5)).toBe("#ffffff");
  });
});

describe("luminance", () => {
  it("orders black, mid greys, and white", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBe(1);
    const mid = luminance("#808080");
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.3);
    expect(luminance("red")).toBeUndefined();
  });
});

describe("sunken", () => {
  it("recesses dark surfaces further than light ones", () => {
    expect(sunken("#23272e")).toBe(darken("#23272e", 0.1));
    expect(sunken("#ffffff")).toBe(darken("#ffffff", 0.05));
  });

  it("stays a subtle step: visible, but never near black", () => {
    const dark = parseHex(sunken("#23272e"))!;
    expect(dark.r).toBeLessThan(36);
    expect(dark.r).toBeGreaterThan(20);
    const light = parseHex(sunken("#ffffff"))!;
    expect(light.r).toBeGreaterThan(230);
  });

  it("accepts an explicit amount and passes non-hex through", () => {
    expect(sunken("#808080", 0.25)).toBe(darken("#808080", 0.25));
    expect(sunken("rebeccapurple")).toBe("rebeccapurple");
  });
});

describe("tint", () => {
  it("is a low-opacity wash of a semantic color", () => {
    expect(tint("#7ee787")).toBe("#7ee7871f");
    expect(tint("#ff7b72", 0.2)).toBe("#ff7b7233");
  });
});
