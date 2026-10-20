import { z } from "zod";

/**
 * Serializable view model shared by the server handlers and the panel.
 *
 * A row carries only what the card renders plus the minimum needed for correct live behaviour:
 * `startTime` for the in-flight duration ticker and `status` for deciding whether a request is still
 * running. `apiKey` and `date` stay on the server; scoping and ordering happen there.
 */

export const connectionStateSchema = z.enum([
  "unconfigured",
  "connecting",
  "live",
  "degraded",
  "retrying",
  "unauthorized",
  "error",
]);

export type ConnectionState = z.infer<typeof connectionStateSchema>;

export const tokenBucketsSchema = z.object({
  input: z.number().nullable(),
  cached: z.number().nullable(),
  cacheWrite: z.number().nullable(),
  output: z.number().nullable(),
  reasoning: z.number().nullable(),
  estimated: z.boolean(),
});

export type TokenBuckets = z.infer<typeof tokenBucketsSchema>;

export const usageRowSchema = z.object({
  requestId: z.string().min(1),
  startTime: z.number(),
  /** Plexus `responseStatus`. Never rendered; drives the in-flight ticker. */
  status: z.string().nullable(),
  incomingApiType: z.string().nullable(),
  outgoingApiType: z.string().nullable(),
  isStreamed: z.boolean(),
  isRaw: z.boolean(),
  isPassthrough: z.boolean(),
  isVisionFallthrough: z.boolean(),
  modelSlug: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  serviceTier: z.string().nullable(),
  requestedServiceTier: z.string().nullable(),
  tokens: tokenBucketsSchema,
  costTotal: z.number().nullable(),
  durationMs: z.number().nullable(),
  ttftMs: z.number().nullable(),
  tokensPerSec: z.number().nullable(),
  /** Estimated live throughput from a `progress` event; null once the request completes. */
  liveTokensPerSec: z.number().nullable(),
  /** Server sequence number of the last mutation, used for delta polling. */
  updatedSeq: z.number(),
});

export type UsageRow = z.infer<typeof usageRowSchema>;

export const connectionStatusSchema = z.object({
  configured: z.boolean(),
  connection: connectionStateSchema,
  lastEventAt: z.number().nullable(),
  lastError: z.string().nullable(),
  retryInMs: z.number().nullable(),
});

export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

export const snapshotInputSchema = z.object({
  /** API key name to scope to, or null for every key. */
  scope: z.string().min(1).nullable(),
  /** Cursor from the previous snapshot, or null for a full snapshot. */
  since: z.number().int().nonnegative().nullable(),
});

export type SnapshotInput = z.infer<typeof snapshotInputSchema>;

export const snapshotOutputSchema = z.object({
  status: connectionStatusSchema,
  cursor: z.number().int().nonnegative(),
  /** Server clock at snapshot time, for client-side live-duration skew correction. */
  serverNow: z.number(),
  /** True when the client must replace its list instead of merging the delta. */
  reset: z.boolean(),
  rows: z.array(usageRowSchema),
});

export type SnapshotOutput = z.infer<typeof snapshotOutputSchema>;

export const keyEntrySchema = z.object({
  name: z.string().min(1),
  /** True when Plexus reports the key as disabled. */
  disabled: z.boolean(),
});

export type KeyEntry = z.infer<typeof keyEntrySchema>;

export const keysInputSchema = z.object({
  /** Ask the server to re-read the key list from Plexus instead of using its cache. */
  refresh: z.boolean().optional(),
});

export type KeysInput = z.infer<typeof keysInputSchema>;

export const keysOutputSchema = z.object({
  status: z.enum(["ok", "unavailable", "unauthorized"]),
  /** The admin key can see every key; a limited key is already scoped by Plexus. */
  role: z.enum(["admin", "limited"]).nullable(),
  keys: z.array(keyEntrySchema),
});

export type KeysOutput = z.infer<typeof keysOutputSchema>;

export const verifyInputSchema = z.object({
  baseUrl: z.string().min(1),
  adminKey: z.string().min(1),
});

export type VerifyInput = z.infer<typeof verifyInputSchema>;

export const verifyOutputSchema = z.object({
  ok: z.boolean(),
  role: z.enum(["admin", "limited"]).nullable(),
  keyName: z.string().nullable(),
  /** Redacted, human-readable failure reason. Never contains credentials. */
  error: z.string().nullable(),
});

export type VerifyOutput = z.infer<typeof verifyOutputSchema>;
