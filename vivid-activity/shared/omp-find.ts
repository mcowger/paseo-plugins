export interface OmpFindResult {
  query?: string;
  keywords: string[];
  path?: string;
  hits: { path: string; score?: number; ranges: { start: number; end: number; snippet?: string }[] }[];
  listed?: number;
  judged?: number;
  filesRead?: number;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** Parse OMP find's structured result envelope; tolerate absent optional fields. */
export function parseOmpFindResult(input: unknown, output: unknown): OmpFindResult | null {
  const args = asRecord(input);
  const envelope = asRecord(output);
  const details = asRecord(envelope?.details);
  if (!args && !envelope) return null;
  const keywords = Array.isArray(args?.grep_keywords)
    ? args.grep_keywords.filter((value): value is string => typeof value === "string")
    : Array.isArray(details?.keywords)
      ? details.keywords.filter((value): value is string => typeof value === "string")
      : [];
  const hits = Array.isArray(details?.hits)
    ? details.hits.flatMap((value) => {
        const hit = asRecord(value);
        const path = hit?.rel ?? hit?.path;
        if (typeof path !== "string") return [];
        const ranges = Array.isArray(hit?.ranges)
          ? hit.ranges.flatMap((value) => {
              const range = asRecord(value);
              if (typeof range?.start !== "number" || typeof range.end !== "number") return [];
              return [{
                start: range.start,
                end: range.end,
                ...(typeof range.snippet === "string" ? { snippet: range.snippet } : {}),
              }];
            })
          : [];
        return [{
          path,
          ...(typeof hit?.contentScore === "number" ? { score: hit.contentScore } : {}),
          ranges,
        }];
      })
    : [];
  return {
    ...(typeof args?.query === "string" ? { query: args.query } : typeof details?.query === "string" ? { query: details.query } : {}),
    keywords,
    ...(typeof args?.path === "string" ? { path: args.path } : typeof details?.scopePath === "string" ? { path: details.scopePath } : {}),
    hits,
    ...(typeof details?.listed === "number" ? { listed: details.listed } : {}),
    ...(typeof details?.judged === "number" ? { judged: details.judged } : {}),
    ...(typeof details?.filesRead === "number" ? { filesRead: details.filesRead } : {}),
  };
}

export function isOmpFindTool(toolName: string): boolean {
  return /^(?:(?:functions|tools)\.)?find$/i.test(toolName.trim());
}
