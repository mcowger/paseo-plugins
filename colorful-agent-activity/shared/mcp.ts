import { compactText } from "./presentation";

/**
 * A tool from an MCP server: `mcp__<server>__<tool>`.
 *
 * A plugin provider has no schema for a given server's tools, so a row gets the
 * parts it can know for certain — which server, which tool, and the arguments that
 * identify the call — and leaves the rest to the generic body. Servers that do
 * deserve a bespoke row (exa, github) are matched before this by name.
 */
export interface McpToolName {
  server: string;
  tool: string;
}

export function parseMcpToolName(name: string): McpToolName | undefined {
  const trimmed = name.trim();
  if (!trimmed.toLowerCase().startsWith("mcp__")) return undefined;
  const parts = trimmed.split("__");
  const server = parts[1]?.trim();
  const tool = parts.slice(2).join("__").trim();
  return server && tool ? { server, tool } : undefined;
}

/** Server names that read wrong when title-cased mechanically. */
const SERVER_LABELS: Readonly<Record<string, string>> = {
  github: "GitHub",
  exa: "Exa",
  unraid: "Unraid",
  nginx_proxy_manager: "Nginx Proxy Manager",
};

const ACRONYMS = new Set(["api", "dns", "hp", "ip", "job", "llm", "mcp", "pr", "ssh", "url", "vm"]);

function humanize(value: string): string {
  return value
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

export function mcpServerLabel(server: string): string {
  return SERVER_LABELS[server.toLowerCase()] ?? humanize(server);
}

export function mcpToolLabel(tool: string): string {
  return humanize(tool);
}

/** Argument keys worth putting in a row's summary, most identifying first. */
const SUMMARY_KEYS = [
  "path",
  "query",
  "container",
  "name",
  "id",
  "url",
  "owner",
  "repo",
  "workflow",
  "job",
  "pullNumber",
  "key",
  "action",
  // Servers that expose one tool with an action/subaction pair (unraid, plexus)
  // say what they did in the second half, so both belong in the summary.
  "subaction",
  "server",
];

function scalarSummaryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? compactText(value.trim(), 60) : undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length > 0 ? `${value.length} items` : undefined;
  return undefined;
}

/**
 * The tool plus the arguments that identify the call: `Docker List · plex`.
 *
 * Only scalars are considered — a nested object summarizes to nothing useful in a
 * one-line header, and the body shows the full call anyway.
 */
export function mcpToolSummary(mcp: McpToolName, input: unknown): string | undefined {
  const record =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const values: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const value = scalarSummaryValue(record[key]);
    if (value) values.push(value);
    if (values.length === 3) break;
  }
  if (values.length === 0) {
    // Fall back to the first scalar the call happens to carry.
    for (const value of Object.values(record)) {
      const scalar = scalarSummaryValue(value);
      if (scalar) {
        values.push(scalar);
        break;
      }
    }
  }
  // A single-tool server (unraid) names its tool after itself; the row's label
  // already says it, so the summary starts with the arguments.
  const toolLabel = mcpToolLabel(mcp.tool);
  const name =
    toolLabel.toLowerCase() === mcpServerLabel(mcp.server).toLowerCase() ? undefined : toolLabel;
  return [name, ...values].filter(Boolean).join(" · ");
}

export interface McpResultView {
  fields: Array<[string, unknown]>;
  /** Top-level keys beyond the cap, which the row leaves out. */
  omitted: number;
}

const MAX_RESULT_FIELDS = 20;

/**
 * A JSON result as field rows, so a response reads like a response.
 *
 * The call's arguments already render as fields; a payload that is JSON deserves
 * the same treatment rather than a horizontally scrolling line. Anything that is
 * not JSON — logs, prose, a partial body — keeps the code block.
 */
export function mcpResultFields(output: string | undefined | null): McpResultView | undefined {
  const text = typeof output === "string" ? output.trim() : "";
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) {
    return { fields: [["Items", parsed]], omitted: 0 };
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const entries = Object.entries(parsed as Record<string, unknown>).filter(([, value]) => {
    return value !== undefined && value !== null;
  });
  if (entries.length === 0) return undefined;
  const fields = entries
    .slice(0, MAX_RESULT_FIELDS)
    .map(([key, value]) => [humanize(key), value] as [string, unknown]);
  return { fields, omitted: Math.max(0, entries.length - MAX_RESULT_FIELDS) };
}

/** Arguments as field rows, with the long ones dropped: they belong in the body. */
export function mcpCallFields(input: unknown): Array<[string, unknown]> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return [];
  return Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [humanize(key), value] as [string, unknown]);
}
