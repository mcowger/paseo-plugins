type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function normalizeToolName(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/^(?:functions|tools)\./, "")
    .replace(/^mcp__.*?__/, "")
    .replace(/^mcp_/, "");
}

/** Whether a tool name is Opencode v2 Code Mode's single `execute` tool. */
export function isCodeModeTool(toolName: string): boolean {
  return normalizeToolName(toolName) === "execute";
}

function parseJsonInput(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function decodeInput(value: unknown): JsonRecord | undefined {
  if (typeof value === "string" && value.length <= 1_000_000) {
    const parsed = parseJsonInput(value);
    if (asRecord(parsed)) return parsed as JsonRecord;
    return undefined;
  }
  return asRecord(value) ?? undefined;
}

/** Extract the confined script from an `execute` tool input. */
export function extractCodeModeCode(input: unknown): string | undefined {
  const record = decodeInput(input);
  const code = record?.code;
  return typeof code === "string" && code.trim() ? code : undefined;
}

export interface CodeModeCall {
  path: string;
  server: string;
  tool: string;
  query?: string;
}

export interface CodeModeCalls {
  searchQuery?: string;
  calls: CodeModeCall[];
}

const GLOBAL_NAMESPACES = new Set([
  "promise",
  "json",
  "object",
  "math",
  "string",
  "number",
  "array",
  "console",
  "codemode",
]);

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^\S:;{([,=!+\-*/|&?:])\/\/[^\n]*/g, "$1");
}

function firstStringLiteral(slice: string, key: string): string | undefined {
  const pattern = new RegExp(
    `${key}\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'|\`((?:[^\`\\\\]|\\\\.)*)\`)`,
  );
  const match = slice.match(pattern);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  if (raw === undefined) return undefined;
  const unescaped = raw.replace(/\\(.)/g, "$1").replace(/\s+/g, " ").trim();
  return unescaped || undefined;
}

function parseSearchQuery(code: string): string | undefined {
  const pattern = /(?:\$codemode\.search|(?:^|[^\w$.])search)\s*\(\s*\{([\s\S]{0,2000}?)\}/g;
  let match: RegExpExecArray | null = null;
  let found: string | undefined;
  while ((match = pattern.exec(code)) !== null) {
    const query = firstStringLiteral(match[1] ?? "", "query");
    if (query) {
      found = query;
      break;
    }
  }
  return found;
}

function parseDottedCalls(code: string): CodeModeCall[] {
  const cleaned = stripComments(code);
  const pattern = /(?:^|[^\w$])([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)(?:\.([A-Za-z][A-Za-z0-9_]*))?\s*\(/g;
  const calls: CodeModeCall[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(cleaned)) !== null) {
    const first = match[1] ?? "";
    const second = match[2] ?? "";
    const third = match[3];
    if (!first || !second) continue;
    if (GLOBAL_NAMESPACES.has(first.toLowerCase())) continue;
    let server = first;
    let tool = second;
    if (third && first.toLowerCase() === "tools") {
      server = second;
      tool = third;
    } else if (third) {
      continue;
    }
    if (server.toLowerCase() === "$codemode") continue;
    const path = `${server}.${tool}`;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const slice = cleaned.slice(match.index, match.index + 2000);
    const query =
      firstStringLiteral(slice, "query") ??
      firstStringLiteral(slice, "prompt") ??
      firstStringLiteral(slice, "url");
    calls.push({
      path,
      server,
      tool,
      ...(query ? { query } : {}),
    });
    if (calls.length >= 8) break;
  }
  return calls;
}

/**
 * Parse an Opencode Code Mode script for its discovery query and inner
 * namespaced tool calls. Regex-based so it stays Hermes-safe in the client.
 */
export function parseCodeModeCalls(code: string): CodeModeCalls {
  const source = code.length > 100_000 ? code.slice(0, 100_000) : code;
  const searchQuery = parseSearchQuery(source);
  const calls = parseDottedCalls(source).filter((call) => {
    if (call.server.toLowerCase() === "search" && searchQuery) return false;
    return true;
  });
  return { ...(searchQuery ? { searchQuery } : {}), calls };
}

export interface CodeModeCatalogItem {
  path: string;
  description?: string;
  signature?: string;
}

export interface CodeModeCatalog {
  items: CodeModeCatalogItem[];
  remaining?: number;
}

function catalogItem(value: unknown): CodeModeCatalogItem | null {
  const record = asRecord(value);
  const path = record?.path;
  if (typeof path !== "string" || !path.trim()) return null;
  const description = record?.description;
  const signature = record?.signature;
  return {
    path,
    ...(typeof description === "string" && description ? { description } : {}),
    ...(typeof signature === "string" && signature ? { signature } : {}),
  };
}

/**
 * Detect the `$codemode.search` catalog shape (`{ items: [{ path, ... }] }`)
 * in an `execute` output, accepting objects or JSON strings.
 */
export function parseCodeModeCatalog(output: unknown): CodeModeCatalog | undefined {
  let decoded = output;
  if (typeof output === "string" && output.length <= 1_000_000) {
    const parsed = parseJsonInput(output);
    if (parsed === undefined) return undefined;
    decoded = parsed;
  }
  const record = asRecord(decoded);
  const items = record?.items;
  if (!Array.isArray(items)) return undefined;
  const parsed = items.flatMap((entry) => {
    const item = catalogItem(entry);
    return item ? [item] : [];
  });
  if (parsed.length === 0) return undefined;
  const remaining = record?.remaining;
  return {
    items: parsed.slice(0, 50),
    ...(typeof remaining === "number" && Number.isFinite(remaining) ? { remaining } : {}),
  };
}
