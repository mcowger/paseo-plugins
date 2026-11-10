export interface OmpWaitTextModel {
  kind: "running" | "result";
  entries: Array<{
    id: string;
    agent?: string;
    status?: string;
    duration?: string;
    metadata?: string[];
    output?: string;
  }>;
  remainder?: string;
}

const RESULT_START = /<task-result\b([^>]*)>/g;
const ATTRIBUTE = /([a-zA-Z][\w-]*)="([^"<>]*)"/g;
const RUNNING_HEADER = /^## Still Running \((\d+)\)\s*$/;
const RUNNING_ROW = /^- `([^`\r\n]+)` \[([^\]\r\n]+)\] — (.+?) — ([^·\r\n]+?)(?: · (.*))?$/;

function attributes(source: string): Record<string, string> | null {
  const values: Record<string, string> = {};
  let consumed = "";
  for (const match of source.matchAll(ATTRIBUTE)) {
    const between = source.slice(consumed.length, match.index);
    if (!/^\s*$/.test(between) || values[match[1]] !== undefined) return null;
    values[match[1]] = match[2];
    consumed = source.slice(0, match.index! + match[0].length);
  }
  if (!/^\s*$/.test(source.slice(consumed.length))) return null;
  return values;
}

function parseResults(text: string): OmpWaitTextModel | null {
  const entries: OmpWaitTextModel["entries"] = [];
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  for (const match of text.matchAll(RESULT_START)) {
    const start = match.index!;
    const attrs = attributes(match[1]);
    if (!attrs || !attrs.id || !attrs.agent || !attrs.status) return null;
    const closeStart = text.indexOf("</task-result>", start + match[0].length);
    if (closeStart < 0) return null;
    const nested = text.slice(start + match[0].length, closeStart);
    if (nested.includes("<task-result") || nested.includes("</task-result>")) return null;
    const outputOpen = nested.indexOf("<output>");
    const outputClose = nested.lastIndexOf("</output>");
    if (outputOpen < 0 || outputClose < outputOpen || nested.indexOf("<output>", outputOpen + 1) >= 0) return null;
    if (nested.slice(0, outputOpen).trim() || nested.slice(outputClose + "</output>".length).trim()) return null;
    entries.push({
      id: attrs.id,
      agent: attrs.agent,
      status: attrs.status,
      ...(attrs.duration ? { duration: attrs.duration } : {}),
      metadata: Object.entries(attrs).filter(([key]) => !["id", "agent", "status", "duration"].includes(key)).map(([key, value]) => `${key}=${value}`),
      output: nested.slice(outputOpen + "<output>".length, outputClose),
    });
    spans.push([start, closeStart + "</task-result>".length]);
  }
  if (!entries.length) return null;
  let remainder = "";
  for (const [start, end] of spans) {
    remainder += text.slice(cursor, start);
    cursor = end;
  }
  remainder += text.slice(cursor);
  return { kind: "result", entries, ...(remainder.trim() ? { remainder: remainder.trim() } : {}) };
}

function parseRunning(text: string): OmpWaitTextModel | null {
  const lines = text.split(/\r?\n/);
  const headerIndexes = lines.map((line, index) => RUNNING_HEADER.test(line.trim()) ? index : -1).filter(index => index >= 0);
  if (!headerIndexes.length) return null;
  const entries: OmpWaitTextModel["entries"] = [];
  const parsedLines = new Set<number>();
  for (const headerIndex of headerIndexes) {
    const count = Number(RUNNING_HEADER.exec(lines[headerIndex].trim())?.[1]);
    let index = headerIndex + 1;
    parsedLines.add(headerIndex);
    while (index < lines.length && !lines[index].trim()) index++;
    let found = 0;
    while (index < lines.length && lines[index].startsWith("- ")) {
      const match = RUNNING_ROW.exec(lines[index]);
      if (!match) return null;
      const [, id, agent, name, duration, details] = match;
      entries.push({ id, agent, ...(name.trim() === id ? {} : { status: name.trim() }), duration: duration.trim(), ...(details ? { metadata: details.split(" · ").map(value => value.trim()) } : {}) });
      parsedLines.add(index);
      index++;
      found++;
    }
    if (found !== count || found === 0) return null;
  }
  if (!entries.length) return null;
  const remainder = lines.filter((_, index) => !parsedLines.has(index)).join("\n").trim();
  return { kind: "running", entries, ...(remainder ? { remainder } : {}) };
}

export function parseOmpWaitText(text: string): OmpWaitTextModel | null {
  if (typeof text !== "string" || !text.trim()) return null;
  if (/<task-result\b/.test(text)) return parseResults(text);
  return parseRunning(text);
}
