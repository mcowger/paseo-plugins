import { describe, expect, it } from "vitest";
import {
  autoMapTokens,
  extractPalette,
  generatePluginCode,
  getLuminance,
  normalizeHex,
} from "./parser.js";
import {
  BUILTIN_PRESETS,
  CSS_PROMPT_EXAMPLE,
  TAILWIND_PROMPT_EXAMPLE,
} from "./presets.js";
import { themeStudioSettings, themeTokensSchema } from "./settings.js";

describe("Theme Studio Color Parser", () => {
  it("normalizes hex colors correctly", () => {
    expect(normalizeHex("#fff")).toBe("#ffffff");
    expect(normalizeHex("#000814")).toBe("#000814");
    expect(normalizeHex("#000814ff")).toBe("#000814");
    expect(normalizeHex("#FFC300FF")).toBe("#ffc300");
    expect(normalizeHex("invalid")).toBeNull();
    expect(normalizeHex("#12")).toBeNull();
  });

  it("calculates relative luminance correctly", () => {
    expect(getLuminance("#000000")).toBeCloseTo(0, 3);
    expect(getLuminance("#ffffff")).toBeCloseTo(1, 3);
    expect(getLuminance("#000814")).toBeLessThan(0.01);
    expect(getLuminance("#ffc300")).toBeGreaterThan(0.5);
  });

  it("extracts Tailwind palette input with nested groups", () => {
    const palette = extractPalette(TAILWIND_PROMPT_EXAMPLE);
    expect(palette.format).toBe("tailwind");
    expect(palette.groups).toContain("ink_black");
    expect(palette.groups).toContain("prussian_blue");
    expect(palette.groups).toContain("regal_navy");
    expect(palette.groups).toContain("school_bus_yellow");
    expect(palette.groups).toContain("gold");

    const inkBlackDefault = palette.colors.find((c) => c.id === "ink_black.DEFAULT");
    expect(inkBlackDefault).toBeDefined();
    expect(inkBlackDefault?.hex).toBe("#000814");

    const schoolBusYellow = palette.colors.find((c) => c.id === "school_bus_yellow.DEFAULT");
    expect(schoolBusYellow).toBeDefined();
    expect(schoolBusYellow?.hex).toBe("#ffc300");
  });

  it("extracts CSS variables format", () => {
    const palette = extractPalette(CSS_PROMPT_EXAMPLE);
    expect(palette.format).toBe("css");
    expect(palette.colors.length).toBe(5);

    const inkBlack = palette.colors.find((c) => c.id === "--ink-black");
    expect(inkBlack).toBeDefined();
    expect(inkBlack?.hex).toBe("#000814");

    const gold = palette.colors.find((c) => c.id === "--gold");
    expect(gold).toBeDefined();
    expect(gold?.hex).toBe("#ffd60a");
  });

  it("extracts arbitrary hex lists", () => {
    const palette = extractPalette("Colors: #112233, #445566 and #aabbcc");
    expect(palette.format).toBe("hex-list");
    expect(palette.colors.length).toBe(3);
    expect(palette.colors[0].hex).toBe("#112233");
  });

  it("extracts nested JSON color values", () => {
    const palette = extractPalette(
      JSON.stringify({
        surface: { background: "#101820", panel: "#202a35" },
        text: { primary: "#ffffff" },
      }),
    );
    expect(palette.format).toBe("json");
    expect(palette.groups).toEqual(["surface", "text"]);
    expect(palette.colors).toEqual([
      expect.objectContaining({ id: "surface.background", hex: "#101820" }),
      expect.objectContaining({ id: "surface.panel", hex: "#202a35" }),
      expect.objectContaining({ id: "text.primary", hex: "#ffffff" }),
    ]);
  });

  it("auto-maps extracted colors to valid Paseo theme tokens", () => {
    const palette = extractPalette(TAILWIND_PROMPT_EXAMPLE);
    const darkTokens = autoMapTokens(palette.colors, "dark");
    const lightTokens = autoMapTokens(palette.colors, "light");

    expect(themeTokensSchema.safeParse(darkTokens).success).toBe(true);
    expect(themeTokensSchema.safeParse(lightTokens).success).toBe(true);

    // In dark mode, background should be very dark and foreground bright
    expect(getLuminance(darkTokens.background)).toBeLessThan(0.05);
    expect(getLuminance(darkTokens.foreground)).toBeGreaterThan(0.5);

    // In light mode, background should be brighter than foreground
    expect(getLuminance(lightTokens.background)).toBeGreaterThan(
      getLuminance(lightTokens.foreground),
    );
  });

  it("generates valid Paseo plugin contribute code", () => {
    const code = generatePluginCode({
      id: "navy-gold",
      name: "Deep Navy & Gold",
      appearance: "dark",
      tokens: BUILTIN_PRESETS[0].tokens,
    });

    expect(code).toContain("client.addTheme({");
    expect(code).toContain('id: "navy-gold"');
    expect(code).toContain('background: "#000814"');
  });

  it("validates all built-in presets against themeTokensSchema", () => {
    for (const preset of BUILTIN_PRESETS) {
      const parsed = themeTokensSchema.safeParse(preset.tokens);
      expect(parsed.success).toBe(true);
    }
  });

  it("persists the selected preset identity in settings", () => {
    const parsed = themeStudioSettings.schema.parse({
      activePresetId: "tokyo-cyber",
    });

    expect(parsed.activePresetId).toBe("tokyo-cyber");
  });
});
