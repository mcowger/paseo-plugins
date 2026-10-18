import { toolOutputPayload, toolOutputText } from "./tool-output";

export type ExaToolKind = "search" | "fetch" | "agent" | "research-guide" | "schema-templates";

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
  return (
    name
      .trim()
      .toLowerCase()
      .split(/__|[.:/]/)
      .at(-1) ?? ""
  );
}

export function exaToolKind(name: string): ExaToolKind | null {
  const normalized = name.trim().toLowerCase();
  const leaf = toolLeaf(normalized);
  if (normalized.endsWith("web_search_exa") || leaf === "web_search_exa") return "search";
  if (normalized.endsWith("web_fetch_exa") || leaf === "web_fetch_exa") return "fetch";
  if (
    normalized.endsWith("exa_agent_run") ||
    (normalized.includes("exa") && leaf === "agent_run")
  ) {
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
        ? (fieldString(record, "url") ?? firstUrl(record))
        : (fieldString(record, "prompt") ?? fieldString(record, "query"));
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

/**
 * The result text, envelope or not.
 *
 * Exa answers a search with formatted text — `Title:` / `URL:` / `Highlights:` blocks — not
 * with JSON, so this is the payload. Pi wraps it as `{ content: string, details }`; the host's
 * own path wraps it as content blocks.
 */
export function exaOutputText(value: unknown): string | undefined {
  return toolOutputText(value)?.trim() || undefined;
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
    ...(exaHighlightPreview(fieldString(record, "highlights", "highlight", "text")) !== undefined
      ? { highlights: exaHighlightPreview(fieldString(record, "highlights", "highlight", "text")) }
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
      const highlights = exaHighlightPreview(highlightsMatch?.[1]?.trim());
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

/** Markdown chrome Exa's highlights carry, none of which belongs in a one-line preview. */
function flattenHighlightLine(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/^\s{0,3}>\s?/, "")
    .replace(/^\s{0,3}```.*$/, "")
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A highlight as one short line, because a row is a pointer to the page, not the page.
 *
 * Exa returns page highlights as scraped markdown: headings, emphasis, code fences, image
 * references, and the `...` separators its scraper leaves between quoted comment blocks.
 * Rendered whole, two results fill a screen with someone else's prose. The reader who wants
 * that prose has the URL.
 */
export function exaHighlightPreview(
  text: string | undefined,
  maxChars = 200,
): string | undefined {
  if (!text) return undefined;
  const lines = text
    .split("\n")
    .filter((line) => !/^\s*\[?image:/i.test(line))
    .filter((line) => !/^\s*(\.\.\.|…)\s*$/.test(line))
    .map(flattenHighlightLine)
    .filter((line) => line && !/^(\.\.\.|…)$/.test(line));
  const joined = lines.join(" ").trim();
  if (!joined) return undefined;
  if (joined.length <= maxChars) return joined;
  const cut = joined.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function parseExaSearchResults(value: unknown): ExaSearchResult[] {
  const structured = structuredResults(value);
  if (structured.length > 0) return structured;
  // Some deployments answer with a JSON `results` array instead of formatted text.
  const payload = toolOutputPayload(value);
  if (payload !== undefined && typeof payload !== "string") {
    const fromJson = structuredResults(payload);
    if (fromJson.length > 0) return fromJson;
  }
  const text = exaOutputText(value);
  return text ? parseTextResults(text) : [];
}

function firstUrl(record: JsonRecord | null): string | undefined {
  const urls = record?.urls;
  if (Array.isArray(urls)) {
    const first = urls.find((entry) => typeof entry === "string" && entry.trim());
    if (typeof first === "string") return first;
  }
  return undefined;
}

// ─── fetch ──────────────────────────────────────────────────────────────────────

export interface ExaFetchedPage {
  title?: string;
  url?: string;
  /** The page as text, still markdown: the reader renders it, the row does not. */
  text: string;
}

const URL_LINE = /^\s*URL:\s*(\S+)\s*$/;
const TITLE_LINE = /^\s*(?:#{1,6}\s+|Title:\s*)(.+?)\s*$/;

/**
 * A fetched page, split into its reference and its body.
 *
 * Exa answers with `Title` / `URL` header lines followed by the page's own text — which
 * opens with that same heading again. Rendering the whole thing as one code block showed
 * the header as the first line of the page, and left the markdown unread.
 */
export function parseExaFetchOutput(value: unknown): ExaFetchedPage[] {
  const text = exaOutputText(value);
  if (!text) return [];
  const lines = text.split("\n");
  const anchors: Array<{ index: number; url: string }> = [];
  lines.forEach((line, index) => {
    const url = line.match(URL_LINE)?.[1];
    if (url) anchors.push({ index, url });
  });
  if (anchors.length === 0) {
    return [{ text: text.trim() }];
  }
  return anchors.map((anchor, position) => {
    let title: string | undefined;
    for (let index = anchor.index - 1; index >= 0; index -= 1) {
      const line = lines[index] ?? "";
      if (!line.trim()) continue;
      title = line.match(TITLE_LINE)?.[1]?.trim();
      break;
    }
    const next = anchors[position + 1];
    const bodyStart = anchor.index + 1;
    const bodyEnd = next
      ? // Step back over the next block's title line and any separator above it.
        Math.max(bodyStart, next.index - 2)
      : lines.length;
    const body = lines
      .slice(bodyStart, bodyEnd)
      .join("\n")
      .replace(/^\s*---\s*$/gm, "")
      .trim();
    return {
      ...(title ? { title } : {}),
      url: anchor.url,
      text: body,
    } satisfies ExaFetchedPage;
  });
}

// ─── agent runs ─────────────────────────────────────────────────────────────────

export interface ExaAgentCitation {
  field?: string;
  confidence?: string;
  sources: string[];
}

export interface ExaAgentRunView {
  status?: string;
  stopReason?: string;
  runId?: string;
  /** The answer as prose, rendered rather than dumped. */
  text?: string;
  structured?: unknown;
  citations: ExaAgentCitation[];
}

function citationSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((citation) => {
    const record = asRecord(citation);
    const source = fieldString(record, "url", "title");
    return source ? [source] : [];
  });
}

export function parseExaAgentRun(value: unknown): ExaAgentRunView | undefined {
  const record = asRecord(toolOutputPayload(value));
  if (!record) return undefined;
  const output = asRecord(record.output);
  const grounding = Array.isArray(output?.grounding) ? output.grounding : [];
  const citations = grounding.flatMap((entry) => {
    const citation = asRecord(entry);
    const sources = citationSources(citation?.citations);
    if (sources.length === 0) return [];
    return [
      {
        ...(fieldString(citation, "field") ? { field: fieldString(citation, "field") } : {}),
        ...(fieldString(citation, "confidence")
          ? { confidence: fieldString(citation, "confidence") }
          : {}),
        sources,
      } satisfies ExaAgentCitation,
    ];
  });
  const text = fieldString(output, "text") ?? fieldString(record, "text");
  return {
    status: fieldString(record, "status"),
    stopReason: fieldString(record, "stopReason", "stop_reason"),
    runId: fieldString(record, "id", "runId", "run_id"),
    ...(text ? { text } : {}),
    ...(output?.structured !== undefined ? { structured: output.structured } : {}),
    citations,
  };
}

/** What an agent run cost and how hard it worked, said as facts. */
export function exaAgentFacts(value: unknown): Array<[string, string]> {
  const record = asRecord(toolOutputPayload(value));
  if (!record) return [];
  const usage = asRecord(record.usage);
  const cost = asRecord(record.costDollars) ?? asRecord(record.cost_dollars);
  const rows: Array<[string, string]> = [];
  const searches = usage?.searches;
  if (typeof searches === "number" && searches > 0) rows.push(["Searches", String(searches)]);
  const total = cost?.total;
  if (typeof total === "number") rows.push(["Cost", `$${total.toFixed(3)}`]);
  const stop = fieldString(record, "stopReason", "stop_reason");
  if (stop) rows.push(["Stopped", stop.replace(/_/g, " ")]);
  return rows;
}
