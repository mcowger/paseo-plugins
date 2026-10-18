/**
 * Derived theme colors.
 *
 * Paseo themes expose a small set of semantic tokens. Activity UI needs more
 * than that: a code surface one step below the canvas, rails and dividers
 * lighter than a full border, backgrounds behind changed diff lines. Those are
 * derived here from the tokens instead of being hardcoded, so every palette
 * mode and every Paseo theme keeps working.
 *
 * Every helper passes non-hex colors through untouched: Paseo themes may use
 * `rgb()`, `hsl()`, or named colors, and returning the input is always safer
 * than guessing at a format.
 *
 * Pure and dependency-free: runs in the client bundle on Hermes and in tests.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parse `#rgb`, `#rrggbb`, or `#rrggbbaa` into channels; null when it is not a hex color. */
export function parseHex(color: string): Rgb | null {
  const match = HEX.exec(color.trim());
  if (!match) return null;
  const digits = match[1]!;
  const expand = (chunk: string) => parseInt(chunk.length === 1 ? chunk + chunk : chunk, 16);
  if (digits.length === 3 || digits.length === 4) {
    return { r: expand(digits[0]!), g: expand(digits[1]!), b: expand(digits[2]!) };
  }
  return {
    r: expand(digits.slice(0, 2)),
    g: expand(digits.slice(2, 4)),
    b: expand(digits.slice(4, 6)),
  };
}

const toHex = (value: number) =>
  Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");

/** WCAG relative luminance, 0 (black) to 1 (white); undefined when the color is not hex. */
export function luminance(color: string): number | undefined {
  const rgb = parseHex(color);
  if (!rgb) return undefined;
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * The same color at a given opacity. `amount` is clamped to 0..1 and rounded to
 * 8-bit precision, so 0.6 gives `#rrrrrr99`. Full opacity and non-hex input
 * return the color unchanged.
 */
export function alpha(color: string, amount: number): string {
  const rgb = parseHex(color);
  if (!rgb || amount >= 1) return color;
  const byte = Math.round(Math.max(0, Math.min(1, amount)) * 255);
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}${toHex(byte)}`;
}

/** Blend two colors channel by channel; `t` is how much of `to` the result holds. */
export function mix(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return from;
  const ratio = Math.max(0, Math.min(1, t));
  return `#${toHex(a.r + (b.r - a.r) * ratio)}${toHex(a.g + (b.g - a.g) * ratio)}${toHex(a.b + (b.b - a.b) * ratio)}`;
}

/** Toward black. */
export function darken(color: string, amount: number): string {
  return mix(color, "#000000", amount);
}

/**
 * A surface one step below the canvas, for code and command output.
 *
 * Dark themes recess by darkening and can take a deeper step than light themes,
 * where contrast is easier to overdo.
 */
export function sunken(color: string, amount?: number): string {
  const l = luminance(color);
  if (l === undefined) return color;
  return darken(color, amount ?? (l > 0.5 ? 0.05 : 0.1));
}

/** A divider or guide: the border token, softened so it does not outrank content. */
export function rule(color: string, amount = 0.6): string {
  return alpha(color, amount);
}

/** A low-opacity wash of a semantic color, behind changed diff lines. */
export function tint(color: string, amount = 0.12): string {
  return alpha(color, amount);
}
