// @ts-expect-error -- prismjs does not declare default export for prism-core
import Prism from "prismjs/components/prism-core.min.js";
import "prismjs/components/prism-markup.min.js";
import "prismjs/components/prism-css.min.js";
import "prismjs/components/prism-clike.min.js";
import "prismjs/components/prism-javascript.min.js";
import "prismjs/components/prism-typescript.min.js";
import "prismjs/components/prism-jsx.min.js";
import "prismjs/components/prism-tsx.min.js";
import "prismjs/components/prism-python.min.js";
import "prismjs/components/prism-json.min.js";
import "prismjs/components/prism-yaml.min.js";
import "prismjs/components/prism-markdown.min.js";
import "prismjs/components/prism-go.min.js";
import "prismjs/components/prism-rust.min.js";
import { useEffect, useState } from "react";

/**
 * 本地补丁（0.6.0-local.3，codex-vivid-F6）：双引号字符串只从前面有偶数个反斜杠（包括 0 个）的引号开始，用后行断言判断，
 * 不吃掉前一个字符。0.6.0-local.2 用 `(^|[^\\])` 加 Prism 的 lookbehind，要借前一个字符，可前一个字符若已经属于上一个
 * token（相邻的字符串），就借不到：`"one""two"` 的第二段不上色，`'one'"two"'three'` 认出 `"'three'"`。转义的引号不当起点，
 * 一串 `\"\"\"…` 就不会从每个引号重扫到结尾（codex-vivid-F1）。先匹配引号再往回看（断言里带上这个引号）：断言放在引号前面，
 * 一长串反斜杠里的每个位置都要往回扫一遍，又成了平方级。后行断言在构造时试一下：不支持的旧引擎（Safari 16.3 及更早）
 * 退回 0.6.0 之前的写法（只有转义引号开头的少数写法颜色不同；特制输入上慢，由分块高亮的时限兜住）。
 */
export const BASH_STRING = (() => {
  try {
    return new RegExp(String.raw`"(?<=(?:^|[^\\])(?:\\\\)*")(?:\\[\s\S]|[^"\\])*"|'[^']*'`);
  } catch {
    return /"(?:\\[\s\S]|[^"\\])*"|'[^']*'/;
  }
})();

// Lightweight regex grammar for Bash (avoids large stateful prism-bash dependency)
// 本地补丁（0.6.0-local.2，codex-vivid-F1）：`${…}` 最多 256 个字符，`${${${…` 不再让每个起点都重扫到结尾。
// 0.11.0 命令着色丰富化：constant（true/false）、heredoc（<<EOF 到终止词：正文最多 6 行、每行
// ≤200 字符——锚点测试按行数而不是按字符数计，洪水输入线性有界）、
// 子壳 $()/反引号/字符串内的命令替换（parameter：flag）。
// 嵌套只用一级：prism-core 对自引用 inside（内层 = 含 subshell 的整份语法）必然栈溢出（最小复现
// XaaY 自引用即溢出），所以内层语法剥掉 subshell/backtick，天然无环；$() 里再有 $() 走普通文本。
const bashSubshell = { pattern: /\$\([^)]{0,400}\)/, greedy: true, inside: undefined as unknown as Prism.Grammar };
const bashBacktick = { pattern: /`[^`\r\n]{0,400}`/, greedy: true, inside: undefined as unknown as Prism.Grammar };
const bashStringInside = { subshell: bashSubshell, backtick: bashBacktick };
Prism.languages.bash = {
  comment: { pattern: /(^|[\t ])#.*/m, lookbehind: true, greedy: true },
  string: { pattern: BASH_STRING, greedy: true, inside: bashStringInside },
  variable: /\$(?:\w+|\{[^}\r\n]{0,256}\}|[?$!#@*-])/,
  subshell: bashSubshell,
  backtick: bashBacktick,
  heredoc: { pattern: /<<-?["']?(\w{1,64})["']?(?:[^\n]{0,120}(\n[^\n]{0,200}){0,6}?\n\1(?![\w])|(?=$|[\s|&;)<]))/m, greedy: true },
  keyword: /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|select|return|export|local)\b/,
  builtin: /\b(?:test|echo|cd|pwd|ls|cat|mkdir|rm|cp|mv|touch|grep|find|sed|awk|curl|git|node|npm|bun|deno)\b/,
  constant: /\b(?:true|false)\b/,
  parameter: { pattern: /(\s)--?[\w][\w=-]{0,40}/, lookbehind: true },
  operator: /&&|\|\||[|&;<>]/,
  punctuation: /[(){}[\]]/,
};
// 一级嵌套的内层语法：剥掉 subshell/backtick，字符串也不再下钻（字符串里的命令替换只在外层着色）。
const bashInner: Prism.Grammar = { ...Prism.languages.bash };
delete (bashInner as Record<string, unknown>).subshell;
delete (bashInner as Record<string, unknown>).backtick;
bashInner.string = { pattern: BASH_STRING, greedy: true };
bashSubshell.inside = bashInner;
bashBacktick.inside = bashInner;

export interface ThemeSyntaxColors {
  foreground: string;
  foregroundMuted: string;
  accent: string;
  surface1?: string;
  statusSuccess?: string;
  statusWarning?: string;
  statusDanger?: string;
  /** 0.11.0:命令着色的 vivid 派生扩展（仅命令行路径传入；其余代码高亮不受影响）。 */
  builtin?: string;
  keyword?: string;
  variable?: string;
  operator?: string;
  parameter?: string;
  constant?: string;
  heredoc?: string;
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
  // 0.11.0:命令着色路径传入的 vivid 派生色（builtin/keyword/variable/operator/parameter）优先命中。
  const override = (colors as unknown as Partial<Record<string, string>>)[type];
  if (override) return override;
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
    case "heredoc":
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

/**
 * 本地补丁（0.6.0-local.2，codex-vivid-F1 排查）：Prism 自带语法里有几十条正则在构造的输入上会平方级回溯（同一份高亮，4 000
 * 字符要几十到一百多毫秒，2 万字符几秒，10 万字符几十秒），一旦开始就停不下来。所以超过一块的代码按整行切块高亮：每块至多
 * HIGHLIGHT_CHUNK_CHARS 个字符（预览就是一块，和原来一样），尽量在空行处断开；每块之前看用时，过了 HIGHLIGHT_BUDGET_MS
 * 剩下的行就原样显示，比一块还长的单行也原样显示。普通代码一块一两毫秒，10 万字符照样整篇上色；跨块的多行注释或字符串在
 * 断开处颜色可能不对。
 */
export const HIGHLIGHT_CHUNK_CHARS = 4_000;
export const HIGHLIGHT_BUDGET_MS = 100;

function plainLine(line: string, colors: ThemeSyntaxColors): HighlightToken[] {
  return line ? [{ content: line, color: colors.foreground }] : [];
}

/** Lines of `code` highlighted chunk by chunk within the time budget; `now` is the clock (tests pass their own). */
export function tokenizeInChunks(code: string, grammar: Prism.Grammar, colors: ThemeSyntaxColors, now: () => number = Date.now): HighlightToken[][] {
  if (code.length <= HIGHLIGHT_CHUNK_CHARS) return tokenizeToLines(code, grammar, colors);
  const rows = code.split("\n");
  const lines: HighlightToken[][] = [];
  const started = now();
  let index = 0;
  while (index < rows.length && now() - started <= HIGHLIGHT_BUDGET_MS) {
    if (rows[index]!.length > HIGHLIGHT_CHUNK_CHARS) {
      lines.push(plainLine(rows[index]!, colors));
      index += 1;
      continue;
    }
    let end = index + 1;
    let size = rows[index]!.length;
    let blank = -1;
    while (end < rows.length && size + 1 + rows[end]!.length <= HIGHLIGHT_CHUNK_CHARS) {
      size += 1 + rows[end]!.length;
      if (!rows[end]!.trim() && size >= HIGHLIGHT_CHUNK_CHARS / 2) blank = end;
      end += 1;
    }
    if (end < rows.length && blank > index) end = blank + 1;
    lines.push(...tokenizeToLines(rows.slice(index, end).join("\n"), grammar, colors));
    index = end;
  }
  for (; index < rows.length; index++) lines.push(plainLine(rows[index]!, colors));
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
    // 0.11.0:override 槽位参与 key——调色板切换后同一命令必须重新着色（否则命中旧色缓存）。
    colors.builtin ?? "",
    colors.keyword ?? "",
    colors.variable ?? "",
    colors.operator ?? "",
    colors.parameter ?? "",
    colors.constant ?? "",
    colors.heredoc ?? "",
  ].join("|");
}

/**
 * 0.11.0:shell 行头首词加粗（fontStyle 位 2，渲染层已有位掩码→样式映射）。仅命令行路径调用；
 * 首个像命令词的 token 前若是注释/纯符号则不加粗。
 */
export function emphasizeShellHead(lines: HighlightToken[][]): HighlightToken[][] {
  for (const token of lines[0] ?? []) {
    const text = token.content.trim();
    if (!text || (token.fontStyle && token.fontStyle & 1)) continue;
    if (text.startsWith("#")) break;
    if (!/^[\w.$/{"']/.test(text)) continue;
    token.fontStyle = (token.fontStyle ?? 0) | 2;
    break;
  }
  return lines;
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
    tokens = tokenizeInChunks(code, grammar, colors);
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
