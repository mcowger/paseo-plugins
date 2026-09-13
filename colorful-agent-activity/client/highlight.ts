// @ts-expect-error -- prismjs does not declare default export for prism-core
import Prism from "prismjs/components/prism-core";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-css";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import { useEffect, useState } from "react";

// Lightweight regex grammar for Bash (avoids large stateful prism-bash dependency)
Prism.languages.bash = {
  comment: { pattern: /(^|[\t ])#.*/m, lookbehind: true, greedy: true },
  string: { pattern: /"(?:\\[\s\S]|[^"\\])*"|'[^']*'/, greedy: true },
  variable: /\$(?:\w+|\{[^}\r\n]*\}|[?$!#@*-])/,
  keyword: /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|select|return|export|local)\b/,
  builtin: /\b(?:test|echo|cd|pwd|ls|cat|mkdir|rm|cp|mv|touch|grep|find|sed|awk|curl|git|node|npm|bun|deno)\b/,
  operator: /&&|\|\||[|&;<>]/,
  punctuation: /[(){}[\]]/,
};

export interface ThemeSyntaxColors {
  foreground: string;
  foregroundMuted: string;
  accent: string;
  surface1?: string;
  statusSuccess?: string;
  statusWarning?: string;
  statusDanger?: string;
}

export type SyntaxColorsInput = ThemeSyntaxColors | boolean;

const DEFAULT_DARK_COLORS: ThemeSyntaxColors = {
  foreground: "#e6edf3",
  foregroundMuted: "#8b949e",
  accent: "#58a6ff",
  statusSuccess: "#7ee787",
  statusWarning: "#d29922",
  statusDanger: "#ff7b72",
};

const DEFAULT_LIGHT_COLORS: ThemeSyntaxColors = {
  foreground: "#1f2328",
  foregroundMuted: "#656d76",
  accent: "#0969da",
  statusSuccess: "#1a7f37",
  statusWarning: "#9a6700",
  statusDanger: "#cf222e",
};

export function resolveSyntaxColors(input: SyntaxColorsInput): ThemeSyntaxColors {
  if (typeof input === "boolean") {
    return input ? DEFAULT_DARK_COLORS : DEFAULT_LIGHT_COLORS;
  }
  return input;
}

export interface HighlightToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

export const MAX_HIGHLIGHT_CHARS = 100_000;

function parseAnsiToLines(code: string, colors: ThemeSyntaxColors): HighlightToken[][] {
  const lines: HighlightToken[][] = [];
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\u001b\[([0-9;]*)m/g;
  const ansiColors: Record<number, string> = {
    30: colors.foregroundMuted,
    31: colors.statusDanger ?? "#ff7b72",
    32: colors.statusSuccess ?? "#7ee787",
    33: colors.statusWarning ?? "#d29922",
    34: colors.accent,
    35: colors.accent,
    36: colors.accent,
    37: colors.foreground,
    90: colors.foregroundMuted,
    91: colors.statusDanger ?? "#ff7b72",
    92: colors.statusSuccess ?? "#7ee787",
    93: colors.statusWarning ?? "#d29922",
    94: colors.accent,
    95: colors.accent,
    96: colors.accent,
    97: colors.foreground,
  };
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
                currentColor = ansiColors[colorIdx < 8 ? 30 + colorIdx : 90 + (colorIdx - 8)];
              } else {
                currentColor = colors.foreground;
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
        } else if (ansiColors[c]) {
          currentColor = ansiColors[c];
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

function resolveTokenColor(type: string, colors: ThemeSyntaxColors): string {
  switch (type) {
    case "comment":
    case "prolog":
    case "doctype":
    case "cdata":
    case "punctuation":
    case "operator":
      return colors.foregroundMuted;

    case "string":
    case "char":
    case "attr-value":
    case "regex":
    case "template-string":
      return colors.statusSuccess ?? colors.accent;

    case "keyword":
    case "selector":
    case "important":
    case "atrule":
    case "boolean":
      return colors.accent;

    case "number":
    case "constant":
      return colors.statusWarning ?? colors.accent;

    case "function":
    case "function-variable":
    case "method":
    case "builtin":
    case "class-name":
      return colors.accent;

    case "variable":
    case "property":
    case "tag":
    case "attr-name":
    default:
      return colors.foreground;
  }
}

function tokenizeToLines(code: string, grammar: Prism.Grammar, colors: ThemeSyntaxColors): HighlightToken[][] {
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
            color: type ? resolveTokenColor(type, colors) : colors.foreground,
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

const tokenCache = new Map<string, { tokens: HighlightToken[][]; size: number }>();
const TOKEN_CACHE_LIMIT = 40;
let cachedChars = 0;

function colorsKey(colors: ThemeSyntaxColors): string {
  return [
    colors.foreground,
    colors.foregroundMuted,
    colors.accent,
    colors.statusSuccess ?? "",
    colors.statusWarning ?? "",
    colors.statusDanger ?? "",
  ].join("|");
}

function cacheKey(code: string, language: string, colors: ThemeSyntaxColors): string {
  return `${colorsKey(colors)}:${language}:${code}`;
}

function cacheTokens(key: string, tokens: HighlightToken[][], codeLength: number): void {
  if (tokenCache.has(key)) {
    const existing = tokenCache.get(key)!;
    cachedChars -= existing.size;
    tokenCache.delete(key);
  }
  tokenCache.set(key, { tokens, size: codeLength });
  cachedChars += codeLength;

  while (tokenCache.size > TOKEN_CACHE_LIMIT || cachedChars > 500_000) {
    const oldestKey = tokenCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = tokenCache.get(oldestKey);
    if (oldest) cachedChars -= oldest.size;
    tokenCache.delete(oldestKey);
  }
}

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

export function highlightCodeSync(
  code: string,
  language: string,
  colorsInput: SyntaxColorsInput,
): HighlightToken[][] | null {
  if (!code || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const normalizedLanguage = normalizeLanguage(language);
  if (!normalizedLanguage) return null;

  const colors = resolveSyntaxColors(colorsInput);
  const key = cacheKey(code, normalizedLanguage, colors);
  const cached = tokenCache.get(key);
  if (cached) {
    tokenCache.delete(key);
    tokenCache.set(key, cached);
    return cached.tokens;
  }

  let tokens: HighlightToken[][];
  if (normalizedLanguage === "ansi") {
    tokens = parseAnsiToLines(code, colors);
  } else if (normalizedLanguage === "text") {
    tokens = code.split("\n").map((line) => [{ content: line }]);
  } else {
    const grammar = Prism.languages[normalizedLanguage];
    if (!grammar) return null;
    tokens = tokenizeToLines(code, grammar, colors);
  }

  cacheTokens(key, tokens, code.length);
  return tokens;
}

export async function highlightCode(
  code: string,
  language: string,
  colorsInput: SyntaxColorsInput,
): Promise<HighlightToken[][] | null> {
  return highlightCodeSync(code, language, colorsInput);
}

export function useHighlightTokens(
  code: string | undefined,
  language: string | undefined,
  colorsInput: SyntaxColorsInput,
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
      const colors = resolveSyntaxColors(colorsInput);
      const cached = tokenCache.get(cacheKey(code, normalizedLanguage, colors));
      if (cached) {
        setTokens(cached.tokens);
        return () => {};
      }
    }

    setTokens(null);
    const timer = setTimeout(() => {
      if (cancelled) return;
      const result = highlightCodeSync(code, language, colorsInput);
      if (!cancelled) setTokens(result);
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, language, typeof colorsInput === "boolean" ? colorsInput : colorsKey(resolveSyntaxColors(colorsInput))]);

  return tokens;
}
