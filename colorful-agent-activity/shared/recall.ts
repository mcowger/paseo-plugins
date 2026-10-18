/**
 * The session-recall tool's result.
 *
 * Its output is a list wearing a text block's clothes: a page header, one hit per
 * `#N [kind]` entry, and hint lines at the end. Rendering it as text throws away
 * exactly the structure that makes it scannable.
 */
export interface RecallEntry {
  index: number;
  kind: string;
  /** ISO timestamp when the entry carries one. */
  time?: string;
  preview: string;
  /** `...(4 lines below)` and similar elisions the tool printed. */
  note?: string;
}

export interface RecallResult {
  page?: number;
  pages?: number;
  /** Matches shown on this page, out of the total when both are stated. */
  shown?: number;
  total?: number;
  query?: string;
  entries: RecallEntry[];
  /** Trailing `--- … ---` hint lines. */
  hints: string[];
}

export function isRecallTool(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "vcc_recall" || normalized.endsWith("__recall");
}

const ENTRY = /^#(\d+)\s+\[([^\]]+)\]\s*(.*)$/;
const MAX_PREVIEW_LINES = 3;
const MAX_PREVIEW_CHARS = 240;

/** Previews are prose, not code: runs of spaces are log padding, not alignment. */
function squeeze(text: string): string {
  return text.trim().replace(/[ \t]+/g, " ");
}
const ISO_TIME = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+([\s\S]*)$/;
const ELISION = /^\.\.\.\(\d+ lines? below\)$/;

export function parseRecallOutput(output: string | undefined | null): RecallResult | undefined {
  if (typeof output !== "string" || !output.trim()) return undefined;
  const lines = output.replace(/\r\n?/g, "\n").split("\n");

  const result: RecallResult = { entries: [], hints: [] };
  let current: RecallEntry | undefined;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    if (result.page === undefined) {
      const header = line.match(/^Page\s+(\d+)\/(\d+)\s*\(([^)]*)\)/i);
      if (header) {
        result.page = Number.parseInt(header[1] ?? "", 10);
        result.pages = Number.parseInt(header[2] ?? "", 10);
        const detail = header[3] ?? "";
        const showing = detail.match(/showing\s+(\d+)\s+of\s+(\d+)/i);
        const total = detail.match(/(\d+)\s+total\s+matches?/i);
        if (showing) {
          result.shown = Number.parseInt(showing[1] ?? "", 10);
          result.total = Number.parseInt(showing[2] ?? "", 10);
        } else if (total) {
          result.total = Number.parseInt(total[1] ?? "", 10);
        }
        const query = line.match(/for\s+"([^"]*)"/);
        if (query?.[1]) result.query = query[1];
        continue;
      }
    }

    const entry = line.match(ENTRY);
    if (entry) {
      const rest = entry[3] ?? "";
      const time = rest.match(ISO_TIME);
      current = {
        index: Number.parseInt(entry[1] ?? "", 10),
        kind: entry[2] ?? "",
        ...(time?.[1] ? { time: time[1] } : {}),
        preview: squeeze((time?.[2] ?? rest)).slice(0, MAX_PREVIEW_CHARS),
      };
      result.entries.push(current);
      continue;
    }

    if (line.startsWith("---")) {
      const hint = line.replace(/^-+\s*|\s*-+$/g, "").trim();
      if (hint) result.hints.push(hint);
      continue;
    }

    if (ELISION.test(line.trim()) && current) {
      current.note = line.trim();
      continue;
    }

    // A hit's own following lines are its content: a tool result's interesting
    // line is rarely its first. Keep up to three, which is what the row shows.
    if (current) {
      const lines = current.preview ? current.preview.split("\n") : [];
      if (lines.length < MAX_PREVIEW_LINES) {
        const joined = [...lines, squeeze(line)].join("\n");
        current.preview =
          joined.length > MAX_PREVIEW_CHARS
            ? `${joined.slice(0, MAX_PREVIEW_CHARS - 1)}…`
            : joined;
      }
    }
  }

  return result.entries.length > 0 ? result : undefined;
}

/** `page 1/10 · 50 of 129 · "query"` */
export function recallSummary(result: RecallResult): string | undefined {
  const count =
    result.shown !== undefined && result.total !== undefined
      ? `${result.shown} of ${result.total}`
      : result.total !== undefined
        ? `${result.total} total`
        : undefined;
  const page =
    result.page !== undefined
      ? result.pages !== undefined
        ? `page ${result.page}/${result.pages}`
        : `page ${result.page}`
      : undefined;
  const query = result.query ? `"${result.query}"` : undefined;
  return [count, page, query].filter(Boolean).join(" · ") || undefined;
}
