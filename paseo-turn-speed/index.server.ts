import type { PluginServerContext } from "@getpaseo/plugin/server";
import { meterState, preferences } from "./shared/preferences";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(preferences);
  server.registerSettings(meterState);
  return () => {};
}
