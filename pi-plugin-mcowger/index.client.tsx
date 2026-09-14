import type { PluginClientContext } from "@getpaseo/plugin/client";

import { contributePiRuntimeSettingsPill } from "./client/pi-runtime-settings-pill.js";

export default function contribute(client: PluginClientContext) {
  return contributePiRuntimeSettingsPill(client);
}
