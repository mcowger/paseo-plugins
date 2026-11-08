import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { useForeground } from "./use-foreground";

/**
 * Motion for live states. Web uses CSS keyframes (compositor-driven, no JavaScript per frame); native uses
 * Animated on the native driver. Loops pause while the app is in the background and never start when the
 * system asks for reduced motion. One-shot effects (flash, pop, enter) run only when something changes.
 */
const web = Platform.OS === "web";
// Stable easing functions: a new function per render would restart native loops.
const easeOut = Easing.out(Easing.quad), easeSine = Easing.inOut(Easing.sin), easeCubic = Easing.inOut(Easing.cubic);
const loop = { animationIterationCount: "infinite" };
// react-native-web compiles `animationKeyframes` only inside StyleSheet.create.
const css = (web ? StyleSheet.create({
  spin: { ...loop, animationKeyframes: [{ "0%": { transform: "rotate(0deg)" }, "100%": { transform: "rotate(360deg)" } }], animationDuration: "0.9s", animationTimingFunction: "linear" },
  spinSlow: { ...loop, animationKeyframes: [{ "0%": { transform: "rotate(0deg)" }, "100%": { transform: "rotate(360deg)" } }], animationDuration: "1.8s", animationTimingFunction: "linear" },
  ping: { ...loop, animationKeyframes: [{ "0%": { transform: "scale(1)", opacity: 0.6 }, "75%": { transform: "scale(2.3)", opacity: 0 }, "100%": { transform: "scale(2.3)", opacity: 0 } }], animationDuration: "1.7s", animationTimingFunction: "cubic-bezier(0, 0, 0.2, 1)" },
  breathe: { ...loop, animationKeyframes: [{ "0%": { opacity: 1 }, "50%": { opacity: 0.3 }, "100%": { opacity: 1 } }], animationDuration: "2.2s", animationTimingFunction: "ease-in-out" },
  slide: { ...loop, animationKeyframes: [{ "0%": { transform: "translateX(-100%)" }, "100%": { transform: "translateX(340%)" } }], animationDuration: "1.6s", animationTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)" },
  flash: { animationKeyframes: [{ "0%": { opacity: 1 }, "100%": { opacity: 0 } }], animationDuration: "1.8s", animationTimingFunction: "ease-out", animationFillMode: "forwards" },
  pop: { animationKeyframes: [{ "0%": { transform: "scale(1.5)" }, "60%": { transform: "scale(0.92)" }, "100%": { transform: "scale(1)" } }], animationDuration: "0.45s", animationTimingFunction: "ease-out" },
  enter: { animationKeyframes: [{ "0%": { opacity: 0, transform: "translateY(-8px)" }, "100%": { opacity: 1, transform: "translateY(0px)" } }], animationDuration: "0.4s", animationTimingFunction: "ease-out" },
  growY: { animationKeyframes: [{ "0%": { transform: "scaleY(0)" }, "100%": { transform: "scaleY(1)" } }], animationDuration: "0.55s", animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)", animationFillMode: "backwards" },
  growX: { animationKeyframes: [{ "0%": { transform: "scaleX(0)" }, "100%": { transform: "scaleX(1)" } }], animationDuration: "0.6s", animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)", animationFillMode: "backwards" },
  paused: { animationPlayState: "paused" },
} as never) : {}) as Record<"spin" | "spinSlow" | "ping" | "breathe" | "slide" | "flash" | "pop" | "enter" | "growY" | "growX" | "paused", StyleProp<ViewStyle>>;
// Spelled out: React Native 0.86 (the Paseo 0.13 phone app) removed StyleSheet.absoluteFillObject, and spreading it gave nothing.
const shared = StyleSheet.create({ overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, pointerEvents: "none" } });

// One system subscription shared by every animated mark: a long list would otherwise add a listener per row.
let reduced = false;
const reducedListeners = new Set<() => void>();
let reducedSubscription: { remove?: () => void } | undefined;
function subscribeReducedMotion(listener: () => void): () => void {
  reducedListeners.add(listener);
  if (!reducedSubscription) {
    const publish = (next: boolean) => { if (next !== reduced) { reduced = next; for (const notify of reducedListeners) notify(); } };
    reducedSubscription = AccessibilityInfo.addEventListener?.("reduceMotionChanged", publish) ?? {};
    AccessibilityInfo.isReduceMotionEnabled?.().then(publish).catch(() => {});
  }
  return () => {
    reducedListeners.delete(listener);
    if (!reducedListeners.size) { reducedSubscription?.remove?.(); reducedSubscription = undefined; }
  };
}
/** System "reduce motion" (prefers-reduced-motion on web). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => reduced, () => reduced);
}
/** Whether looping motion may run right now; `static` means draw the resting frame only. */
function useLoopState(active: boolean): "run" | "paused" | "static" {
  const foreground = useForeground(), reduce = useReducedMotion();
  return !active || reduce ? "static" : foreground ? "run" : "paused";
}
function useNativeLoop(state: "run" | "paused" | "static", duration: number, easing = Easing.linear): Animated.Value {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (web || state !== "run") { if (!web && state === "static") value.setValue(0); return; }
    const animation = Animated.loop(Animated.timing(value, { toValue: 1, duration, easing, useNativeDriver: true, isInteraction: false }));
    animation.start();
    return () => animation.stop();
  }, [state, duration, easing, value]);
  return value;
}

/** Rotates its child forever (spinners). */
export function Spin({ size, slow = false, active = true, children }: { size: number; slow?: boolean; active?: boolean; children: ReactNode }) {
  const state = useLoopState(active);
  const value = useNativeLoop(state, slow ? 1800 : 900);
  const box: ViewStyle = { width: size, height: size };
  if (web) return <View style={[box, state !== "static" ? (slow ? css.spinSlow : css.spin) : null, state === "paused" ? css.paused : null]}>{children}</View>;
  return <Animated.View style={[box, state === "static" ? null : { transform: [{ rotate: value.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }]}>{children}</Animated.View>;
}

/** A soft ring that keeps expanding out of a status mark ("waiting for you", "live"). */
export function Ping({ size, color, active = true }: { size: number; color: string; active?: boolean }) {
  const state = useLoopState(active);
  const value = useNativeLoop(state, 1700, easeOut);
  if (state === "static") return null;
  const ring: ViewStyle = { position: "absolute", width: size, height: size, borderRadius: size / 2, backgroundColor: color };
  if (web) return <View style={[shared.overlay, { alignItems: "center", justifyContent: "center" }]}><View style={[ring, css.ping, state === "paused" ? css.paused : null]} /></View>;
  return <View style={[shared.overlay, { alignItems: "center", justifyContent: "center" }]}>
    <Animated.View style={[ring, { opacity: value.interpolate({ inputRange: [0, 0.75, 1], outputRange: [0.6, 0, 0] }), transform: [{ scale: value.interpolate({ inputRange: [0, 0.75, 1], outputRange: [1, 2.3, 2.3] }) }] }]} />
  </View>;
}

/** Slow opacity breathing for small "live" marks. */
export function Breathe({ active = true, children }: { active?: boolean; children: ReactNode }) {
  const state = useLoopState(active);
  const value = useNativeLoop(state, 2200, easeSine);
  if (web) return <View style={[state !== "static" ? css.breathe : null, state === "paused" ? css.paused : null]}>{children}</View>;
  return <Animated.View style={state === "static" ? null : { opacity: value.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.3, 1] }) }}>{children}</Animated.View>;
}

/** Indeterminate progress: a short segment sweeping across a faint track. */
export function Sweep({ color, track, height = 2, active = true }: { color: string; track: string; height?: number; active?: boolean }) {
  const state = useLoopState(active);
  const value = useNativeLoop(state, 1600, easeCubic);
  const [width, setWidth] = useState(0);
  const segment: ViewStyle = { position: "absolute", top: 0, bottom: 0, left: 0, width: "30%", borderRadius: height, backgroundColor: color };
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
    style={{ height, overflow: "hidden", backgroundColor: track }}>
    {state === "static" ? <View style={[segment, { width: "100%", opacity: 0.5 }]} />
      : web ? <View style={[segment, css.slide, state === "paused" ? css.paused : null]} />
      : <Animated.View style={[segment, { transform: [{ translateX: value.interpolate({ inputRange: [0, 1], outputRange: [-0.3 * width, width] }) }] }]} />}
  </View>;
}

/**
 * Remembers `signal` across renders and reports a change counter: 0 until the first change after mount.
 * Changes in the first seconds after mount are data still arriving (receipts, telemetry), not news, and
 * remounted rows (scrolled back into view) start at 0 again, so only changes seen live are animated.
 */
export function useChangeCount(signal: string, settleMs = 3000): number {
  const last = useRef(signal), mountedAt = useRef(Date.now()), [count, setCount] = useState(0);
  useEffect(() => {
    if (last.current === signal) return;
    last.current = signal;
    if (Date.now() - mountedAt.current > settleMs) setCount(value => value + 1);
  }, [signal, settleMs]);
  return count;
}

/** A tinted wash that fades out once each time `count` increases. */
export function Flash({ count, color, radius = 0 }: { count: number; color: string; radius?: number }) {
  const reduce = useReducedMotion();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (web || !count || reduce) return;
    value.setValue(1);
    const animation = Animated.timing(value, { toValue: 0, duration: 1800, easing: easeOut, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [count, reduce, value]);
  if (!count || reduce) return null;
  if (web) return <View key={count} style={[shared.overlay, { backgroundColor: color, borderRadius: radius }, css.flash]} />;
  return <Animated.View style={[shared.overlay, { backgroundColor: color, borderRadius: radius, opacity: value }]} />;
}

/** Scales its child in with a small overshoot each time `count` increases (a status mark changing). */
export function Pop({ count, size, children }: { count: number; size: number; children: ReactNode }) {
  const reduce = useReducedMotion();
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (web || !count || reduce) return;
    value.setValue(1.5);
    const animation = Animated.spring(value, { toValue: 1, friction: 4, tension: 140, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [count, reduce, value]);
  const box: ViewStyle = { width: size, height: size };
  if (web) return <View key={count} style={[box, count && !reduce ? css.pop : null]}>{children}</View>;
  return <Animated.View style={[box, { transform: [{ scale: value }] }]}>{children}</Animated.View>;
}

/** Fades and slides a newly arrived item in once, on mount. */
export function Enter({ active, children }: { active: boolean; children: ReactNode }) {
  const reduce = useReducedMotion();
  // Decided once at mount: later renders must not cut a running entrance short.
  const [animate] = useState(active && !reduce);
  const value = useRef(new Animated.Value(animate ? 0 : 1)).current;
  useEffect(() => {
    if (web || !animate) return;
    const animation = Animated.timing(value, { toValue: 1, duration: 400, easing: easeOut, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [animate, value]);
  if (web) return <View style={animate ? css.enter : null}>{children}</View>;
  return <Animated.View style={{ opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }] }}>{children}</Animated.View>;
}

/** Chart marks grow from their baseline once, when the chart first appears (bars up, meters to the right). */
export function Grow({ axis = "y", delay = 0, style, children }: { axis?: "x" | "y"; delay?: number; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const reduce = useReducedMotion();
  const [animate] = useState(!reduce);
  const value = useRef(new Animated.Value(animate ? 0 : 1)).current;
  useEffect(() => {
    if (web || !animate) return;
    const animation = Animated.timing(value, { toValue: 1, duration: 550, delay, easing: easeCubic, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [animate, delay, value]);
  const origin: ViewStyle = { transformOrigin: axis === "y" ? "bottom" : "left" };
  if (web) return <View style={[style, origin, animate ? [axis === "y" ? css.growY : css.growX, { animationDelay: `${delay}ms` } as ViewStyle] : null]}>{children}</View>;
  return <Animated.View style={[style, origin, { transform: [axis === "y" ? { scaleY: value } : { scaleX: value }] }]}>{children}</Animated.View>;
}
