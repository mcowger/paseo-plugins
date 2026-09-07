import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createPiProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createPiProvider());
  return () => {};
}
