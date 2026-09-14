import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createPiProvider } from "./server/provider.js";
import { createPiProfileToolPolicyHandlers } from "./server/profile-tool-policy.js";
import { createPiToolPolicyStore } from "./server/tool-policy.js";
import {
  getPiToolPolicyKnownToolsRpc,
  getPiToolPolicyProfilesRpc,
  getPiToolPolicyRevisionRpc,
  piToolPolicySettings,
  syncPiToolPolicyProfileMarkersRpc,
  syncPiToolPolicyRpc,
} from "./shared/tool-policy.js";

export default function contribute(server: PluginServerContext) {
  const toolPolicyStore = createPiToolPolicyStore();
  const profileToolPolicyHandlers = createPiProfileToolPolicyHandlers();
  server.registerSettings(piToolPolicySettings);
  server.handle(getPiToolPolicyRevisionRpc, () => ({
    revision: toolPolicyStore.snapshot().revision,
  }));
  server.handle(syncPiToolPolicyRpc, ({ previousRevision, revision, values }) => {
    toolPolicyStore.update(values, revision, previousRevision);
    return { revision };
  });
  server.handle(getPiToolPolicyProfilesRpc, (_, context) =>
    profileToolPolicyHandlers.listProfiles(context.paseo),
  );
  server.handle(syncPiToolPolicyProfileMarkersRpc, (_, context) =>
    profileToolPolicyHandlers.syncProfileMarkers(context.paseo),
  );
  server.handle(getPiToolPolicyKnownToolsRpc, () => profileToolPolicyHandlers.listKnownTools());
  server.registerProvider(createPiProvider(toolPolicyStore));
  return () => {};
}
