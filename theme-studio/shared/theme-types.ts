export interface ThemeStudioTokens {
  background: string;
  foreground: string;
  raised: string;
  control: string;
  border: string;
  ring: string;
  mutedForeground: string;
  accent: string;
}

export type ThemeAppearance = "dark" | "light";

export type ThemeTokenKey = keyof ThemeStudioTokens;

export interface ParsedColor {
  id: string;
  name: string;
  group: string;
  shade?: string;
  hex: string;
  luminance: number;
}

export interface ExtractedPalette {
  colors: ParsedColor[];
  format: "tailwind" | "css" | "json" | "hex-list" | "empty";
  groups: string[];
}

export interface ThemeStudioPreset {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  tokens: ThemeStudioTokens;
  rawInput?: string;
}
