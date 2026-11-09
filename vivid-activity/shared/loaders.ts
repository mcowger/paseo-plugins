/**
 * 0.8.0：运行中的行末尾可选的加载动画（设置「运行中动画」）。思路来自 lthieu96/paseo-chat-polish 的「工作中」指示
 * （星芒字符、发光圆球、3×3 点阵），那边是注入宿主 DOM 的 CSS 伪元素，这里没有搬代码：帧序列和关键帧在这里算好，
 * 网页用 CSS 关键帧、原生用 Animated（原生驱动）画同一套数（client/loaders.tsx）。纯数据，便于单测。
 */
export type { LoaderKind } from "./settings";

/**
 * Claude Code's working glyphs, small to full. U+FE0E asks for the text form of ✳, which some phone fonts would
 * otherwise draw as a green emoji tile.
 */
export const SPARKLE_GLYPHS: readonly string[] = ["·", "✢", "✳︎", "✶", "✻", "✽"];
/** One cycle: grow to the full star and shrink back (glyph indexes), one frame each. */
export const SPARKLE_SEQUENCE: readonly number[] = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1];
export const SPARKLE_FRAME_MS = 120;
/** The resting glyph under reduced motion: the full star. */
export const SPARKLE_STILL = 4;

/** The glyph shown `elapsed` ms into the animation. */
export function sparkleGlyphAt(elapsed: number): number {
  const frames = SPARKLE_SEQUENCE.length;
  const frame = Math.floor((Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0) / SPARKLE_FRAME_MS) % frames;
  return SPARKLE_SEQUENCE[frame]!;
}

/** A keyframe: where in the cycle (0–1) and the value there. */
export type Stop = readonly [at: number, value: number];

/** Just under one frame boundary, so a glyph switches at once rather than fading. */
const EDGE = 0.0001;

/**
 * Opacity keyframes of one sparkle glyph over a cycle: 1 in the frames that show it, 0 elsewhere, switching at the frame
 * boundaries. Monotonic positions, so the same stops drive a CSS animation and a native interpolation.
 */
export function sparkleStops(glyph: number, sequence: readonly number[] = SPARKLE_SEQUENCE): Stop[] {
  const frames = sequence.length;
  const stops: Stop[] = [];
  let previous = 0;
  for (let frame = 0; frame < frames; frame++) {
    const on = sequence[frame] === glyph ? 1 : 0;
    const at = frame / frames;
    if (frame === 0) stops.push([0, on]);
    else if (on !== previous) stops.push([at - EDGE, previous], [at, on]);
    previous = on;
  }
  // Held to the end of the cycle; the animation then starts again from the first frame.
  stops.push([1, previous]);
  return stops;
}

/** Cells of the 3×3 grid in the order the snake lights them: left to right, back right to left, left to right. */
export const SNAKE_ORDER: readonly number[] = [0, 1, 2, 5, 4, 3, 6, 7, 8];
/** Where in the cycle (0–1) a cell of the snake lights up. */
export function snakeShift(cell: number): number {
  const step = SNAKE_ORDER.indexOf(cell);
  return step < 0 ? 0 : step / SNAKE_ORDER.length;
}
/** A snake cell: lit, then its trail fades. */
export const SNAKE_STOPS: readonly Stop[] = [[0, 1], [0.22, 0.5], [0.45, 0.16], [1, 0.16]];
export const SNAKE_CYCLE_MS = 1_260;

/** Distance of a cell from the middle of the grid (0 middle, 1 edges, 2 corners): the twinkle spreads out in rings. */
export function matrixRing(cell: number): number {
  const row = Math.floor(cell / 3);
  const column = cell % 3;
  return Math.abs(row - 1) + Math.abs(column - 1);
}
/** Where in the cycle a twinkle cell lights up. */
export function matrixShift(cell: number): number {
  return matrixRing(cell) * 0.12;
}
export const MATRIX_OPACITY: readonly Stop[] = [[0, 0.22], [0.3, 1], [0.62, 0.3], [1, 0.22]];
export const MATRIX_SCALE: readonly Stop[] = [[0, 0.72], [0.3, 1.08], [0.62, 0.8], [1, 0.72]];
export const MATRIX_CYCLE_MS = 1_500;

/** The orb breathes: the core swells and brightens, a glow ring spreads out and fades. */
export const ORB_CORE_SCALE: readonly Stop[] = [[0, 0.74], [0.5, 1], [1, 0.74]];
export const ORB_CORE_OPACITY: readonly Stop[] = [[0, 0.72], [0.5, 1], [1, 0.72]];
export const ORB_HALO_SCALE: readonly Stop[] = [[0, 0.9], [0.5, 1.7], [1, 1.7]];
export const ORB_HALO_OPACITY: readonly Stop[] = [[0, 0.5], [0.5, 0], [1, 0]];
export const ORB_CYCLE_MS = 2_000;

/** Value of keyframes at `at` (0–1), straight lines between them. */
export function valueAt(stops: readonly Stop[], at: number): number {
  if (stops.length === 0) return 0;
  const x = at - Math.floor(at);
  let before = stops[0]!;
  for (const stop of stops) {
    if (stop[0] === x) return stop[1];
    if (stop[0] > x) {
      const span = stop[0] - before[0];
      return span > 0 ? before[1] + ((x - before[0]) / span) * (stop[1] - before[1]) : stop[1];
    }
    before = stop;
  }
  return before[1];
}

/**
 * The same keyframes started `shift` (0–1) later in the cycle, as monotonic positions from 0 to 1: what a native
 * interpolation of one looping value needs to draw a cell that runs behind the others (CSS uses a negative delay).
 */
export function shiftStops(stops: readonly Stop[], shift: number): Stop[] {
  const offset = shift - Math.floor(shift);
  if (offset === 0) return stops.map((stop) => [stop[0], stop[1]] as const);
  // The cycle's end lands where its start does: it goes first, so a jump at the wrap (a snake cell lighting up) stays a jump.
  const keyed = stops.map((stop, index) => ({ at: stop[0] >= 1 ? offset : (stop[0] + offset) % 1, value: stop[1], rank: stop[0] >= 1 ? -1 : index }));
  const start = valueAt(stops, 1 - offset);
  keyed.push({ at: 0, value: start, rank: -2 }, { at: 1, value: start, rank: Number.MAX_SAFE_INTEGER });
  keyed.sort((left, right) => left.at - right.at || left.rank - right.rank);
  const moved = keyed.map((entry) => [entry.at, entry.value] as const);
  // Equal positions with different values are a switch and stay; exact repeats go.
  return moved.filter((stop, index) => index === 0 || stop[0] !== moved[index - 1]![0] || stop[1] !== moved[index - 1]![1]);
}

/** Input and output ranges for Animated's `interpolate`. */
export function interpolation(stops: readonly Stop[]): { inputRange: number[]; outputRange: number[] } {
  return { inputRange: stops.map((stop) => stop[0]), outputRange: stops.map((stop) => stop[1]) };
}

/** CSS keyframes of stops for one property (react-native-web `animationKeyframes`). */
export function cssKeyframes(stops: readonly Stop[], property: (value: number) => Record<string, string | number>): Record<string, Record<string, string | number>> {
  const frames: Record<string, Record<string, string | number>> = {};
  for (const [at, value] of stops) frames[`${Math.round(at * 100_000) / 1000}%`] = property(value);
  return frames;
}

/** The frame a loader rests on under reduced motion: per grid cell its opacity (snake and twinkle). */
export function stillCells(kind: "snake" | "matrix"): number[] {
  if (kind === "snake") {
    // A short snake frozen mid-way: its head bright, the trail behind it fading.
    const lit = new Map<number, number>([[5, 1], [2, 0.6], [1, 0.35]]);
    return Array.from({ length: 9 }, (_, cell) => lit.get(cell) ?? 0.16);
  }
  return Array.from({ length: 9 }, (_, cell) => [1, 0.55, 0.28][matrixRing(cell)]!);
}
