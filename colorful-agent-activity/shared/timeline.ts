import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import {
  formatError,
  formatReasoningText,
  resolveToolCallPresentation,
  toJsonValue,
} from "./presentation";

export const REASONING_RENDERER_KIND = "colorful-reasoning";
export const TOOL_CALL_RENDERER_KIND = "colorful-tool-call";
export const REASONING_RENDERER_VERSION = 1;
export const TOOL_CALL_RENDERER_VERSION = 1;

export const reasoningItemDataSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
});

export const diffStatsSchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const toolCallPresentationSchema = z.object({
  category: z.enum([
    "shell",
    "file",
    "search",
    "agent",
    "plan",
    "communication",
    "unknown",
  ]),
  icon: z.string(),
  label: z.string(),
  summary: z.string().optional(),
  filePath: z.string().optional(),
  fileIcon: z.string().optional(),
  language: z.string().optional(),
  diffStats: diffStatsSchema.optional(),
});

export const toolCallItemDataSchema = z.object({
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  detail: z.json(),
  errorText: z.string().optional(),
  presentation: toolCallPresentationSchema,
});

export type ReasoningItemData = z.output<typeof reasoningItemDataSchema>;
export type ToolCallItemData = z.output<typeof toolCallItemDataSchema>;

export function getActivityExpansionState(
  isStreaming: boolean,
  isLatest: boolean,
  userExpanded: boolean | null,
): boolean {
  return isStreaming || (userExpanded !== null ? userExpanded : isLatest);
}

export function getReasoningExpansionState(
  isStreaming: boolean,
  isLatest: boolean,
  userExpanded: boolean | null,
): boolean {
  return getActivityExpansionState(isStreaming, isLatest, userExpanded);
}

export function createReasoningData(
  item: Extract<AgentTimelineItem, { type: "reasoning" }>,
  phase: ReasoningItemData["phase"],
): ReasoningItemData {
  return { text: formatReasoningText(item.text), phase };
}

export function createToolCallData(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
): ToolCallItemData {
  const presentation = resolveToolCallPresentation(item);
  const errorText = formatError(item.error);
  return {
    name: item.name,
    status: item.status,
    detail: toJsonValue(item.detail),
    ...(errorText ? { errorText } : {}),
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
