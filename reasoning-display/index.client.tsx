import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ReasoningDisplaySettings, ReasoningTimelineItem } from "./client/reasoning";
import { transformReasoning } from "./client/transform-reasoning";
import {
  REASONING_RENDERER_KIND,
  REASONING_RENDERER_VERSION,
  reasoningItemDataSchema,
} from "./shared/reasoning";

export default function contribute(client: PluginClientContext) {
  client.addSurface("settings", ReasoningDisplaySettings);
  client.addSidebarItem({
    id: "settings",
    title: "Reasoning Display",
    icon: "Brain",
    surface: "settings",
  });
  client.addTimelineTransformer({
    id: "reasoning-display",
    query: { itemType: "reasoning" },
    transform: transformReasoning,
  });
  client.addTimelineRenderer({
    kind: REASONING_RENDERER_KIND,
    version: REASONING_RENDERER_VERSION,
    schema: reasoningItemDataSchema,
    Component: ReasoningTimelineItem,
  });
  return () => {};
}
