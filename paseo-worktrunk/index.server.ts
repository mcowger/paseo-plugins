import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createWorktrunkHooks } from "./server/worktrunk.js";

export default function contribute(server: PluginServerContext) {
  return createWorktrunkHooks(server);
}
