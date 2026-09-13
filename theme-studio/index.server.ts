import type { PluginServerContext } from "@getpaseo/plugin/server";
import { themeStudioSettings } from "./shared/settings.js";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(themeStudioSettings);
  return () => {};
}
