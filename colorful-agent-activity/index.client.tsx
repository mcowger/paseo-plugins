import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ActivitySettings } from "./client/settings";
import { ColorfulReasoning, ColorfulToolCall } from "./client/activity";
import { transformReasoning, transformToolCall } from "./client/transform";
import {
  REASONING_RENDERER_KIND,
  TOOL_CALL_RENDERER_KIND,
  REASONING_RENDERER_VERSION,
  TOOL_CALL_RENDERER_VERSION,
  reasoningItemDataSchema,
  toolCallItemDataSchema,
} from "./shared/timeline";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "display",
    title: "Colorful activity",
    icon: "Palette",
    Component: ActivitySettings,
  });
  client.addTimelineTransformer({
    id: "reasoning",
    query: { itemType: "reasoning" },
    transform: transformReasoning,
  });
  client.addTimelineTransformer({
    id: "tool-calls",
    query: { itemType: "tool_call" },
    transform: transformToolCall,
  });
  client.addTimelineRenderer({
    kind: REASONING_RENDERER_KIND,
    version: REASONING_RENDERER_VERSION,
    schema: reasoningItemDataSchema,
    Component: ColorfulReasoning,
  });
  client.addTimelineRenderer({
    kind: TOOL_CALL_RENDERER_KIND,
    version: TOOL_CALL_RENDERER_VERSION,
    schema: toolCallItemDataSchema,
    Component: ColorfulToolCall,
  });
  return () => {};
}
