import type { PluginServerContext } from "@getpaseo/plugin/server";

import { activePiProfileIdFromRuntimeSessionId } from "./server/active-profile.js";
import { createPiProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  const provider = createPiProvider();
  server.registerProvider(provider);
  return async () => {
    await provider.close();
  };
}
