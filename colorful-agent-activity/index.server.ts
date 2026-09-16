import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handleReadImage } from "./server/read-image.js";
import { readImageRpc } from "./shared/read-image.js";
import { activitySettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(activitySettings);
  server.handle(readImageRpc, (input, context) => handleReadImage(input, context));
  return () => {};
}
