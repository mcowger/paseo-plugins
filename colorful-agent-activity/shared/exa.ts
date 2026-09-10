export type ExaToolKind =
  | "search"
  | "fetch"
  | "agent"
  | "research-guide"
  | "schema-templates";

export interface ExaSearchResult {
  title: string;
  url?: string;
  published?: string;
  author?: string;
  highlights?: string;
}

type JsonRecord = Record<string, unknown>;

const EXA_TOOL_LABELS: Readonly<Record<ExaToolKind, string>> = {
  search: "Exa Web Search",
  fetch: "Exa Web Fetch",
  agent: "Exa Agent",
  "research-guide": "Exa Research Guide",
  "schema-templates": "Exa Schema Templates",
};

const EXA_TOOL_ICONS: Readonly<Record<ExaToolKind, string>> = {
  search: "Search",
  fetch: "Globe",
  agent: "Bot",
  "research-guide": "BookOpen",
  "schema-templates": "Braces",
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function fieldString(record: JsonRecord | null, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(record?.[key]);
    if (value) return value;
  }
  return undefined;
}

function toolLeaf(name: string): string {
  return name.trim().toLowerCase().split(/__|[.:/]/).at(-1) ?? "";
}

export function exaToolKind(name: string): ExaToolKind | null {
  const normalized = name.trim().toLowerCase();
  const leaf = toolLeaf(normalized);
  if (normalized.endsWith("web_search_exa") || leaf === "web_search_exa") return "search";
  if (normalized.endsWith("web_fetch_exa") || leaf === "web_fetch_exa") return "fetch";
  if (normalized.endsWith("exa_agent_run") || (normalized.includes("exa") && leaf === "agent_run")) {
    return "agent";
  }
  if (
    normalized.endsWith("exa_read_agent_research_guide") ||
    (normalized.includes("exa") && leaf === "read_agent_research_guide")
  ) {
    return "research-guide";
  }
  if (
    normalized.endsWith("exa_read_agent_schema_templates") ||
    (normalized.includes("exa") && leaf === "read_agent_schema_templates")
  ) {
    return "schema-templates";
  }
  return null;
}

export function exaToolLabel(kind: ExaToolKind): string {
  return EXA_TOOL_LABELS[kind];
}

export function exaToolIcon(kind: ExaToolKind): string {
  return EXA_TOOL_ICONS[kind];
}

export function exaToolSummary(kind: ExaToolKind, input: unknown): string | undefined {
  const record = asRecord(input);
  const value =
    kind === "search"
      ? fieldString(record, "query")
      : kind === "fetch"
        ? fieldString(record, "url")
        : fieldString(record, "prompt") ?? fieldString(record, "query");
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

function textParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  const record = asRecord(value);
  if (!record) return [];
  if (record.structuredContent !== undefined) {
    const structuredText = textParts(record.structuredContent);
    if (structuredText.length > 0) return structuredText;
  }
  if (typeof record.text === "string") return [record.text];
  if (Array.isArray(record.content)) {
    return record.content.flatMap((part) => textParts(part));
  }
  return [];
}

export function exaOutputText(value: unknown): string | undefined {
  const text = textParts(value).filter(Boolean).join("\n\n").trim();
  return text || undefined;
}

function resultFromRecord(record: JsonRecord): ExaSearchResult | null {
  const title = fieldString(record, "title", "name");
  if (!title) return null;
  return {
    title,
    ...(fieldString(record, "url", "link") ? { url: fieldString(record, "url", "link") } : {}),
    ...(fieldString(record, "published", "publishedDate", "publishedAt")
      ? { published: fieldString(record, "published", "publishedDate", "publishedAt") }
      : {}),
    ...(fieldString(record, "author", "authorName")
      ? { author: fieldString(record, "author", "authorName") }
      : {}),
    ...(fieldString(record, "highlights", "highlight", "text")
      ? { highlights: fieldString(record, "highlights", "highlight", "text") }
      : {}),
  };
}

function structuredResults(value: unknown): ExaSearchResult[] {
  const record = asRecord(value);
  if (!record) return [];
  if (record.structuredContent !== undefined) return structuredResults(record.structuredContent);
  if (Array.isArray(record.results)) {
    return record.results.flatMap((result) => {
      const resultRecord = asRecord(result);
      const parsed = resultRecord ? resultFromRecord(resultRecord) : null;
      return parsed ? [parsed] : [];
    });
  }
  return [];
}

function parseTextResults(text: string): ExaSearchResult[] {
  return text
    .split(/\n\s*---\s*\n(?=Title:\s)/)
    .map((block) => {
      const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
      if (!title) return null;
      const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim();
      const published = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim();
      const author = block.match(/^Author:\s*(.+)$/m)?.[1]?.trim();
      const highlightsMatch = block.match(/^Highlights:\s*\n([\s\S]*)$/m);
      const highlights = highlightsMatch?.[1]?.trim();
      return {
        title,
        ...(url ? { url } : {}),
        ...(published ? { published } : {}),
        ...(author ? { author } : {}),
        ...(highlights ? { highlights } : {}),
      } satisfies ExaSearchResult;
    })
    .filter((result): result is ExaSearchResult => result !== null);
}

export function parseExaSearchResults(value: unknown): ExaSearchResult[] {
  const structured = structuredResults(value);
  if (structured.length > 0) return structured;
  const text = exaOutputText(value);
  return text ? parseTextResults(text) : [];
}
