import { defineSettings } from "@getpaseo/plugin";
import { PLUGIN_ID, PluginSettingsSchema } from "./config";

export const polyrepoSettings = defineSettings({
  id: PLUGIN_ID,
  scope: "host",
  version: 1,
  schema: PluginSettingsSchema,
});
