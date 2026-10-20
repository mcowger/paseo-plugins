/**
 * API protocol labels and the live throughput heuristic.
 *
 * Plexus renders `incomingApiType` and `outgoingApiType` as icons and only uses the label in
 * tooltips; a narrow Explorer card has no room for icons, so both types are rendered as short text.
 * Vendor prefixes are dropped because the panel intentionally shows no provider information.
 */

/** Protocol aliases that only add a vendor prefix. Anything else renders verbatim. */
const API_TYPE_ALIASES: Readonly<Record<string, string>> = {
  "openai-completions": "completions",
  "openai-chat": "chat",
  "openai-responses": "responses",
  "anthropic-messages": "messages",
  "google-generative-ai": "gemini",
  "google-vertex": "vertex",
};

/** Base protocol before any `type:subtype` qualifier, lowercased. */
export function getApiBaseType(apiType: string | null | undefined): string {
  if (!apiType) return "";
  return apiType.trim().toLowerCase().split(":", 1)[0] ?? "";
}

/** Short label for a protocol, e.g. `anthropic-messages` → `messages`, `chat` → `chat`. */
export function formatApiType(apiType: string | null | undefined): string {
  const base = getApiBaseType(apiType);
  if (!base) return "-";
  return API_TYPE_ALIASES[base] ?? base;
}

/**
 * `incoming→outgoing`, or a single label when both resolve to the same protocol.
 */
export function formatApiTransition(
  incoming: string | null | undefined,
  outgoing: string | null | undefined,
): string {
  const from = formatApiType(incoming);
  const to = formatApiType(outgoing);
  if (from === "-" && to === "-") return "-";
  if (from === to || to === "-") return from;
  if (from === "-") return to;
  return `${from}→${to}`;
}

/**
 * Average wire bytes per output token for a streamed response.
 *
 * Live SSE chunks carry protocol framing (`data: {...}` envelopes) that dominates payload size, so
 * bytes-per-second divided by this factor estimates tokens per second before the provider reports
 * real usage. Ported from Plexus (`packages/frontend/src/lib/format.ts`), including its defaults.
 */
export function getEstimatedBytesPerToken(options: {
  incomingApiType?: string | null;
  outgoingApiType?: string | null;
  isStreamed?: boolean | null;
}): number {
  if (options.isStreamed === false) return 4.5;

  const apiType = (options.incomingApiType || options.outgoingApiType || "").toLowerCase();

  if (apiType.includes("anthropic") || apiType.includes("messages") || apiType === "oauth") {
    return 140;
  }
  if (apiType.includes("responses")) return 200;
  if (apiType.includes("openai") || apiType.includes("chat") || apiType.includes("antigravity")) {
    return 215;
  }
  if (apiType.includes("gemini") || apiType.includes("google")) return 140;
  return 140;
}

/**
 * Estimated live tokens/sec from a progress event, or null when no usable byte rate exists.
 * Mirrors `DesktopLogRow`'s derivation in Plexus.
 */
export function estimateTokensPerSec(
  progress: {
    bytesPerSec?: number | null;
    semanticBytesPerSec?: number | null;
    semanticBytesReceived?: number | null;
    elapsedMs?: number | null;
    isStreamed?: boolean | null;
  },
  record: {
    incomingApiType?: string | null;
    outgoingApiType?: string | null;
  },
): number | null {
  const semanticBytesPerSec = progress.semanticBytesPerSec ?? progress.bytesPerSec ?? null;
  const semanticBytesReceived = progress.semanticBytesReceived ?? null;
  const elapsedMs = progress.elapsedMs ?? null;

  const effectiveBytesPerSec =
    semanticBytesPerSec !== null && semanticBytesPerSec > 0
      ? semanticBytesPerSec
      : elapsedMs !== null &&
          elapsedMs > 0 &&
          semanticBytesReceived !== null &&
          semanticBytesReceived > 0
        ? (semanticBytesReceived / elapsedMs) * 1000
        : null;

  if (effectiveBytesPerSec === null || !Number.isFinite(effectiveBytesPerSec)) return null;

  const bytesPerToken = getEstimatedBytesPerToken({
    incomingApiType: record.incomingApiType,
    outgoingApiType: record.outgoingApiType,
    isStreamed: progress.isStreamed ?? true,
  });
  const tokensPerSec = effectiveBytesPerSec / bytesPerToken;
  return Number.isFinite(tokensPerSec) && tokensPerSec > 0 ? tokensPerSec : null;
}
