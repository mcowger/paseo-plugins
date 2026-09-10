import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import bash from "@shikijs/langs/bash";
import css from "@shikijs/langs/css";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import shellscript from "@shikijs/langs/shellscript";
import typescript from "@shikijs/langs/typescript";
import yaml from "@shikijs/langs/yaml";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import { useEffect, useState } from "react";

export interface ShikiToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

export const MAX_HIGHLIGHT_CHARS = 100_000;

const SUPPORTED_LANGUAGES = new Set([
  "ansi",
  "bash",
  "css",
  "go",
  "html",
  "javascript",
  "json",
  "markdown",
  "python",
  "rust",
  "shellscript",
  "typescript",
  "yaml",
]);

const languageModules = [
  bash,
  css,
  go,
  html,
  javascript,
  json,
  markdown,
  python,
  rust,
  shellscript,
  typescript,
  yaml,
];

const themes = [githubDark, githubLight];

type ShikiHighlighter = {
  codeToTokensBase(code: string, options: { lang: string; theme: string }): ShikiToken[][];
};

let highlighterPromise: Promise<ShikiHighlighter> | null = null;
const tokenCache = new Map<string, ShikiToken[][]>();
const TOKEN_CACHE_LIMIT = 80;

function getHighlighter(): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      langs: languageModules,
      themes,
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    }) as Promise<ShikiHighlighter>;
  }
  return highlighterPromise;
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
  const aliases: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    md: "markdown",
    py: "python",
    sh: "bash",
    ts: "typescript",
    tsx: "typescript",
    yml: "yaml",
  };
  const alias = aliases[normalized] ?? normalized;
  if (SUPPORTED_LANGUAGES.has(alias)) return alias;
  return "text";
}

function cacheKey(code: string, language: string, theme: string): string {
  return `${theme}:${language}:${code}`;
}

function cacheTokens(key: string, tokens: ShikiToken[][]): void {
  if (tokenCache.has(key)) tokenCache.delete(key);
  else if (tokenCache.size >= TOKEN_CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
  tokenCache.set(key, tokens);
}

export async function highlightCode(
  code: string,
  language: string,
  dark: boolean,
): Promise<ShikiToken[][] | null> {
  if (!code || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const normalizedLanguage = normalizeLanguage(language);
  if (!normalizedLanguage) return null;
  const theme = dark ? "github-dark" : "github-light";
  const key = cacheKey(code, normalizedLanguage, theme);
  const cached = tokenCache.get(key);
  if (cached) {
    tokenCache.delete(key);
    tokenCache.set(key, cached);
    return cached;
  }

  try {
    const highlighter = await getHighlighter();
    const tokens = highlighter.codeToTokensBase(code, {
      lang: normalizedLanguage,
      theme,
    });
    cacheTokens(key, tokens);
    return tokens;
  } catch {
    return null;
  }
}

export function useShikiTokens(
  code: string | undefined,
  language: string | undefined,
  dark: boolean,
): ShikiToken[][] | null {
  const [tokens, setTokens] = useState<ShikiToken[][] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTokens(null);
    if (!code || !language) return () => {};
    void highlightCode(code, language, dark).then((nextTokens) => {
      if (!cancelled) setTokens(nextTokens);
    });
    return () => {
      cancelled = true;
    };
  }, [code, dark, language]);

  return tokens;
}
