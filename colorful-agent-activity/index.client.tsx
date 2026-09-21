import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ActivitySettings } from "./client/settings";
import { ColorfulReasoning, ColorfulTodo, ColorfulToolCall } from "./client/activity";
import { transformReasoning, transformTodo, transformToolCall } from "./client/transform";
import { installColorfulFonts } from "./client/web";
import {
  REASONING_RENDERER_KIND,
  TODO_RENDERER_KIND,
  TODO_RENDERER_VERSION,
  TOOL_CALL_RENDERER_KIND,
  REASONING_RENDERER_VERSION,
  TOOL_CALL_RENDERER_VERSION,
  reasoningItemDataSchema,
  todoItemDataSchema,
  toolCallItemDataSchema,
} from "./shared/timeline";

export default function contribute(client: PluginClientContext) {
  const removeFonts = installColorfulFonts();
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
    id: "todos",
    query: { itemType: "todo" },
    transform: transformTodo,
  });
  client.addTimelineTransformer({
    id: "tool-calls",
    query: { itemType: "tool_call" },
    transform: transformToolCall,
  });
  client.addTimelineRenderer({
    kind: TODO_RENDERER_KIND,
    version: TODO_RENDERER_VERSION,
    schema: todoItemDataSchema,
    Component: ColorfulTodo,
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
  return () => {
    removeFonts();
  };
}
