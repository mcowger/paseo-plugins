import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_BASE_URL = "http://localhost:4000";

/**
 * One host-scoped settings document.
 *
 * `baseUrl` is intentionally a plain string: a URL-validated schema would make the whole document
 * invalid on a typo and take the stored admin key with it. It is normalised and validated where it is
 * used instead, and the panel surfaces the failure as a connection state.
 *
 * `adminKey` is a credential. Paseo settings are ordinary host-side JSON (mode 0600) rather than a
 * vault, so it is never rendered back, never returned from an RPC, and never logged.
 */
export const plexusConfig = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: z.object({
    baseUrl: z.string().trim().default(DEFAULT_BASE_URL),
    adminKey: z.string().trim().default(""),
    /** Key name to scope to on first load; null means every key. */
    defaultScope: z.string().trim().nullable().default(null),
  }),
});

export type PlexusConfig = z.infer<typeof plexusConfig.schema>;

export type BaseUrlResult =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly error: string };

const BASE_URL_PATTERN = /^(https?):\/\/([^/?#\s]+)(\/[^?#\s]*)?$/i;

/**
 * Normalises the Plexus origin: trims, drops trailing slashes, keeps an optional path prefix, and
 * rejects credentials or query strings. Pure string handling so it is safe in both runtimes.
 */
export function normalizeBaseUrl(raw: string): BaseUrlResult {
  const trimmed = raw.trim();
  if (!trimmed)
    return { ok: false, error: "Enter the Plexus URL, for example http://localhost:4000" };

  const match = BASE_URL_PATTERN.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error: "Use a full http:// or https:// URL without a query string.",
    };
  }

  const [, scheme = "", authority = "", rawPath = ""] = match;
  if (authority.includes("@")) {
    return { ok: false, error: "Remove the credentials from the URL and use the admin key field." };
  }

  const path = rawPath.replace(/\/+$/, "");
  return { ok: true, baseUrl: `${scheme.toLowerCase()}://${authority}${path}` };
}

/** Ready-to-run configuration, or the reason the plugin cannot connect. */
export function resolveConfig(
  config: PlexusConfig,
):
  | { readonly ok: true; readonly baseUrl: string; readonly adminKey: string }
  | { readonly ok: false; readonly error: string } {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl.ok) return { ok: false, error: baseUrl.error };
  if (!config.adminKey) {
    return { ok: false, error: "Add your Plexus admin key in the plugin settings." };
  }
  return { ok: true, baseUrl: baseUrl.baseUrl, adminKey: config.adminKey };
}
