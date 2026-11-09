/**
 * 0.9.0 (issue #3): the code font of activity rows. Only text drawn in `fontFamily: "monospace"` changes: summaries,
 * paths, commands, code, diffs, tool output and thinking text. Titles, labels and notes keep their typography.
 */
export const TEXT_SIZES = ["small", "standard", "large", "larger"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const LINE_SPACINGS = ["compact", "standard", "relaxed"] as const;
export type LineSpacing = (typeof LINE_SPACINGS)[number];
export const DEFAULT_TEXT_SIZE: TextSize = "standard";
export const DEFAULT_LINE_SPACING: LineSpacing = "standard";
export const MONO_FONT_MAX = 200;

/** 12 px (the rows' code size) becomes 11, 12, 14 and 16 px. */
const SIZE_SCALE: Record<TextSize, number> = { small: 11 / 12, standard: 1, large: 14 / 12, larger: 16 / 12 };
const LINE_SCALE: Record<LineSpacing, number> = { compact: 0.88, standard: 1, relaxed: 1.25 };

const GENERIC_FAMILIES = new Set(["monospace", "ui-monospace", "sans-serif", "serif", "system-ui", "ui-sans-serif", "ui-serif", "cursive", "fantasy"]);
/** Letters, digits, spaces and `. _ + -`: enough for installed font names, and nothing that can end a CSS declaration. */
const FAMILY_NAME = /^[\p{L}\p{N} ._+-]+$/u;

/**
 * The user's font list as a CSS `font-family` value, every name quoted except generic keywords; `""` when empty and
 * null when any entry is not a plain font name. The value goes into a stylesheet, so this is the only gate.
 */
export function monoFontStack(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > MONO_FONT_MAX) return null;
  const names: string[] = [];
  for (const part of trimmed.split(",")) {
    let name = part.trim();
    const quote = name[0];
    if ((quote === '"' || quote === "'") && name.length >= 2 && name.endsWith(quote)) name = name.slice(1, -1).trim();
    if (!name || !FAMILY_NAME.test(name)) return null;
    name = name.replace(/\s+/g, " ");
    names.push(GENERIC_FAMILIES.has(name.toLowerCase()) ? name.toLowerCase() : `"${name}"`);
  }
  return names.join(", ");
}

export interface Typography {
  /** Font size factor of code text. */
  scale: number;
  /** Line height factor on top of `scale`. */
  line: number;
  /** CSS font stack for web, already ending in the plugin's default stack; undefined keeps `monospace`. */
  family?: string;
}

export const DEFAULT_TYPOGRAPHY: Typography = { scale: 1, line: 1 };
const cache = new Map<string, Typography>();

/** Stable objects per input, so style memos only rebuild when the setting changes. */
export function typography(size: TextSize, spacing: LineSpacing, family?: string): Typography {
  if (size === DEFAULT_TEXT_SIZE && spacing === DEFAULT_LINE_SPACING && !family) return DEFAULT_TYPOGRAPHY;
  const id = `${size}|${spacing}|${family ?? ""}`;
  let value = cache.get(id);
  if (!value) cache.set(id, (value = { scale: SIZE_SCALE[size], line: LINE_SCALE[spacing], ...(family ? { family } : {}) }));
  return value;
}

type StyleRecord = Record<string, unknown>;

/** Applies the code font to every `fontFamily: "monospace"` style of a style map. The default returns the map unchanged. */
export function typeset<T extends Record<string, unknown>>(styles: T, type: Typography): T {
  if (type === DEFAULT_TYPOGRAPHY) return styles;
  const out: Record<string, unknown> = {};
  for (const [key, style] of Object.entries(styles)) out[key] = typesetStyle(style, type);
  return out as T;
}

/** One style object; anything that is not a monospace text style passes through. */
export function typesetStyle<S>(style: S, type: Typography): S {
  if (type === DEFAULT_TYPOGRAPHY || !style || typeof style !== "object" || (style as StyleRecord).fontFamily !== "monospace") return style;
  const source = style as StyleRecord;
  const next: StyleRecord = { ...source };
  if (type.family) next.fontFamily = type.family;
  const size = typeof source.fontSize === "number" ? source.fontSize : undefined;
  if (size !== undefined) next.fontSize = Math.round(size * type.scale * 2) / 2;
  if (typeof source.lineHeight === "number") next.lineHeight = Math.round(source.lineHeight * type.scale * type.line);
  return next as S;
}
