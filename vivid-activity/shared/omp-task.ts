import { extractPiToolText } from "./presentation";

export interface OmpTaskItem {
  description?: string;
  status?: string;
  id?: string;
  result?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function field(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" && value[key].trim() ? value[key] : undefined;
}
export function parseOmpTaskInput(input: unknown): OmpTaskItem[] {
  let decoded = input;
  if (typeof input === "string") {
    try { decoded = JSON.parse(input) as unknown; } catch { return []; }
  }
  const args = record(decoded);
  if (!Array.isArray(args?.tasks)) return [];
  return args.tasks.flatMap((value): OmpTaskItem[] => {
    const task = record(value);
    if (!task) return [];
    const description = field(task, "task") ?? field(task, "description");
    const id = field(task, "name") ?? field(task, "id");
    return description || id ? [{ ...(description ? { description } : {}), ...(id ? { id } : {}) }] : [];
  });
}
export function parseOmpTaskOutput(output: unknown): { text: string; tasks: OmpTaskItem[] } | undefined {
  const envelope = extractPiToolText(output);
  if (!envelope) return undefined;
  const details = envelope.details;
  const rawTasks = Array.isArray(details?.progress) ? details.progress : Array.isArray(details?.results) ? details.results : [];
  const tasks = rawTasks.flatMap((value): OmpTaskItem[] => {
    const task = record(value);
    if (!task) return [];
    const description = field(task, "assignment") ?? field(task, "task") ?? field(task, "description");
    const status = field(task, "status");
    const id = field(task, "id") ?? field(task, "name");
    const result = field(task, "output");
    if (!description && !status && !id && !result) return [];
    return [{ ...(description ? { description } : {}), ...(status ? { status } : {}), ...(id ? { id } : {}), ...(result ? { result } : {}) }];
  });
  return { text: envelope.text, tasks };
}
