/**
 * Reading a tool result, which every provider wraps differently.
 *
 * The host's own MCP path sends `{ content: [{ type: "text", text }], structuredContent }`.
 * A plugin provider cannot: Pi's `ToolResultMessage` has no `structuredContent` field, so the
 * payload comes back as `{ content: string, details: { server, tool } }` — the text of the
 * result and Pi's own bookkeeping. Some servers then hand their JSON back as that string.
 *
 * Rows that read a result therefore walk the envelope instead of assuming one shape. Guessing
 * wrong is silent: the row simply renders nothing, which reads like an empty response.
 */

type JsonRecord = Record<string, unknown>;

/** How deep an envelope may nest before we stop looking; real results nest once or twice. */
const MAX_DEPTH = 4;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** The text a result carries, envelope or not. */
export function toolOutputText(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof value === "string") return value.trim() ? value : undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  const content = record.content;
  if (typeof content === "string") {
    return content.trim() ? content : undefined;
  }
  if (Array.isArray(content)) {
    const texts = content.flatMap((part) => {
      if (typeof part === "string") return part.trim() ? [part] : [];
      const text = asRecord(part)?.text;
      return typeof text === "string" && text.trim() ? [text] : [];
    });
    if (texts.length > 0) return texts.join("\n");
  }
  if (typeof record.text === "string") {
    return record.text.trim() ? record.text : undefined;
  }
  if (record.structuredContent !== undefined) {
    return toolOutputText(record.structuredContent, depth + 1);
  }
  return undefined;
}

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // Servers prefix their payload with a line or two of plain text often enough that
    // hunting for the first object is worth it.
    for (const match of value.matchAll(/\{|\[/g)) {
      const offset = match.index;
      if (offset === undefined) continue;
      try {
        return JSON.parse(value.slice(offset)) as unknown;
      } catch {}
    }
    return undefined;
  }
}

/**
 * The payload behind a result: parsed JSON when the text holds any, the text when it does not.
 *
 * Returns `undefined` when there is nothing to unwrap, so a caller can keep whatever it was
 * handed rather than blanking the row.
 */
export function toolOutputPayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  const record = asRecord(value);
  if (record?.structuredContent !== undefined) {
    const inner = toolOutputPayload(record.structuredContent, depth + 1);
    return inner === undefined ? record.structuredContent : inner;
  }
  const text = toolOutputText(value);
  if (!text) return undefined;
  const parsed = parseJsonText(text);
  if (parsed === undefined) return text;
  // A payload that parses to another envelope is still an envelope.
  const inner = toolOutputPayload(parsed, depth + 1);
  return inner === undefined ? parsed : inner;
}
