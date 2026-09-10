import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import {
  REASONING_RENDERER_KIND,
  REASONING_RENDERER_VERSION,
  formatThinkingText,
} from "../shared/reasoning";

type ReasoningTransformer = PluginTimelineTransformerContribution<"reasoning">["transform"];

export const transformReasoning: ReasoningTransformer = ({ item, phase }) => ({
  items: [
    {
      type: "plugin",
      kind: REASONING_RENDERER_KIND,
      version: REASONING_RENDERER_VERSION,
      data: { text: formatThinkingText(item.text), phase },
    },
  ],
});
