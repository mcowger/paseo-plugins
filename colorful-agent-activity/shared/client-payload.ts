import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { CLIENT_PAYLOAD_VERSION } from "./client-payload-version";

/**
 * Paseo sends every plugin's whole client bundle inside the plugin catalog, on
 * every connect and every plugin change. This plugin's real client code is far
 * larger than a plugin should have to re-transfer on a flaky link, so the catalog
 * carries a tiny loader instead and the code itself is fetched once, cached in
 * the app's JS context, and reused for later reconnects.
 *
 * `version` is the hash of the payload the loader was built against: a reconnect
 * whose loader version matches the cached payload needs no request at all.
 */
export const clientPayloadRpc = defineRpc({
  name: "client.payload",
  input: z.object({}),
  output: z.object({
    version: z.string(),
    code: z.string(),
  }),
});

export { CLIENT_PAYLOAD_VERSION };
