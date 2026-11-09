export type OmpEvalCell = { title?: string; language?: string; code?: string; output?: string };
export type OmpEvalPresentation = {
  title?: string;
  language?: string;
  code?: string;
  result: string;
  cells: OmpEvalCell[];
  rawOutput?: string;
  status: "running" | "error" | "complete";
};

export type OmpWebSearchResult = { title?: string; url?: string; snippet?: string };
export type OmpWebSearchPresentation = {
  query?: string;
  results: OmpWebSearchResult[];
  rawOutput?: string;
  status: "running" | "error" | "complete";
};
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}

function outputText(value: unknown): string {
  const obj = record(value);
  if (obj && Array.isArray(obj.content)) {
    const texts = obj.content.flatMap((part) => {
      const item = record(part);
      return item && typeof item.text === "string" ? [item.text] : [];
    });
    if (texts.length) return texts.join("\n");
  }
  if (obj && typeof obj.text === "string") return obj.text;
  return typeof value === "string" ? value : "";
}

function isError(output: unknown): boolean {
  const obj = record(output);
  return obj?.isError === true || obj?.error !== undefined;
}

function envelopeObject(output: unknown): Record<string, unknown> | undefined {
  const obj = record(output);
  return record(obj?.details) ?? obj;
}

export function isOmpEvalTool(name: string): boolean {
  return /^(?:(?:functions|tools)\.)?eval$/i.test(name.trim());
}

export function isOmpWebSearchTool(name: string): boolean {
  return /^(?:(?:functions|tools)\.)?web_search$/i.test(name.trim());
}

export function parseOmpEval(input: unknown, output: unknown, running = false): OmpEvalPresentation {
  const args = record(input);
  const text = outputText(output);
  const error = isError(output);
  const details = envelopeObject(output);
  const cells = Array.isArray(details?.cells) ? details.cells.flatMap((value) => {
    const cell = record(value);
    if (!cell) return [];
    return [{
      title: typeof cell.title === "string" ? cell.title : undefined,
      language: typeof cell.language === "string" ? cell.language : undefined,
      code: typeof cell.code === "string" ? cell.code : undefined,
      output: typeof cell.output === "string" ? cell.output : undefined,
    }];
  }) : [];
  const parsed: OmpEvalPresentation = {
    title: typeof args?.title === "string" ? args.title : undefined,
    language: typeof args?.language === "string" ? args.language : undefined,
    code: typeof args?.code === "string" ? args.code : undefined,
    result: text,
    cells,
    status: running ? "running" : error ? "error" : "complete",
  };
  if (output !== undefined && output !== null && !text && !cells.length) parsed.rawOutput = readable(output);
  else if (error && !text) parsed.rawOutput = readable(output);
  return parsed;
}

function resultFrom(value: unknown): OmpWebSearchResult | undefined {
  const item = record(value);
  if (!item) return undefined;
  const title = [item.title, item.name].find((entry) => typeof entry === "string") as string | undefined;
  const url = [item.url, item.link].find((entry) => typeof entry === "string") as string | undefined;
  const snippet = [item.snippet, item.description, item.text, item.content].find((entry) => typeof entry === "string") as string | undefined;
  if (!title && !url && !snippet) return undefined;
  return { title, url, snippet };
}

export function parseOmpWebSearch(input: unknown, output: unknown, running = false): OmpWebSearchPresentation {
  const args = record(input);
  const envelope = envelopeObject(output);
  const response = record(envelope?.response);
  const list = [envelope?.results, envelope?.items, envelope?.sources, response?.sources].find(Array.isArray) as unknown[] | undefined;
  const results = list?.map(resultFrom).filter((value): value is OmpWebSearchResult => value !== undefined) ?? [];
  const text = outputText(output);
  const error = isError(output);
  return {
    query: typeof args?.query === "string" ? args.query : undefined,
    results,
    rawOutput: output !== undefined && output !== null ? (text || (results.length === 0 ? readable(output) : undefined)) : undefined,
    status: running ? "running" : error ? "error" : "complete",
  };
}
