import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import {
  createReasoningData,
  createToolCallData,
  REASONING_RENDERER_KIND,
  REASONING_RENDERER_VERSION,
  TOOL_CALL_RENDERER_KIND,
  TOOL_CALL_RENDERER_VERSION,
} from "../shared/timeline";

type ReasoningTransformer = PluginTimelineTransformerContribution<"reasoning">["transform"];
type ToolCallTransformer = PluginTimelineTransformerContribution<"tool_call">["transform"];

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

export const transformToolCall: ToolCallTransformer = ({ item }) => ({
  items: [
    {
      type: "plugin",
      kind: TOOL_CALL_RENDERER_KIND,
      version: TOOL_CALL_RENDERER_VERSION,
      data: createToolCallData(item),
    },
  ],
});
