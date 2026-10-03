import { z } from "zod";

/** Superpi companion envelope protocol version. */
export const PROTOCOL_VERSION = 1;

/** Prefix placed on every `ctx.ui.notify` message that carries a companion reply. */
export const NOTIFY_PREFIX = "superpi:v1:";

/** Pi slash command that carries base64url-encoded control requests. */
export const COMMAND_NAME = "superpi-control";

/** Session custom-entry type used for branch-local companion state. */
export const CUSTOM_ENTRY_TYPE = "superpi-controls";

/**
 * Session custom-entry type used to pin the active branch after a rewind.
 * Pi reopens a session at its last entry, so appending this entry after
 * `navigateTree` keeps the rewound branch on reopen.
 */
export const REWIND_ENTRY_TYPE = "superpi-rewind";

/** Notification prefix for forwarded owned-subagent bridge records. */
export const CHILD_NOTIFY_PREFIX = "superpi:child:v1:";

/** Cross-extension bus channel that carries owned-subagent bridge records. */
export const SUBAGENT_BRIDGE_CHANNEL = "superpi:subagent:v1";

/** Schema version carried by every owned-subagent bridge record. */
export const SUBAGENT_BRIDGE_VERSION = 1;

/** CLI flag the provider passes on the root Pi launch. */
export const ROOT_FLAG = "superpi-companion-root";

/** Launch environment variable carrying the integration session key. */
export const SESSION_KEY_ENV = "SUPERPI_SESSION_KEY";

/** Optional launch environment variable marking the root owner. */
export const ROLE_ENV = "SUPERPI_COMPANION_ROLE";

export const TierSchema = z.enum(["default", "fast", "flex", "ultrafast"]);
export type Tier = z.infer<typeof TierSchema>;
export const TIERS: readonly Tier[] = ["default", "fast", "flex", "ultrafast"];

export const SuperpiSettingsSchema = z.strictObject({
  tier: TierSchema,
  longContext: z.boolean(),
});

export const OperationSchema = z.enum(["hello", "get-state", "configure", "rewind", "compact"]);
export type Operation = z.infer<typeof OperationSchema>;

export const OriginSchema = z.enum(["root", "child"]);
export type Origin = z.infer<typeof OriginSchema>;

export const ConfigureDataSchema = z.strictObject({
  tier: TierSchema.optional(),
  longContext: z.boolean().optional(),
});
export type ConfigureData = z.infer<typeof ConfigureDataSchema>;

export const RewindDataSchema = z.strictObject({
  targetEntryId: z.string().min(1),
});

export const CompactDataSchema = z.strictObject({
  customInstructions: z.string().max(4096).optional(),
});

/**
 * Rewind reply data. `cancelled` is true when Pi's own tree navigation was
 * cancelled; `leafId` is omitted when navigation reset to the root.
 */
export const RewindResultSchema = z.strictObject({
  cancelled: z.boolean(),
  targetEntryId: z.string().min(1),
  leafId: z.string().optional(),
  settings: SuperpiSettingsSchema,
  activeChildren: z.number().int().nonnegative(),
});
export type RewindResult = z.infer<typeof RewindResultSchema>;

/** Compact reply data. Only emitted after a supported completion signal. */
export const CompactResultSchema = z.strictObject({
  compacted: z.literal(true),
});
export type CompactResult = z.infer<typeof CompactResultSchema>;

/** Branch pin persisted after a successful rewind. */
export const RewindEntrySchema = z.strictObject({
  version: z.literal(PROTOCOL_VERSION),
  targetEntryId: z.string().min(1),
  leafId: z.string().nullable().optional(),
  timestamp: z.number().int().nonnegative(),
});
export type RewindEntry = z.infer<typeof RewindEntrySchema>;

/**
 * One versioned owned-subagent bridge record (shape owned by the pi-subagents
 * `bridge.ts`). Records are validated before forwarding; unknown top-level keys
 * are rejected so a schema drift is visible rather than silently passed on.
 * `omitted`/`omittedBytes` mark a payload the bridge bounded by its per-record
 * cap; identity and `transcriptPath` still travel so the native transcript
 * remains the recovery path.
 */
export const SubagentBridgeRecordSchema = z.strictObject({
  version: z.literal(SUBAGENT_BRIDGE_VERSION),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: z.enum(["created", "activity", "terminal"]),
  parentRunId: z.string().optional(),
  parentSessionId: z.string().optional(),
  childSessionId: z.string().optional(),
  toolCallId: z.string().optional(),
  title: z.string().optional(),
  timestamp: z.number().optional(),
  transcriptPath: z.string().optional(),
  cwd: z.string().optional(),
  record: z.unknown().optional(),
  outcome: z.enum(["completed", "steered", "canceled", "failed"]).optional(),
  result: z.unknown().optional(),
  reason: z.string().optional(),
  omitted: z.boolean().optional(),
  omittedBytes: z.number().int().nonnegative().optional(),
});
export type SubagentBridgeRecord = z.infer<typeof SubagentBridgeRecordSchema>;

/** Forwarded child envelope emitted as `superpi:child:v1:<json>`. */
export const ChildForwardSchema = z.strictObject({
  version: z.literal(SUBAGENT_BRIDGE_VERSION),
  sessionKey: z.string(),
  record: SubagentBridgeRecordSchema,
});
export type ChildForward = z.infer<typeof ChildForwardSchema>;

export const SuperpiRequestSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  sessionKey: z.string().min(1),
  requestId: z.string().min(1),
  operation: OperationSchema,
  data: z.unknown().optional(),
});
export type SuperpiRequest = z.infer<typeof SuperpiRequestSchema>;

export const ConflictSchema = z.strictObject({
  owner: z.string().min(1),
  command: z.string().min(1),
  resolution: z.string().min(1),
});
export type Conflict = z.infer<typeof ConflictSchema>;

/**
 * Exact control state reported by `hello` and `get-state` and echoed by
 * `configure`. Optional fields are omitted when the companion cannot observe
 * them, never fabricated.
 */
export const SuperpiStateSchema = z.strictObject({
  capabilities: z.array(z.string()),
  settings: SuperpiSettingsSchema,
  contextWindow: z.number().int().nonnegative().optional(),
  activeChildren: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
  origin: OriginSchema,
  tiers: z.array(TierSchema),
  longContextTarget: z.number().int().nonnegative().optional(),
  modelBaselineContextWindow: z.number().int().nonnegative().optional(),
  tierApplicable: z.boolean(),
  conflicts: z.array(ConflictSchema),
  limitations: z.array(z.string()),
});
export type SuperpiState = z.infer<typeof SuperpiStateSchema>;

export const SuperpiReplySchema = z.strictObject({
  version: z.literal(PROTOCOL_VERSION),
  sessionKey: z.string(),
  requestId: z.string(),
  operation: OperationSchema,
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type SuperpiReply = z.infer<typeof SuperpiReplySchema>;

export const ControlEntrySchema = z.strictObject({
  version: z.literal(PROTOCOL_VERSION),
  tier: TierSchema,
  longContext: z.boolean(),
  contextWindow: z.number().int().nonnegative().optional(),
  timestamp: z.number().int().nonnegative(),
});
export type ControlEntry = z.infer<typeof ControlEntrySchema>;

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ");
}

export function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function encodeRequest(request: SuperpiRequest): string {
  return encodeBase64Url(JSON.stringify(request));
}

export type ParsedRequestResult =
  | { ok: true; request: SuperpiRequest }
  | { ok: false; error: string; sessionKey: string; requestId: string; operation: Operation };

/** Parse the slash-command argument into a validated request, preserving any correlation fields present. */
export function parseRequestArg(args: string): ParsedRequestResult {
  const trimmed = args.trim();
  if (!trimmed) {
    return { ok: false, error: "missing base64url-encoded request", sessionKey: "", requestId: "", operation: "hello" };
  }

  let json: string;
  try {
    json = decodeBase64Url(trimmed);
  } catch {
    return { ok: false, error: "invalid base64url request", sessionKey: "", requestId: "", operation: "hello" };
  }
  if (json.trim().length === 0) {
    return { ok: false, error: "empty request payload", sessionKey: "", requestId: "", operation: "hello" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "request payload is not valid JSON", sessionKey: "", requestId: "", operation: "hello" };
  }

  const result = SuperpiRequestSchema.safeParse(parsed);
  if (result.success) return { ok: true, request: result.data };

  const loose = (parsed ?? {}) as Record<string, unknown>;
  const operation = OperationSchema.safeParse(loose.operation);
  return {
    ok: false,
    error: `invalid request: ${formatIssues(result.error)}`,
    sessionKey: typeof loose.sessionKey === "string" ? loose.sessionKey : "",
    requestId: typeof loose.requestId === "string" ? loose.requestId : "",
    operation: operation.success ? operation.data : "hello",
  };
}
