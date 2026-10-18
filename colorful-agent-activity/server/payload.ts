import type { PluginServerContext } from "@getpaseo/plugin/server";
import { CLIENT_PAYLOAD_VERSION, clientPayloadRpc } from "../shared/client-payload";
import { CLIENT_PAYLOAD } from "./client-payload.generated";

/**
 * Serves the plugin's client code to its own loader.
 *
 * The code lives in the server bundle (generated at build time) rather than on
 * disk, because a plugin server module is evaluated from a string: it has no
 * reliable `__dirname`, and installs can live at any path.
 */
export function registerClientPayload(server: PluginServerContext): void {
  server.handle(clientPayloadRpc, () => ({
    version: CLIENT_PAYLOAD_VERSION,
    code: CLIENT_PAYLOAD,
  }));
}
