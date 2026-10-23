import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPlexusPort } from "./server/plexus-port";
import { createActivityService } from "./server/service";
import { keysRpc, snapshotRpc, verifyRpc } from "./shared/rpc";
import { plexusConfig } from "./shared/settings";
import { keysInputSchema, snapshotInputSchema, verifyInputSchema } from "./shared/view";

/**
 * There is no startup lifecycle event and no server-to-client push in the 0.12.0 plugin API: the
 * service starts here and the returned cleanup stops it on reload, disable, removal, or daemon exit.
 */
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(plexusConfig);
  const service = createActivityService({
    settings,
    port: createPlexusPort(),
    log: (message) => console.warn(`[plexus-activity] ${message}`),
  });

  server.handle(snapshotRpc, (input) => service.snapshot(snapshotInputSchema.parse(input)));
  server.handle(keysRpc, (input) => service.keys(keysInputSchema.parse(input)));
  server.handle(verifyRpc, (input) => service.verify(verifyInputSchema.parse(input)));

  service.start();
  return () => service.stop();
}
