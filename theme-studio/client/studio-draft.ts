import type { ThemeAppearance, ThemeStudioTokens } from "../shared/theme-types.js";

export interface StudioDraft {
  rawInput: string;
  appearance: ThemeAppearance;
  tokens: ThemeStudioTokens;
  activePresetId: string;
}

let currentDraft: StudioDraft | null = null;

export function getStudioDraft(): StudioDraft | null {
  return currentDraft;
}

export function setStudioDraft(draft: StudioDraft): void {
  currentDraft = draft;
}

export function clearStudioDraft(): void {
  currentDraft = null;
}
