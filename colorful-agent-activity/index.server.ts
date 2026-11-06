import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerClientPayload } from "./server/payload.js";
import { handleReadImage } from "./server/read-image.js";
import { readImageRpc } from "./shared/read-image.js";
import { TURN_END_KIND } from "./shared/activity-time.js";
import { activitySettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(activitySettings);
  server.handle(readImageRpc, (input, context) => handleReadImage(input, context));
  registerClientPayload(server);
  const removeTurnEnd = server.on("agent.turn_ended", async (event, context) => {
    const at = Date.now();
    try {
      const state = await settings.read();
      if (state.status !== "ready" || !state.values.timestamps) return;
      await context.paseo.agents.ref(event.agent.id).timeline.append({
        type: "plugin",
        id: `${event.turnId ?? "turn"}-end-${at}`,
        kind: TURN_END_KIND,
        version: 1,
        data: { at },
      });
    } catch (error) {
      console.warn("[colorful-agent-activity] Could not record turn end time", error);
    }
  });
  return () => {
    removeTurnEnd();
  };
}
