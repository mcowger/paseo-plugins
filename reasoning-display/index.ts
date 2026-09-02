import type { PluginContext } from "@getpaseo/plugin";
import { ReasoningDisplaySettings, ReasoningTimelineItem } from "./reasoning.client";
import { getReasoningSettings, setReasoningSettings } from "./reasoning.server";
import {
  getReasoningSettingsRpc,
  REASONING_RENDERER_KIND,
  REASONING_RENDERER_VERSION,
  reasoningItemDataSchema,
  setReasoningSettingsRpc,
  transformReasoning,
} from "./reasoning.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(getReasoningSettingsRpc, getReasoningSettings);
  plugin.handle(setReasoningSettingsRpc, setReasoningSettings);
  plugin.addSurface("settings", ReasoningDisplaySettings);
  plugin.addSidebarItem({
    id: "settings",
    title: "Reasoning Display",
    icon: "Brain",
    surface: "settings",
  });
  plugin.addTimelineTransformer({
    id: "reasoning-display",
    query: { itemType: "reasoning" },
    transform: transformReasoning,
  });
  plugin.addTimelineRenderer({
    kind: REASONING_RENDERER_KIND,
    version: REASONING_RENDERER_VERSION,
    schema: reasoningItemDataSchema,
    Component: ReasoningTimelineItem,
  });
  return () => {};
}
