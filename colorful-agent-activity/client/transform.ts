import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import {
  createReasoningData,
  createToolCallData,
  REASONING_RENDERER_KIND,
  REASONING_RENDERER_VERSION,
  TOOL_CALL_RENDERER_KIND,
  TOOL_CALL_RENDERER_VERSION,
} from "../shared/timeline";
import { extractApplyPatchEdits, isApplyPatchTool } from "../shared/presentation";

type ReasoningTransformer = PluginTimelineTransformerContribution<"reasoning">["transform"];
type ToolCallTransformer = PluginTimelineTransformerContribution<"tool_call">["transform"];
type ToolCallTimelineItem = Parameters<ToolCallTransformer>[0]["item"];

export const transformReasoning: ReasoningTransformer = ({ item, phase }) => ({
  items: [
    {
      type: "plugin",
      kind: REASONING_RENDERER_KIND,
      version: REASONING_RENDERER_VERSION,
      data: createReasoningData(item, phase),
    },
  ],
});

function transformApplyPatch(item: ToolCallTimelineItem) {
  const edits = extractApplyPatchEdits(item.detail, item.detail.type === "unknown" ? item.detail.output : undefined);
  if (edits.length === 0) return undefined;

  return {
    items: edits.map((edit, index) => {
      const data = createToolCallData({
        ...item,
        name: "apply_patch",
        detail: {
          type: "edit",
          filePath: edit.filePath,
          unifiedDiff: edit.unifiedDiff,
        },
      });
      const label = edit.operation === "add" ? "Add File" : edit.operation === "delete" ? "Delete File" : "Edit File";
      return {
        type: "plugin" as const,
        id: `${item.callId}:apply-patch:${index}`,
        kind: TOOL_CALL_RENDERER_KIND,
        version: TOOL_CALL_RENDERER_VERSION,
        data: {
          ...data,
          presentation: { ...data.presentation, label },
        },
      };
    }),
  };
}

export const transformToolCall: ToolCallTransformer = ({ item }) => {
  if (isApplyPatchTool(item.name)) {
    const transformed = transformApplyPatch(item);
    if (transformed) return transformed;
  }
  // Paseo renders this exact shape as a SpeakMessage, not an ordinary tool card.
  if (
    item.name === "speak" &&
    item.detail?.type === "unknown" &&
    typeof item.detail.input === "string" &&
    item.detail.input.trim()
  ) {
    return undefined;
  }
  return {
    items: [
      {
        type: "plugin",
        kind: TOOL_CALL_RENDERER_KIND,
        version: TOOL_CALL_RENDERER_VERSION,
        data: createToolCallData(item),
      },
    ],
  };
};
