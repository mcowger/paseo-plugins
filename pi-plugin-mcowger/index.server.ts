import type { PluginServerContext } from "@getpaseo/plugin/server";

import { activePiProfileIdFromRuntimeSessionId } from "./server/active-profile.js";
import { createPiProvider } from "./server/provider.js";
import { createPiProfileToolPolicyHandlers } from "./server/profile-tool-policy.js";
import { createPiToolPolicyStore } from "./server/tool-policy.js";
import {
  getPiActiveProfileRpc,
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
  server.handle(getPiActiveProfileRpc, async ({ agentId }, context) => {
    const result = await context.paseo.agents.ref(agentId).refresh();
    const profileId = activePiProfileIdFromRuntimeSessionId(result?.agent.runtimeInfo?.sessionId);
    console.info(`[pi-profile] lookup agent=${agentId} profile=${profileId ?? "none"}`);
    return { profileId };
  });
  server.handle(syncPiToolPolicyProfileMarkersRpc, (_, context) =>
    profileToolPolicyHandlers.syncProfileMarkers(context.paseo),
  );
  server.handle(getPiToolPolicyKnownToolsRpc, () => profileToolPolicyHandlers.listKnownTools());
  const removeProfileMarkerSync = server.before("agent.create", async ({ request }, context) => {
    if (request.config.provider === "pi-plugin-mcowger") {
      await profileToolPolicyHandlers.syncProfileMarkers(context.paseo).catch(() => undefined);
    }
    return request;
  });
  server.registerProvider(createPiProvider(toolPolicyStore));
  return () => {
    removeProfileMarkerSync();
  };
}
