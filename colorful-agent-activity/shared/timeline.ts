import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import {
  formatError,
  formatReasoningText,
  normalizeToolCallDetail,
  resolveToolCallPresentation,
  toJsonValue,
  withMetadataEditDiff,
} from "./presentation";
import type { ExpansionMode } from "./settings";

export const REASONING_RENDERER_KIND = "colorful-reasoning";
export const TOOL_CALL_RENDERER_KIND = "colorful-tool-call";
export const TODO_RENDERER_KIND = "colorful-todo";
export const REASONING_RENDERER_VERSION = 1;
export const TOOL_CALL_RENDERER_VERSION = 2;
export const TODO_RENDERER_VERSION = 1;

export const reasoningItemDataSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
});

export const diffStatsSchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const toolCallPresentationSchema = z.object({
  category: z.enum(["shell", "file", "search", "agent", "plan", "communication", "unknown"]),
  icon: z.string(),
  label: z.string(),
  summary: z.string().optional(),
  filePath: z.string().optional(),
  fileIcon: z.string().optional(),
  language: z.string().optional(),
  diffStats: diffStatsSchema.optional(),
});

/** A bounded scalar fact a provider reports outside the typed detail. */
export const toolCallFactsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

export const toolCallItemDataSchema = z.object({
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  detail: z.json(),
  errorText: z.string().optional(),
  presentation: toolCallPresentationSchema,
  /** Facts the typed detail has no field for, such as a sub-agent's token count. */
  facts: toolCallFactsSchema.optional(),
});

export const todoItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});

export const todoItemDataSchema = z.object({
  items: z.array(todoItemSchema),
});

export type ReasoningItemData = z.output<typeof reasoningItemDataSchema>;
export type ToolCallItemData = z.output<typeof toolCallItemDataSchema>;
export type TodoItemData = z.output<typeof todoItemDataSchema>;

export function resolveExpansion(
  mode: ExpansionMode,
  isLatest: boolean,
  userExpanded: boolean | null,
): boolean {
  if (userExpanded !== null) return userExpanded;
  if (mode === "always") return true;
  if (mode === "never") return false;
  return isLatest;
}

export function isLatestTaskUpdate(timestamp: number, latestTimestamp: number): boolean {
  return latestTimestamp > 0 && timestamp >= latestTimestamp;
}

export interface TaskUpdateExpansionOverride {
  expanded: boolean;
  latestTimestamp: number;
}

export function resolveTaskUpdateExpansion(
  mode: ExpansionMode,
  isLatest: boolean,
  latestTimestamp: number,
  userOverride: TaskUpdateExpansionOverride | null,
): boolean {
  const userExpanded =
    mode !== "latest" || userOverride?.latestTimestamp === latestTimestamp
      ? (userOverride?.expanded ?? null)
      : null;
  return resolveExpansion(mode, isLatest, userExpanded);
}

export function createReasoningData(
  item: Extract<AgentTimelineItem, { type: "reasoning" }>,
  phase: ReasoningItemData["phase"],
): ReasoningItemData {
  return { text: formatReasoningText(item.text), phase };
}

export function createTodoData(
  item: Extract<AgentTimelineItem, { type: "todo" }>,
): TodoItemData | null {
  if (item.items.length === 0) return null;
  return {
    items: item.items.map((entry, index) => ({
      id: entry.id ?? `todo-${index}`,
      title: entry.text,
      status: entry.status ?? (entry.completed ? "completed" : "pending"),
    })),
  };
}

/**
 * Facts a provider attaches under `metadata.plexuspiFacts`, because a typed
 * detail has no field for them. Same convention as opencode's `metadata.filediff`:
 * the provider namespaces what it adds.
 */
export function toolCallFacts(
  metadata: unknown,
): Record<string, string | number | boolean> | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }
  const parsed = toolCallFactsSchema.safeParse(Reflect.get(metadata, "plexuspiFacts"));
  if (!parsed.success) return undefined;
  return Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
}

export function createToolCallData(
  source: Extract<AgentTimelineItem, { type: "tool_call" }>,
): ToolCallItemData {
  const item = withMetadataEditDiff(source);
  const detail = normalizeToolCallDetail(item.detail, item.name);
  const presentation = resolveToolCallPresentation({ name: item.name, detail });
  const errorText = formatError(item.error);
  const facts = toolCallFacts(item.metadata);
  return {
    name: item.name,
    status: item.status,
    detail: toJsonValue(detail),
    ...(errorText ? { errorText } : {}),
    ...(facts ? { facts } : {}),
    presentation: {
      category: presentation.category,
      icon: presentation.icon,
      label: presentation.label,
      ...(presentation.summary ? { summary: presentation.summary } : {}),
      ...(presentation.filePath ? { filePath: presentation.filePath } : {}),
      ...(presentation.fileIcon ? { fileIcon: presentation.fileIcon } : {}),
      ...(presentation.language ? { language: presentation.language } : {}),
      ...(presentation.diffStats ? { diffStats: presentation.diffStats } : {}),
    },
  };
}
