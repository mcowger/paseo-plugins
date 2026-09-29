import type { PluginServerContext } from "@getpaseo/plugin/server";
import { skillUsageSettings } from "./shared/usage";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(skillUsageSettings);
  return () => {};
}
