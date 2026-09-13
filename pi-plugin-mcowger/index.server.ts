import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createPiProvider } from "./server/provider.js";
import { createPiToolPolicyStore } from "./server/tool-policy.js";
import {
  getPiToolPolicyRevisionRpc,
  piToolPolicySettings,
  syncPiToolPolicyRpc,
} from "./shared/tool-policy.js";

export default function contribute(server: PluginServerContext) {
  const toolPolicyStore = createPiToolPolicyStore();
  server.registerSettings(piToolPolicySettings);
  server.handle(getPiToolPolicyRevisionRpc, () => ({
    revision: toolPolicyStore.snapshot().revision,
  }));
  server.handle(syncPiToolPolicyRpc, ({ previousRevision, revision, values }) => {
    toolPolicyStore.update(values, revision, previousRevision);
    return { revision };
  });
  server.registerProvider(createPiProvider(toolPolicyStore));
  return () => {};
}
