export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdvisorNote {
  severity: AdvisorSeverity;
  advisor?: string;
  text: string;
}

/** Paseo joins notes with blank lines. Only severity markers give an unambiguous
 * boundary; unmarked paragraphs stay together so markdown is not fragmented. */
export function parseAdvisorNotes(text: string): AdvisorNote[] {
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/);
  const chunks: string[][] = [[]];
  let fence: { char: string; length: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startsNote = !fence && (i === 0 || !lines[i - 1].trim()) && /^\[(?:nit|concern|blocker)\](?:\s|$)/i.test(line);
    if (startsNote && i > 0) chunks.push([]);
    const fenceLine = chunks[chunks.length - 1].length === 0
      ? line.replace(/^(?:\[(?:nit|concern|blocker)\][ \t]+)?(?:\[[^\]\r\n]+\][ \t]+)?/i, "")
      : line;
    const marker = fenceLine.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      const run = marker[1];
      if (!fence) fence = { char: run[0], length: run.length };
      else if (run[0] === fence.char && run.length >= fence.length && /^\s*$/.test(fenceLine.slice(marker[0].length))) fence = undefined;
    }
    chunks[chunks.length - 1].push(line);
  }
  return chunks.map((chunk) => {
    const raw = chunk.join("\n").trim();
    const prefix = raw.match(/^\[(nit|concern|blocker)\](?:[ \t]+|$)/i);
    let body = prefix ? raw.slice(prefix[0].length) : raw;
    const advisor = body.match(/^\[([^\]\r\n]+)\][ \t]+/);
    if (advisor) body = body.slice(advisor[0].length);
    return {
      severity: (prefix?.[1].toLowerCase() ?? "nit") as AdvisorSeverity,
      ...(advisor ? { advisor: advisor[1] } : {}),
      text: body.trim() ? body : raw,
    };
  });
}

export function isAdvisorTool(name: string): boolean {
  return name.trim().toLowerCase() === "advisor";
}
