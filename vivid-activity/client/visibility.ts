import { useEffect, useState, type RefObject } from "react";
import { Platform } from "react-native";
import type { CardVisibility } from "../shared/child-agent";

type Observed = { observe(node: unknown): void; disconnect(): void };
declare const IntersectionObserver:
  | (new (callback: (entries: Array<{ isIntersecting: boolean }>) => void) => Observed)
  | undefined;

/**
 * Whether the row is on screen: web asks the browser (only while `watch`, i.e. for live rows); native lists unmount rows
 * far off screen, so mounted counts as visible.
 */
export function useOnScreen(ref: RefObject<unknown>, watch: boolean): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!watch) {
      setVisible(true);
      return;
    }
    if (Platform.OS !== "web" || typeof IntersectionObserver === "undefined" || !ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setVisible(entry.isIntersecting);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref, watch]);
  return visible;
}

/**
 * 0.5.0: whether a card is on screen, for reads that cost a request (the child agent card). Web asks the browser about the
 * card's DOM node (a react-native-web View ref is the element) and says "pending" until the first answer, so a card
 * mounted off screen reads nothing; native has no viewport API ("unsupported": callers go by foreground only).
 */
export function useCardVisibility(ref: RefObject<unknown>): CardVisibility {
  const supported = Platform.OS === "web" && typeof IntersectionObserver !== "undefined";
  const [visibility, setVisibility] = useState<CardVisibility>(supported ? "pending" : "unsupported");
  useEffect(() => {
    if (!supported) return;
    const node = ref.current;
    if (!node) {
      setVisibility("unsupported");
      return;
    }
    let observer: Observed;
    try {
      observer = new IntersectionObserver!((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setVisibility(entry.isIntersecting ? "visible" : "hidden");
      });
      observer.observe(node);
    } catch {
      setVisibility("unsupported");
      return;
    }
    return () => observer.disconnect();
  }, [ref, supported]);
  return visibility;
}
