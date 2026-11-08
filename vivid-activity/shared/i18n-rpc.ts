import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The RPC that brings a plugin's text to the client (client `i18n-client.tsx`, server `i18n-server.ts`). The resident
 * stub imports only this file; the Language setting and its listing RPC live in `i18n-settings.ts`, which only the
 * settings view and the server load. Every public plugin registers the same names; RPCs and settings are per plugin.
 */
export const LANGUAGE_SETTINGS_ID = "language";
const hash = z.string().regex(/^[0-9a-f]{16}$/);
/** The device's language tag, e.g. "en-US"; "" when the client cannot tell. */
const device = z.string().max(80);
const language = z.string().max(40);

/**
 * The plugin's text in the language to speak, as JSON cut into parts. Part 0 answers `unchanged` when the client
 * already holds `have`; later parts name the `hash` of part 0, and fail if the server no longer has that catalog.
 * `scope: "boot"` asks only for the boot text (one small part, its own hash); `have` still names a full catalog.
 */
export const i18nCatalogRpc = defineRpc({
  name: "i18n.catalog",
  input: z.object({ device, have: hash.optional(), hash: hash.optional(), part: z.number().int().min(0).max(255), scope: z.literal("boot").optional() }).strict(),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("unchanged"), language, hash }),
    z.object({ status: z.literal("ok"), language, hash, part: z.number().int().nonnegative(), parts: z.number().int().positive().max(256), text: z.string() }),
  ]),
});
