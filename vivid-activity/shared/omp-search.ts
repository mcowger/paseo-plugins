export interface OmpSearchResult {
  pattern?: string;
  path?: string;
  matches: { path: string; line?: number; text?: string }[];
  files: string[];
  fileMatches: { path: string; count?: number }[];
  text: string[];
  error?: string;
  truncated: boolean;
  matchCount?: number;
  fileCount?: number;
  meta: Record<string, unknown> | null;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : null;
}
function outputTexts(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\r?\n/).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = record(entry);
    return typeof item?.text === "string" ? item.text.split(/\r?\n/).filter(Boolean) : [];
  });
}
function parseMatchLine(line: string): { path: string; line?: number; text?: string } | null {
  const match = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!match) return null;
  return { path: match[1], line: Number(match[2]), text: match[3] };
}

export function parseOmpSearchResult(input: unknown, output: unknown, kind?: "grep" | "glob"): OmpSearchResult {
  const args = record(input);
  const envelope = record(output);
  const details = record(envelope?.details);
  const files = Array.isArray(details?.files) ? details.files.filter((item): item is string => typeof item === "string") : [];
  const fileMatches = Array.isArray(details?.fileMatches) ? details.fileMatches.flatMap((raw) => {
    const item = record(raw);
    if (typeof item?.path !== "string") return [];
    return [{ path: item.path, ...(typeof item.count === "number" ? { count: item.count } : {}) }];
  }) : [];
  const rawMatches = Array.isArray(details?.matches) ? details.matches : [];
  const matches = rawMatches.flatMap((raw) => {
    const item = record(raw);
    const path = item?.path ?? item?.file ?? item?.rel;
    if (typeof path !== "string") return [];
    return [{ path, ...(typeof item?.line === "number" ? { line: item.line } : {}), ...(typeof item?.text === "string" ? { text: item.text } : {}) }];
  });
  const content = outputTexts(envelope?.content);
  const displayContent = outputTexts(details?.displayContent);
  const plain = content.length ? content : displayContent.length ? displayContent : outputTexts(output);
  const parsedLines = plain.flatMap((line) => parseMatchLine(line) ?? []);
  const errorValue = envelope?.error;
  const error = typeof errorValue === "string" ? errorValue : typeof record(errorValue)?.message === "string" ? record(errorValue)?.message as string : undefined;
  const pattern = typeof args?.pattern === "string" ? args.pattern : typeof args?.query === "string" ? args.query : kind === "glob" && typeof args?.path === "string" ? args.path : undefined;
  return {
    ...(pattern !== undefined ? { pattern } : {}),
    ...(typeof args?.path === "string" && kind !== "glob" ? { path: args.path } : {}),
    matches: matches.length ? matches : parsedLines,
    files: files.length ? files : fileMatches.length ? fileMatches.map((item) => item.path) : parsedLines.length ? [] : plain,
    fileMatches,
    text: plain,
    ...(error ? { error } : {}),
    truncated: details?.truncated === true || plain.some((line) => /truncat|output limit/i.test(line)),
    ...(typeof details?.matchCount === "number" ? { matchCount: details.matchCount } : {}),
    ...(typeof details?.fileCount === "number" ? { fileCount: details.fileCount } : {}),
    meta: record(details?.meta),
  };
}

// Exact tool name, optionally with OMP's namespace, is required: other providers also expose grep/glob.
export function isOmpGrepTool(toolName: string): boolean { return /^(?:(?:functions|tools)\.)?grep$/i.test(toolName.trim()); }
export function isOmpGlobTool(toolName: string): boolean { return /^(?:(?:functions|tools)\.)?glob$/i.test(toolName.trim()); }
