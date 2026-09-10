import type { PluginServerContext } from "@getpaseo/plugin/server";
import { activitySettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(activitySettings);
  return () => {};
}
