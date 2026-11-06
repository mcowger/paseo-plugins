import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const displayPreferences = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({ displayAs: z.enum(["used", "remaining"]).default("used") }),
});
export type DisplayAs = "used" | "remaining";
