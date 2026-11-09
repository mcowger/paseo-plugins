import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Platform, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import {
  cssKeyframes,
  interpolation,
  MATRIX_CYCLE_MS,
  MATRIX_OPACITY,
  MATRIX_SCALE,
  matrixShift,
  ORB_CORE_OPACITY,
  ORB_CORE_SCALE,
  ORB_CYCLE_MS,
  ORB_HALO_OPACITY,
  ORB_HALO_SCALE,
  shiftStops,
  SNAKE_CYCLE_MS,
  SNAKE_STOPS,
  snakeShift,
  SPARKLE_FRAME_MS,
  SPARKLE_GLYPHS,
  SPARKLE_SEQUENCE,
  SPARKLE_STILL,
  sparkleStops,
  stillCells,
  type LoaderKind,
  type Stop,
} from "../shared/loaders";
import { useReducedMotion } from "./motion";
import { useForeground } from "./use-foreground";

/**
 * 0.8.0（fx 懒加载块）：运行中的行末尾可选的加载动画：星芒（Claude Code 式字符轮换）、光球呼吸、3×3 点阵（蛇形、闪烁）。
 * 和 kit 的动效原语同一套做法（client/motion.tsx）：网页用 CSS 关键帧（合成器驱动，每帧不跑 JavaScript），原生用
 * Animated 原生驱动，一个循环值插值出每一层、每个点；App 在后台时暂停，系统要求减少动态效果时只画静止的一帧。
 * 帧序列和关键帧在 shared/loaders.ts。
 */
const web = Platform.OS === "web";
const easeSine = Easing.inOut(Easing.sin);
const SPARKLE_CYCLE_MS = SPARKLE_SEQUENCE.length * SPARKLE_FRAME_MS;

/** Two keyframe lists at the same positions as one CSS keyframe list. */
function together(left: readonly Stop[], right: readonly Stop[], frame: (a: number, b: number) => Record<string, string | number>) {
  return cssKeyframes(left.map(([at], index) => [at, index] as const), (index) => frame(left[index]![1], right[index]![1]));
}

const loop = { animationIterationCount: "infinite" };
// react-native-web compiles `animationKeyframes` only inside StyleSheet.create.
const css = (web ? StyleSheet.create({
  ...Object.fromEntries(SPARKLE_GLYPHS.map((_, glyph) => [`sparkle${glyph}`, {
    ...loop, animationKeyframes: [cssKeyframes(sparkleStops(glyph), (opacity) => ({ opacity }))], animationDuration: `${SPARKLE_CYCLE_MS}ms`, animationTimingFunction: "linear",
  }])),
  orbCore: { ...loop, animationKeyframes: [together(ORB_CORE_SCALE, ORB_CORE_OPACITY, (scale, opacity) => ({ transform: `scale(${scale})`, opacity }))], animationDuration: `${ORB_CYCLE_MS}ms`, animationTimingFunction: "ease-in-out" },
  orbHalo: { ...loop, animationKeyframes: [together(ORB_HALO_SCALE, ORB_HALO_OPACITY, (scale, opacity) => ({ transform: `scale(${scale})`, opacity }))], animationDuration: `${ORB_CYCLE_MS}ms`, animationTimingFunction: "ease-out" },
  snake: { ...loop, animationKeyframes: [cssKeyframes(SNAKE_STOPS, (opacity) => ({ opacity }))], animationDuration: `${SNAKE_CYCLE_MS}ms`, animationTimingFunction: "linear" },
  matrix: { ...loop, animationKeyframes: [together(MATRIX_OPACITY, MATRIX_SCALE, (opacity, scale) => ({ opacity, transform: `scale(${scale})` }))], animationDuration: `${MATRIX_CYCLE_MS}ms`, animationTimingFunction: "ease-in-out" },
  paused: { animationPlayState: "paused" },
} as never) : {}) as Record<string, StyleProp<ViewStyle>>;

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const };

export type LoopState = "run" | "paused" | "static";

/** Whether the loop runs, waits (the app is in the background) or rests on its still frame (reduced motion). */
function useLoopState(): LoopState {
  const foreground = useForeground();
  const reduce = useReducedMotion();
  return reduce ? "static" : foreground ? "run" : "paused";
}

/** One looping value 0 → 1 on the native driver; stopped (where it was) while paused, reset while static. */
function useNativeLoop(state: LoopState, duration: number, easing = Easing.linear): Animated.Value {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (web || state !== "run") {
      if (!web && state === "static") value.setValue(0);
      return;
    }
    const animation = Animated.loop(Animated.timing(value, { toValue: 1, duration, easing, useNativeDriver: true, isInteraction: false }));
    animation.start();
    return () => animation.stop();
  }, [state, duration, easing, value]);
  return value;
}

const center: ViewStyle = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" };

/** Claude Code's working star: · ✢ ✳ ✶ ✻ ✽ and back, one glyph every 120 ms. */
function Sparkle({ size, color, state }: { size: number; color: string; state: LoopState }) {
  const value = useNativeLoop(state, SPARKLE_CYCLE_MS);
  const opacities = useMemo(() => SPARKLE_GLYPHS.map((_, glyph) => value.interpolate(interpolation(sparkleStops(glyph)))), [value]);
  const text: TextStyle = { color, fontSize: Math.round(size * 0.92), lineHeight: size, fontWeight: "700", textAlign: "center", includeFontPadding: false };
  return <View {...hidden} style={{ width: size, height: size }}>
    {state === "static"
      ? <View style={center}><Text style={text}>{SPARKLE_GLYPHS[SPARKLE_STILL]}</Text></View>
      : SPARKLE_GLYPHS.map((glyph, index) => web
        ? <View key={glyph} style={[center, css[`sparkle${index}`], state === "paused" ? css.paused : null]}><Text style={text}>{glyph}</Text></View>
        : <Animated.View key={glyph} style={[center, { opacity: opacities[index] }]}><Text style={text}>{glyph}</Text></Animated.View>)}
  </View>;
}

/** A glowing ball that breathes: the core swells and brightens while a ring of light spreads out and fades. */
function Orb({ size, color, state }: { size: number; color: string; state: LoopState }) {
  const value = useNativeLoop(state, ORB_CYCLE_MS, easeSine);
  const diameter = Math.max(6, Math.round(size * 0.58));
  const ball: ViewStyle = { width: diameter, height: diameter, borderRadius: diameter / 2, backgroundColor: color };
  const glow: ViewStyle = { ...ball, position: "absolute" };
  const animated = useMemo(() => ({
    core: { opacity: value.interpolate(interpolation(ORB_CORE_OPACITY)), transform: [{ scale: value.interpolate(interpolation(ORB_CORE_SCALE)) }] },
    halo: { opacity: value.interpolate(interpolation(ORB_HALO_OPACITY)), transform: [{ scale: value.interpolate(interpolation(ORB_HALO_SCALE)) }] },
  }), [value]);
  return <View {...hidden} style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
    {state === "static" ? <View style={[ball, { shadowColor: color, shadowOpacity: 0.6, shadowRadius: 3, shadowOffset: { width: 0, height: 0 } }]} />
      : web ? <>
        <View style={[glow, css.orbHalo, state === "paused" ? css.paused : null]} />
        <View style={[ball, css.orbCore, state === "paused" ? css.paused : null]} />
      </>
      : <>
        <Animated.View style={[glow, animated.halo]} />
        <Animated.View style={[ball, animated.core]} />
      </>}
  </View>;
}

/** The 3×3 dot grid: a snake winding through it, or a twinkle spreading from the middle. */
function DotGrid({ kind, size, color, state }: { kind: "snake" | "matrix"; size: number; color: string; state: LoopState }) {
  const cycle = kind === "snake" ? SNAKE_CYCLE_MS : MATRIX_CYCLE_MS;
  const value = useNativeLoop(state, cycle, kind === "snake" ? Easing.linear : easeSine);
  const dot = Math.max(2, Math.round(size * 0.19));
  const gap = (size - dot * 3) / 4;
  const cells = useMemo(() => Array.from({ length: 9 }, (_, cell) => {
    const shift = kind === "snake" ? snakeShift(cell) : matrixShift(cell);
    return {
      cell,
      shift,
      opacity: value.interpolate(interpolation(shiftStops(kind === "snake" ? SNAKE_STOPS : MATRIX_OPACITY, shift))),
      scale: kind === "matrix" ? value.interpolate(interpolation(shiftStops(MATRIX_SCALE, shift))) : null,
    };
  }), [kind, value]);
  const still = useMemo(() => stillCells(kind), [kind]);
  return <View {...hidden} style={{ width: size, height: size }}>
    {cells.map(({ cell, shift, opacity, scale }) => {
      const place: ViewStyle = {
        position: "absolute", width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color,
        left: gap + (cell % 3) * (dot + gap), top: gap + Math.floor(cell / 3) * (dot + gap),
      };
      if (state === "static") return <View key={cell} style={[place, { opacity: still[cell] }]} />;
      // A negative delay starts the cell part-way into the cycle (CSS); natively the same shift is in its keyframes.
      if (web) return <View key={cell} style={[place, kind === "snake" ? css.snake : css.matrix, { animationDelay: `-${Math.round(shift * cycle)}ms` } as ViewStyle, state === "paused" ? css.paused : null]} />;
      return <Animated.View key={cell} style={[place, { opacity, ...(scale ? { transform: [{ scale }] } : {}) }]} />;
    })}
  </View>;
}

/** One animation in a given loop state (tests draw each state). */
export function LoaderFrame({ kind, size, color, state }: { kind: Exclude<LoaderKind, "spinner">; size: number; color: string; state: LoopState }) {
  if (kind === "sparkle") return <Sparkle size={size} color={color} state={state} />;
  if (kind === "orb") return <Orb size={size} color={color} state={state} />;
  return <DotGrid kind={kind} size={size} color={color} state={state} />;
}

/** The running mark for a chosen animation other than the spinner: moving in front, paused behind, still under reduced motion. */
export function RunningLoader({ kind, size, color }: { kind: Exclude<LoaderKind, "spinner">; size: number; color: string }) {
  return <LoaderFrame kind={kind} size={size} color={color} state={useLoopState()} />;
}
