import { describe, expect, it } from "vitest";
import {
  cssKeyframes,
  interpolation,
  MATRIX_OPACITY,
  matrixRing,
  matrixShift,
  shiftStops,
  SNAKE_ORDER,
  SNAKE_STOPS,
  snakeShift,
  SPARKLE_FRAME_MS,
  SPARKLE_GLYPHS,
  SPARKLE_SEQUENCE,
  SPARKLE_STILL,
  sparkleGlyphAt,
  sparkleStops,
  stillCells,
  valueAt,
  type Stop,
} from "./loaders";
import { activitySettings, DEFAULT_LOADER, LOADER_KINDS } from "./settings";

const monotonic = (stops: readonly Stop[]) => stops.every((stop, index) => index === 0 || stop[0] >= stops[index - 1]![0]);

describe("running animations (0.8.0)", () => {
  it("keeps the spinner as the default and stores the choice with the other display settings", () => {
    expect(DEFAULT_LOADER).toBe("spinner");
    expect(LOADER_KINDS).toEqual(["spinner", "sparkle", "orb", "snake", "matrix"]);
    expect(activitySettings.schema.parse({}).loader).toBe("spinner");
    expect(activitySettings.schema.parse({ loader: "sparkle" }).loader).toBe("sparkle");
    expect(activitySettings.schema.safeParse({ loader: "fireworks" }).success).toBe(false);
  });

  it("cycles Claude Code's star from small to full and back, one glyph every 120 ms", () => {
    expect(SPARKLE_GLYPHS.map((glyph) => glyph.replace("︎", ""))).toEqual(["·", "✢", "✳", "✶", "✻", "✽"]);
    // ✳ asks for its text form: some phone fonts would draw the emoji tile.
    expect(SPARKLE_GLYPHS[2]).toBe("✳︎");
    const frames = Array.from({ length: SPARKLE_SEQUENCE.length * 2 }, (_, frame) => SPARKLE_GLYPHS[sparkleGlyphAt(frame * SPARKLE_FRAME_MS + 1)]!.replace("︎", ""));
    expect(frames.join("")).toBe("·✢✳✶✻✽✻✶✳✢".repeat(2));
    expect(sparkleGlyphAt(-5)).toBe(0);
    expect(SPARKLE_GLYPHS[SPARKLE_STILL]).toBe("✻");
  });

  it("turns the star sequence into hard-switching opacity keyframes, one glyph shown at a time", () => {
    for (let glyph = 0; glyph < SPARKLE_GLYPHS.length; glyph++) {
      const stops = sparkleStops(glyph);
      expect(monotonic(stops), `glyph ${glyph}`).toBe(true);
      expect(stops[0]![0]).toBe(0);
      expect(stops.at(-1)![0]).toBe(1);
    }
    // At the middle of every frame exactly one glyph is visible: the one the sequence names.
    SPARKLE_SEQUENCE.forEach((shown, frame) => {
      const at = (frame + 0.5) / SPARKLE_SEQUENCE.length;
      expect(SPARKLE_GLYPHS.map((_, glyph) => valueAt(sparkleStops(glyph), at)), `frame ${frame}`).toEqual(SPARKLE_GLYPHS.map((_, glyph) => (glyph === shown ? 1 : 0)));
    });
    expect(Object.keys(cssKeyframes(sparkleStops(5), (opacity) => ({ opacity })))).toEqual(["0%", "49.99%", "50%", "59.99%", "60%", "100%"]);
  });

  it("winds the snake through the grid row by row, turning at each end", () => {
    expect(SNAKE_ORDER).toEqual([0, 1, 2, 5, 4, 3, 6, 7, 8]);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((cell) => Math.round(snakeShift(cell) * 9))).toEqual([0, 1, 2, 5, 4, 3, 6, 7, 8]);
  });

  it("spreads the twinkle out from the middle: middle, then edges, then corners", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(matrixRing)).toEqual([2, 1, 2, 1, 0, 1, 2, 1, 2]);
    expect(matrixShift(4)).toBe(0);
    expect(matrixShift(1)).toBeLessThan(matrixShift(0));
  });

  it("shifts keyframes for a cell running behind, as one looping value can drive natively", () => {
    for (const stops of [SNAKE_STOPS, MATRIX_OPACITY]) {
      for (const shift of [0, 0.12, 0.333, 0.5, 0.889]) {
        const moved = shiftStops(stops, shift);
        expect(monotonic(moved)).toBe(true);
        expect(moved[0]![0]).toBe(0);
        expect(moved.at(-1)![0]).toBe(1);
        for (const at of [0, 0.05, 0.3, 0.61, 0.99]) expect(valueAt(moved, at)).toBeCloseTo(valueAt(stops, at - shift + 1), 6);
        const { inputRange, outputRange } = interpolation(moved);
        expect(inputRange).toHaveLength(outputRange.length);
      }
    }
  });

  it("rests on a still frame under reduced motion that still reads as running", () => {
    const snake = stillCells("snake");
    expect(snake).toHaveLength(9);
    expect(Math.max(...snake)).toBe(1);
    expect(snake.filter((value) => value > 0.3)).toHaveLength(3);
    expect(stillCells("matrix")[4]).toBe(1);
    expect(stillCells("matrix")[0]).toBeLessThan(stillCells("matrix")[1]!);
  });
});
