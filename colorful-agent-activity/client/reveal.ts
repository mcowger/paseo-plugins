import * as hostUi from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";

/**
 * Paced reveal for streaming reasoning text.
 *
 * Paseo 0.12 and earlier exposed `useRevealedText` to plugins. 0.13 replaced it
 * with `StreamedText`, which draws its own text and cannot stand in here: this
 * block reveals a string first, then splits and parses it. The hook still rides
 * the deprecated `client/react-native` alias while that lasts, so use it when
 * the host has it and pace the text locally when it does not.
 */

export type RevealPhase = "streaming" | "complete";
export type RevealText = (text: string, phase: RevealPhase) => string;

/** Least characters a frame reveals, and the share of the backlog it catches up. */
const MIN_STEP = 2;
const CATCH_UP = 0.12;

/** Cut point that never splits a surrogate pair, combining mark, or joiner. */
export function safeCut(text: string, index: number): number {
  let cut = Math.max(0, Math.min(index, text.length));
  if (cut >= text.length) return text.length;
  const code = text.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
  while (cut > 0) {
    const next = text.charCodeAt(cut);
    const attached =
      (next >= 0x0300 && next <= 0x036f) ||
      (next >= 0xfe00 && next <= 0xfe0f) ||
      next === 0x200d;
    if (!attached) break;
    cut -= 1;
  }
  return Math.max(0, cut);
}

/** How much of `text` a frame shows, starting from `from`. */
export function nextRevealCount(text: string, from: number, phase: RevealPhase): number {
  if (phase === "complete") return text.length;
  const start = Math.max(0, Math.min(from, text.length));
  if (start >= text.length) return text.length;
  const hidden = text.length - start;
  return safeCut(text, start + Math.max(MIN_STEP, Math.ceil(hidden * CATCH_UP)));
}

function shownText(text: string, count: number): string {
  return count >= text.length ? text : text.slice(0, count);
}

/**
 * Same pacing contract as the host hook, without the host. Only used on a host
 * that no longer exports the hook; the frame loop settles as soon as the block
 * stops streaming.
 */
function useLocalRevealedText(text: string, phase: RevealPhase): string {
  const [count, setCount] = useState(() => nextRevealCount(text, 0, phase));
  const current = useRef(count);
  current.current = count;

  useEffect(() => {
    const settle = () => {
      const full = text.length;
      if (current.current === full) return;
      current.current = full;
      setCount(full);
    };
    if (phase === "complete" || current.current >= text.length) {
      settle();
      return;
    }
    const raf = globalThis.requestAnimationFrame;
    const cancel = globalThis.cancelAnimationFrame;
    if (typeof raf !== "function") {
      settle();
      return;
    }
    let handle = 0;
    let stopped = false;
    const step = () => {
      if (stopped) return;
      const next = nextRevealCount(text, current.current, "streaming");
      if (next === current.current) return;
      current.current = next;
      setCount(next);
      if (next < text.length) handle = raf(step);
    };
    handle = raf(step);
    return () => {
      stopped = true;
      if (handle && typeof cancel === "function") cancel(handle);
    };
  }, [text, phase]);

  return shownText(text, count);
}

/** Host hook when the host still exports one, otherwise the local pacing. */
export function createRevealText(hostReveal: unknown): RevealText {
  return typeof hostReveal === "function" ? (hostReveal as RevealText) : useLocalRevealedText;
}

const hostReveal = (hostUi as { useRevealedText?: unknown }).useRevealedText;

export const usePacedText: RevealText = createRevealText(hostReveal);
