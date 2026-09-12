// @ts-expect-error -- prismjs does not declare default export for prism-core
import Prism from "prismjs/components/prism-core";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-css";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import { useEffect, useState } from "react";

export interface HighlightToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

export const MAX_HIGHLIGHT_CHARS = 100_000;

const ANSI_DARK_COLORS: Record<number, string> = {
  30: "#8b949e",
  31: "#ff7b72",
  32: "#7ee787",
  33: "#d29922",
  34: "#58a6ff",
  35: "#bc8cff",
  36: "#39c5cf",
  37: "#f0f6fc",
  90: "#8b949e",
  91: "#ffa198",
  92: "#56d364",
  93: "#e3b341",
  94: "#79c0ff",
  95: "#d2a8ff",
  96: "#56d4dd",
  97: "#ffffff",
};

const ANSI_LIGHT_COLORS: Record<number, string> = {
  30: "#24292f",
  31: "#cf222e",
  32: "#116329",
  33: "#9a6700",
  34: "#0969da",
  35: "#8250df",
  36: "#1b7c83",
  37: "#57606a",
  90: "#6e7781",
  91: "#a40e26",
  92: "#1a7f37",
  93: "#633c01",
  94: "#0550ae",
  95: "#6639ba",
  96: "#0969da",
  97: "#24292f",
};

function parseAnsiToLines(code: string, dark: boolean): HighlightToken[][] {
  const lines: HighlightToken[][] = [];
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\u001b\[([0-9;]*)m/g;
  const colors = dark ? ANSI_DARK_COLORS : ANSI_LIGHT_COLORS;
  let currentColor: string | undefined;
  let currentFontStyle = 0;

  for (const rawLine of code.split("\n")) {
    const currentLine: HighlightToken[] = [];
    lines.push(currentLine);
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    ansiRegex.lastIndex = 0;

    while ((match = ansiRegex.exec(rawLine)) !== null) {
      const textBefore = rawLine.slice(lastIndex, match.index);
      if (textBefore.length > 0) {
        currentLine.push({
          content: textBefore,
          color: currentColor,
          fontStyle: currentFontStyle || undefined,
        });
      }
      lastIndex = ansiRegex.lastIndex;
      const codes = match[1] ? match[1].split(";").map(Number) : [0];
      let idx = 0;
      while (idx < codes.length) {
        const c = codes[idx]!;
        if (c === 0) {
          currentColor = undefined;
          currentFontStyle = 0;
          idx++;
        } else if (c === 1) {
          currentFontStyle |= 2;
          idx++;
        } else if (c === 3) {
          currentFontStyle |= 1;
          idx++;
        } else if (c === 4) {
          currentFontStyle |= 4;
          idx++;
        } else if (c === 22) {
          currentFontStyle &= ~2;
          idx++;
        } else if (c === 23) {
          currentFontStyle &= ~1;
          idx++;
        } else if (c === 24) {
          currentFontStyle &= ~4;
          idx++;
        } else if (c === 39) {
          currentColor = undefined;
          idx++;
        } else if (c === 38 || c === 48) {
          const isFg = c === 38;
          const mode = codes[idx + 1];
          if (mode === 5) {
            const colorIdx = codes[idx + 2];
            if (colorIdx !== undefined && isFg) {
              if (colorIdx < 16) {
                currentColor = colors[colorIdx < 8 ? 30 + colorIdx : 90 + (colorIdx - 8)];
              } else {
                currentColor = colors[97];
              }
            }
            idx += 3;
          } else if (mode === 2) {
            const r = codes[idx + 2];
            const g = codes[idx + 3];
            const b = codes[idx + 4];
            if (r !== undefined && g !== undefined && b !== undefined && isFg) {
              currentColor = `rgb(${r},${g},${b})`;
            }
            idx += 5;
          } else {
            idx++;
          }
        } else if (colors[c]) {
          currentColor = colors[c];
          idx++;
        } else {
          idx++;
        }
      }
    }
    const remaining = rawLine.slice(lastIndex);
    if (remaining.length > 0) {
      currentLine.push({
        content: remaining,
        color: currentColor,
        fontStyle: currentFontStyle || undefined,
      });
    }
  }

  return lines;
}

const DARK_COLORS: Record<string, string> = {
  selector: "#ff7b72",
  important: "#ff7b72",
  atrule: "#ff7b72",
  string: "#a5d6ff",
  char: "#a5d6ff",
  "attr-value": "#a5d6ff",
  comment: "#8b949e",
  prolog: "#8b949e",
  doctype: "#8b949e",
  cdata: "#8b949e",
  function: "#d2a8ff",
  "function-variable": "#d2a8ff",
  method: "#d2a8ff",
  number: "#79c0ff",
  boolean: "#79c0ff",
  constant: "#79c0ff",
  operator: "#ff7b72",
  punctuation: "#8b949e",
  property: "#7ee787",
  "class-name": "#ffa657",
  variable: "#ffa657",
  builtin: "#7ee787",
  tag: "#7ee787",
  "attr-name": "#79c0ff",
  regex: "#7ee787",
};

const LIGHT_COLORS: Record<string, string> = {
  keyword: "#cf222e",
  selector: "#cf222e",
  important: "#cf222e",
  atrule: "#cf222e",
  string: "#0a3069",
  char: "#0a3069",
  "attr-value": "#0a3069",
  comment: "#6e7781",
  prolog: "#6e7781",
  doctype: "#6e7781",
  cdata: "#6e7781",
  function: "#8250df",
  "function-variable": "#8250df",
  method: "#8250df",
  number: "#0550ae",
  boolean: "#0550ae",
  constant: "#0550ae",
  operator: "#cf222e",
  punctuation: "#57606a",
  property: "#116329",
  "class-name": "#953800",
  variable: "#953800",
  builtin: "#116329",
  tag: "#116329",
  "attr-name": "#0550ae",
  regex: "#116329",
};

function parseHexColor(value: string): [number, number, number] | null {
  const match = value.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!match) return null;
  const hex = match[1];
  if (!hex) return null;
  if (hex.length === 3) {
    return [
      Number.parseInt(`${hex[0]}${hex[0]}`, 16),
      Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      Number.parseInt(`${hex[2]}${hex[2]}`, 16),
    ];
  }
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

export function isDarkSurface(color: string): boolean {
  const rgb = parseHexColor(color);
  if (!rgb) return true;
  const channels = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    0.2126 * (channels[0] ?? 0) +
    0.7152 * (channels[1] ?? 0) +
    0.0722 * (channels[2] ?? 0);
  return luminance < 0.5;
}

function normalizeLanguage(language: string): string | null {
  const normalized = language.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "shell" || normalized === "sh") return "bash";
  if (normalized === "ansi") return "ansi";
  if (normalized === "text" || normalized === "plain") return "text";
  const aliases: Record<string, string> = {
    js: "javascript",
    jsx: "jsx",
    md: "markdown",
    py: "python",
    sh: "bash",
    ts: "typescript",
    tsx: "tsx",
    yml: "yaml",
    html: "markup",
    xml: "markup",
  };
  const resolved = aliases[normalized] ?? normalized;
  return resolved in Prism.languages ? resolved : null;
}

function resolveTokenColor(type: string, dark: boolean): string | undefined {
  const palette = dark ? DARK_COLORS : LIGHT_COLORS;
  return palette[type];
}

function tokenizeToLines(code: string, grammar: Prism.Grammar, dark: boolean): HighlightToken[][] {
  const rawTokens = Prism.tokenize(code, grammar);
  const lines: HighlightToken[][] = [[]];

  function pushText(content: string, type?: string) {
    const parts = content.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      const part = parts[i];
      if (part && part.length > 0) {
        const currentLine = lines[lines.length - 1];
        if (currentLine) {
          currentLine.push({
            content: part,
            color: type ? resolveTokenColor(type, dark) : undefined,
            fontStyle: type === "comment" ? 1 : undefined,
          });
        }
      }
    }
  }

  function walk(token: string | Prism.Token | (string | Prism.Token)[], parentType?: string) {
    if (typeof token === "string") {
      pushText(token, parentType);
    } else if (Array.isArray(token)) {
      for (const item of token) walk(item, parentType);
    } else if (token && typeof token === "object") {
      const type = token.type || parentType;
      if (typeof token.content === "string") {
        pushText(token.content, type);
      } else {
        walk(token.content, type);
      }
    }
  }

  for (const token of rawTokens) walk(token);
  return lines;
}

const tokenCache = new Map<string, HighlightToken[][]>();
const TOKEN_CACHE_LIMIT = 80;

function cacheKey(code: string, language: string, dark: boolean): string {
  return `${dark ? "dark" : "light"}:${language}:${code}`;
}

function cacheTokens(key: string, tokens: HighlightToken[][]): void {
  if (tokenCache.has(key)) tokenCache.delete(key);
  else if (tokenCache.size >= TOKEN_CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
  tokenCache.set(key, tokens);
}

export function highlightCodeSync(
  code: string,
  language: string,
  dark: boolean,
): HighlightToken[][] | null {
  if (!code || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const normalizedLanguage = normalizeLanguage(language);
  if (!normalizedLanguage) return null;

  const key = cacheKey(code, normalizedLanguage, dark);
  const cached = tokenCache.get(key);
  if (cached) {
    tokenCache.delete(key);
    tokenCache.set(key, cached);
    return cached;
  }

  let tokens: HighlightToken[][];
  if (normalizedLanguage === "ansi") {
    tokens = parseAnsiToLines(code, dark);
  } else if (normalizedLanguage === "text") {
    tokens = code.split("\n").map((line) => [{ content: line }]);
  } else {
    const grammar = Prism.languages[normalizedLanguage];
    if (!grammar) return null;
    tokens = tokenizeToLines(code, grammar, dark);
  }

  cacheTokens(key, tokens);
  return tokens;
}

export async function highlightCode(
  code: string,
  language: string,
  dark: boolean,
): Promise<HighlightToken[][] | null> {
  return highlightCodeSync(code, language, dark);
}

export function useHighlightTokens(
  code: string | undefined,
  language: string | undefined,
  dark: boolean,
): HighlightToken[][] | null {
  const [tokens, setTokens] = useState<HighlightToken[][] | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!code || !language) {
      setTokens(null);
      return () => {};
    }

    const normalizedLanguage = normalizeLanguage(language);
    if (normalizedLanguage) {
      const cached = tokenCache.get(cacheKey(code, normalizedLanguage, dark));
      if (cached) {
        setTokens(cached);
        return () => {};
      }
    }

    setTokens(null);
    const timer = setTimeout(() => {
      if (cancelled) return;
      const result = highlightCodeSync(code, language, dark);
      if (!cancelled) setTokens(result);
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, language, dark]);

  return tokens;
}
