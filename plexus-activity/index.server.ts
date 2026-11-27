import type { PluginServerContext } from "@getpaseo/plugin/server";
import { streamActivity } from "./server/activity-stream";
import { createPlexusPort } from "./server/plexus-port";
import { createActivityService } from "./server/service";
import { activityStreamSubscription, keysRpc, snapshotRpc, verifyRpc } from "./shared/rpc";
import { plexusConfig } from "./shared/settings";
import {
  activitySubscribeInputSchema,
  keysInputSchema,
  snapshotInputSchema,
  verifyInputSchema,
} from "./shared/view";

/**
 * The service starts here and the returned cleanup stops it on reload, disable, removal, or daemon
 * exit. Each open panel holds one `activityStreamSubscription`; the server pushes changes to it and
 * releases the subscription when the panel closes or the plugin stops.
 */
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(plexusConfig);
  const service = createActivityService({
    settings,
    port: createPlexusPort(),
    log: (message) => console.warn(`[plexus-activity] ${message}`),
  });

  server.handle(snapshotRpc, (input) => service.snapshot(snapshotInputSchema.parse(input)));
  server.handle(activityStreamSubscription, (input, context) =>
    streamActivity(service, activitySubscribeInputSchema.parse(input), context),
  );
  server.handle(keysRpc, (input) => service.keys(keysInputSchema.parse(input)));
  server.handle(verifyRpc, (input) => service.verify(verifyInputSchema.parse(input)));

  service.start();
  return () => service.stop();
}
