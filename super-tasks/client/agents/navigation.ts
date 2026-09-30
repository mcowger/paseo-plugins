import { Linking, Platform } from "react-native";
import { buildAgentRoute, dispatchOpenAgentRequest } from "../web";

/**
 * Opens the owning agent in a Paseo workspace tab. On web the shell handles a
 * host event (see `client/web.ts`); on native we use the app's deep link.
 */
export function openAgentInPaseoWorkspace(
  serverId: string,
  workspaceId: string,
  agentId: string,
): void {
  if (Platform.OS === "web") {
    dispatchOpenAgentRequest({ serverId, workspaceId, agentId });
    return;
  }

  const route = buildAgentRoute({ serverId, workspaceId, agentId });
  void Linking.openURL(`paseo:/${route}`).catch(() => undefined);
}
