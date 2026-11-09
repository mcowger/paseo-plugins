import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ChunkExtras } from "./client/lazy-chunk";
import { followText } from "./shared/i18n";
import { DetailBody, ReasoningText } from "./client/activity-details";
import { ActivitySettings } from "./client/settings";

export default function chunk() {
  return { api: 1, createSurfaces(_client: PluginClientContext, extras?: ChunkExtras) { followText(extras?.text); return { detail: DetailBody, reasoning: ReasoningText, settings: ActivitySettings }; } };
}
