import { useSyncExternalStore } from "react";

interface OpenPopup {
  agentId: string;
  openPanel(): void;
}

let popup: OpenPopup | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

export function openPiTasksPopup(input: OpenPopup): void {
  popup = input;
  publish();
}

export function closePiTasksPopup(): void {
  if (popup === null) return;
  popup = null;
  publish();
}

export function getPiTasksPopup(): OpenPopup | null {
  return popup;
}

export function usePiTasksPopup(): OpenPopup | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPiTasksPopup,
    () => null,
  );
}
