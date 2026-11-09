import { useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";

/** iOS reports `inactive` for the notification shade, calls and the app switcher; it hides the view like `background`. */
export const isForeground = (state: AppStateStatus | null | undefined) => state !== "background" && state !== "inactive";

// One AppState subscription shared by every poller and animation of the plugin, instead of one per hook.
let current = isForeground(AppState.currentState);
const listeners = new Set<() => void>();
let subscription: { remove: () => void } | undefined;
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!subscription) {
    current = isForeground(AppState.currentState);
    subscription = AppState.addEventListener("change", state => {
      const next = isForeground(state);
      if (next !== current) { current = next; for (const notify of listeners) notify(); }
    });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { subscription?.remove(); subscription = undefined; }
  };
}
export function useForeground(): boolean {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
