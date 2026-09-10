import { diffLines } from "diff";
import type { JsonValue, ToolCallDetail, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PaletteMode } from "./settings";

export const TOOL_CATEGORIES = [
  "shell",
  "file",
  "search",
  "agent",
  "plan",
  "communication",
  "unknown",
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];
type ActivityCategory = ToolCategory | "reasoning";

export interface DiffStats {
  additions: number;
  deletions: number;
}

export interface DiffLine {
  kind: "add" | "remove" | "context" | "meta";
  text: string;
}

export interface ToolCallPresentation {
  category: ToolCategory;
  icon: string;
  label: string;
  summary?: string;
  filePath?: string;
  fileIcon?: string;
  language?: string;
  diffStats?: DiffStats;
}

export interface ActivityThemeColors {
  surface0: string;
  surface1: string;
  surface2: string;
  border: string;
  foreground: string;
  foregroundMuted: string;
  accent: string;
  accentForeground: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
}

export interface ActivityPalette {
  mode: PaletteMode;
  categoryColors: Record<ActivityCategory, string>;
  categoryBackgrounds: Record<ActivityCategory, string>;
  statusColors: {
    running: string;
    completed: string;
    failed: string;
    canceled: string;
  };
  statusBackgrounds: {
    running: string;
    completed: string;
    failed: string;
    canceled: string;
  };
  borderWidth: number;
}

const EXTENSION_LANGUAGE: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  htm: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  less: "css",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mts: "typescript",
  py: "python",
  pyw: "python",
  rs: "rust",
  sass: "css",
  scss: "css",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  vue: "html",
  wasm: "wasm",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const FILE_ICON_BY_EXTENSION: Record<string, string> = {
  c: "FileCode2",
  cc: "FileCode2",
  cpp: "FileCode2",
  cs: "FileCode2",
  css: "FileType",
  go: "FileCode2",
  h: "FileCode2",
  hpp: "FileCode2",
  html: "FileCode2",
  java: "FileCode2",
  js: "FileCode2",
  json: "FileJson",
  jsonc: "FileJson",
  jsx: "FileCode2",
  less: "FileType",
  md: "FileText",
  mdx: "FileText",
  mjs: "FileCode2",
  mts: "FileCode2",
  py: "FileCode2",
  pyw: "FileCode2",
  rs: "FileCode2",
  sass: "FileType",
  scss: "FileType",
  sh: "FileTerminal",
  sql: "FileCode2",
  ts: "FileCode2",
  tsx: "FileCode2",
  vue: "FileCode2",
  wasm: "FileCog",
  xml: "FileCode2",
  yaml: "FileCog",
  yml: "FileCog",
  zsh: "FileTerminal",
};

const FILE_ICON_BY_NAME: Record<string, string> = {
  ".env": "FileKey2",
  ".gitignore": "FileCog",
  dockerfile: "FileCog",
  "package-lock.json": "FileJson",
  "package.json": "FileJson",
  "pnpm-lock.yaml": "FileCog",
  "yarn.lock": "FileKey2",
};

const TOOL_ICON_NAMES: Record<string, string> = {
  bot: "Bot",
  brain: "Brain",
  eye: "Eye",
  mic_vocal: "MicVocal",
  pencil: "Pencil",
  paseo: "Sparkles",
  search: "Search",
  sparkles: "Sparkles",
  square_terminal: "SquareTerminal",
  wrench: "Wrench",
};

function compactText(value: string, maxLength = 180): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1)?.toLowerCase() ?? filePath.toLowerCase();
}

export function extensionFromPath(filePath: string | undefined): string | null {
  if (!filePath) return null;
  const name = fileName(filePath);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1);
}

export function languageForFilePath(filePath: string | undefined): string | undefined {
  const extension = extensionFromPath(filePath);
  return extension ? EXTENSION_LANGUAGE[extension] : undefined;
}

export function fileIconForPath(filePath: string | undefined): string {
  if (!filePath) return "File";
  const name = fileName(filePath);
  const byName = FILE_ICON_BY_NAME[name];
  if (byName) return byName;
  const extension = extensionFromPath(filePath);
  return (extension && FILE_ICON_BY_EXTENSION[extension]) || "File";
}

function iconNameFromProtocol(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return TOOL_ICON_NAMES[value] ?? value;
}

function prettyToolName(name: string): string {
  const normalized = name.trim().replace(/[._-]+/g, " ");
  if (!normalized) return "Tool";
  return normalized
    .split(/\s+/)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function countLines(value: string): number {
  if (!value) return 0;
  const lines = value.replace(/\r/g, "").split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function diffStatsFromUnifiedDiff(unifiedDiff: string): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const line of unifiedDiff.replace(/\r/g, "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export function diffStatsFromStrings(oldString: string, newString: string): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(oldString, newString)) {
    if (change.added) additions += countLines(change.value);
    if (change.removed) deletions += countLines(change.value);
  }
  return { additions, deletions };
}

export function diffStatsForDetail(detail: Extract<ToolCallDetail, { type: "edit" }>): DiffStats {
  if (detail.unifiedDiff !== undefined) return diffStatsFromUnifiedDiff(detail.unifiedDiff);
  return diffStatsFromStrings(detail.oldString ?? "", detail.newString ?? "");
}

function linesForChange(value: string): string[] {
  const normalized = value.replace(/\r/g, "");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function diffLinesForDetail(detail: Extract<ToolCallDetail, { type: "edit" }>): DiffLine[] {
  if (detail.unifiedDiff !== undefined) {
    return detail.unifiedDiff
      .replace(/\r/g, "")
      .split("\n")
      .filter((line, index, lines) => !(index === lines.length - 1 && line === ""))
      .map((line) => {
        if (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) {
          return { kind: "meta", text: line };
        }
        if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
        if (line.startsWith("-")) return { kind: "remove", text: line.slice(1) };
        if (line.startsWith(" ")) return { kind: "context", text: line.slice(1) };
        return { kind: "context", text: line };
      });
  }

  return diffLines(detail.oldString ?? "", detail.newString ?? "").flatMap((change) => {
    const kind = change.added ? "add" : change.removed ? "remove" : "context";
    return linesForChange(change.value).map((text) => ({ kind, text }));
  });
}

function shellSummary(detail: Extract<ToolCallDetail, { type: "shell" }>): string | undefined {
  return compactText(detail.command);
}

function detailFilePath(detail: ToolCallDetail): string | undefined {
  if (detail.type === "read" || detail.type === "edit" || detail.type === "write") {
    return detail.filePath || undefined;
  }
  return undefined;
}

export function resolveToolCallPresentation(
  item: Pick<ToolCallTimelineItem, "name" | "detail">,
): ToolCallPresentation {
  const name = item.name.trim().toLowerCase();
  const detail = item.detail;
  const filePath = detailFilePath(detail);
  const commonFileFields = filePath
    ? {
        filePath,
        fileIcon: fileIconForPath(filePath),
        language: languageForFilePath(filePath),
      }
    : {};

  switch (detail.type) {
    case "shell":
      return {
        category: "shell",
        icon: "SquareTerminal",
        label: "Shell Command",
        summary: shellSummary(detail),
      };
    case "worktree_setup":
      return {
        category: "shell",
        icon: "GitBranch",
        label: "Worktree Setup",
        summary: compactText(detail.branchName || detail.worktreePath),
      };
    case "read":
      return {
        category: "file",
        icon: commonFileFields.fileIcon ?? "Eye",
        label: "Read File",
        summary: compactText(detail.filePath),
        ...commonFileFields,
      };
    case "edit":
      return {
        category: "file",
        icon: commonFileFields.fileIcon ?? "Pencil",
        label: "Edit File",
        summary: compactText(detail.filePath),
        diffStats: diffStatsForDetail(detail),
        ...commonFileFields,
      };
    case "write":
      return {
        category: "file",
        icon: commonFileFields.fileIcon ?? "Pencil",
        label: "Write File",
        summary: compactText(detail.filePath),
        ...commonFileFields,
      };
    case "search":
      return {
        category: "search",
        icon: "Search",
        label: "Search",
        summary: compactText(detail.query),
      };
    case "fetch":
      return {
        category: "search",
        icon: "Globe",
        label: "Fetch URL",
        summary: compactText(detail.url),
      };
    case "sub_agent":
      return {
        category: "agent",
        icon: "Bot",
        label: "Sub-agent",
        summary: detail.description
          ? compactText(detail.description)
          : compactText(detail.subAgentType ?? ""),
      };
    case "plain_text":
      return {
        category: "communication",
        icon: iconNameFromProtocol(detail.icon) ?? "Wrench",
        label: detail.label || prettyToolName(item.name),
        summary: detail.text ? compactText(detail.text) : undefined,
      };
    case "plan":
      return {
        category: "plan",
        icon: "ListChecks",
        label: "Plan",
      };
    case "unknown":
      if (name === "thinking") {
        return { category: "plan", icon: "Brain", label: "Thinking" };
      }
      if (name === "task") {
        return { category: "agent", icon: "Bot", label: "Task", summary: compactText(item.name) };
      }
      if (name === "speak") {
        return { category: "communication", icon: "MicVocal", label: "Speak" };
      }
      return {
        category: "unknown",
        icon: "Wrench",
        label: prettyToolName(item.name),
      };
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

function tintColor(color: string, alpha: number, fallback: string): string {
  const rgb = parseHexColor(color);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : fallback;
}

export function resolveActivityPalette(
  mode: PaletteMode,
  colors: ActivityThemeColors,
): ActivityPalette {
  const alpha = mode === "vivid" ? 0.18 : mode === "high_contrast" ? 0.28 : 0.1;
  const categoryColors: Record<ActivityCategory, string> = {
    reasoning: colors.accent,
    shell: colors.statusWarning,
    file: colors.accent,
    search: colors.accent,
    agent: colors.statusSuccess,
    plan: colors.accent,
    communication: colors.accent,
    unknown: colors.foregroundMuted,
  };
  const statusColors = {
    running: colors.accent,
    completed: colors.statusSuccess,
    failed: colors.statusDanger,
    canceled: colors.foregroundMuted,
  };
  const categoryBackgrounds = Object.fromEntries(
    Object.entries(categoryColors).map(([category, color]) => [
      category,
      tintColor(color, alpha, colors.surface2),
    ]),
  ) as Record<ActivityCategory, string>;
  const statusBackgrounds = Object.fromEntries(
    Object.entries(statusColors).map(([status, color]) => [
      status,
      tintColor(color, alpha, colors.surface2),
    ]),
  ) as ActivityPalette["statusBackgrounds"];
  return {
    mode,
    categoryColors,
    categoryBackgrounds,
    statusColors,
    statusBackgrounds,
    borderWidth: mode === "high_contrast" ? 2 : 1,
  };
}

export function toJsonValue(value: unknown): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : (JSON.parse(serialized) as JsonValue);
  } catch {
    return null;
  }
}

export function formatUnknownValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatError(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  const text = typeof error === "string" ? error : formatUnknownValue(error);
  return compactText(text, 400);
}

export function formatReasoningText(text: string): string {
  if (!text) return "";
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(/(\*\*[^*\s\n](?:[^*\n]*?[^*\s\n])?\*\*)\s*(?=\*\*)/g, "$1\n\n");
    })
    .join("");
}
