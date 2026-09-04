import type { PluginServerContext } from "@getpaseo/plugin";
import { getReasoningSettings, setReasoningSettings } from "./server/reasoning";
import { getReasoningSettingsRpc, setReasoningSettingsRpc } from "./shared/reasoning";

export default function contribute(server: PluginServerContext) {
  server.handle(getReasoningSettingsRpc, getReasoningSettings);
  server.handle(setReasoningSettingsRpc, setReasoningSettings);
  return () => {};
}
