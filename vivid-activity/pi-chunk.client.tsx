import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ChunkExtras } from "./client/lazy-chunk";
import { followText } from "./shared/i18n";
import { readPiNotice } from "./shared/pi-notice";

/**
 * 0.6.0-local.5: the Pi notice reader (shared/pi-notice.ts) in a lazy chunk of its own. Only Pi and OMP Agents send these
 * notices, so the resident timeline leaves it out and client/transform.ts loads it when the first one is drawn.
 */
export default function chunk() {
  return { api: 1, createSurfaces(_client: PluginClientContext, extras?: ChunkExtras) { followText(extras?.text); return { readPiNotice }; } };
}
