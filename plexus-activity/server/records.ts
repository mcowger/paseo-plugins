import { z } from "zod";
import type { RecordPatch } from "../shared/row-model";

/**
 * Normalisation of untrusted Plexus payloads.
 *
 * Plexus sends usage rows straight from its in-memory record, so the wire values mix real booleans
 * with SQLite integers (`0`/`1`) depending on which code path produced the event, and numeric fields
 * may arrive as strings from the REST endpoint. Only the envelope shape is schema-checked; the rest is
 * coerced field by field and anything unrecognised is dropped.
 */

const eventEnvelopeSchema = z.looseObject({ requestId: z.string().min(1) });

const progressEnvelopeSchema = z.looseObject({ requestId: z.string().min(1) });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }
  return false;
}

function readTimestamp(value: unknown): number | null {
  const numeric = readNumber(value);
  if (numeric !== null) return numeric;
  const text = readText(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Converts an SSE usage payload (`started`, `updated`, or `completed`) into a merge patch.
 * Returns null when the payload cannot identify a request.
 */
export function toRecordPatch(raw: unknown): RecordPatch | null {
  if (!isRecord(raw)) return null;
  const envelope = eventEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return null;

  const patch: RecordPatch = { requestId: envelope.data.requestId };

  const startTime = readTimestamp(raw.startTime) ?? readTimestamp(raw.date);
  if (startTime !== null) patch.startTime = startTime;

  const date = readText(raw.date);
  if (date !== null) patch.date = date;

  // Optional strings: an explicit null in the payload clears the field.
  const textFields = [
    ["responseStatus", "responseStatus"],
    ["apiKey", "apiKey"],
    ["incomingApiType", "incomingApiType"],
    ["outgoingApiType", "outgoingApiType"],
    ["incomingModelAlias", "incomingModelAlias"],
    ["selectedModelName", "selectedModelName"],
    ["finalAttemptModel", "finalAttemptModel"],
    ["reasoningEffort", "reasoningEffort"],
    ["serviceTier", "serviceTier"],
    ["requestedServiceTier", "requestedServiceTier"],
  ] as const;
  for (const [wire, field] of textFields) {
    if (wire in raw && raw[wire] !== undefined) {
      (patch as Record<string, unknown>)[field] = readText(raw[wire]);
    }
  }

  const numberFields = [
    ["tokensInput", "tokensInput"],
    ["tokensCached", "tokensCached"],
    ["tokensCacheWrite", "tokensCacheWrite"],
    ["tokensOutput", "tokensOutput"],
    ["tokensReasoning", "tokensReasoning"],
    ["costTotal", "costTotal"],
    ["durationMs", "durationMs"],
    ["ttftMs", "ttftMs"],
    ["tokensPerSec", "tokensPerSec"],
  ] as const;
  for (const [wire, field] of numberFields) {
    if (wire in raw && raw[wire] !== undefined) {
      (patch as Record<string, unknown>)[field] = readNumber(raw[wire]);
    }
  }

  const booleanFields = [
    ["isStreamed", "isStreamed"],
    ["isRaw", "isRaw"],
    ["isPassthrough", "isPassthrough"],
    ["isVisionFallthrough", "isVisionFallthrough"],
    ["tokensEstimated", "tokensEstimated"],
  ] as const;
  for (const [wire, field] of booleanFields) {
    if (wire in raw && raw[wire] !== undefined) {
      (patch as Record<string, unknown>)[field] = readBoolean(raw[wire]);
    }
  }

  return patch;
}

export interface ProgressSample {
  readonly bytesPerSec: number | null;
  readonly semanticBytesPerSec: number | null;
  readonly semanticBytesReceived: number | null;
  readonly elapsedMs: number | null;
  readonly isStreamed: boolean;
}

/** Converts an SSE `progress` payload. Returns null for unusable frames. */
export function toProgressSample(
  raw: unknown,
): { requestId: string; sample: ProgressSample } | null {
  if (!isRecord(raw)) return null;
  const envelope = progressEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return null;

  return {
    requestId: envelope.data.requestId,
    sample: {
      bytesPerSec: readNumber(raw.bytesPerSec),
      semanticBytesPerSec: readNumber(raw.semanticBytesPerSec),
      semanticBytesReceived: readNumber(raw.semanticBytesReceived),
      elapsedMs: readNumber(raw.elapsedMs),
      isStreamed: raw.isStreamed === undefined ? true : readBoolean(raw.isStreamed),
    },
  };
}

const usageListEnvelopeSchema = z.looseObject({ data: z.array(z.unknown()) });

/** Patches from a `GET /v0/management/usage` page. Malformed rows are skipped, never thrown. */
export function toRecordPatches(payload: unknown): RecordPatch[] {
  const envelope = usageListEnvelopeSchema.safeParse(payload);
  if (!envelope.success) return [];
  const patches: RecordPatch[] = [];
  for (const row of envelope.data.data) {
    const patch = toRecordPatch(row);
    if (patch !== null) patches.push(patch);
  }
  return patches;
}

const keyListSchema = z.record(z.string(), z.unknown());

/**
 * Key names from `GET /v0/management/keys`. The endpoint returns decrypted secrets, so every other
 * field is dropped here and can never reach an RPC response or a log line.
 */
export function toKeyEntries(payload: unknown): { name: string; disabled: boolean }[] {
  const parsed = keyListSchema.safeParse(payload);
  if (!parsed.success) return [];
  const entries: { name: string; disabled: boolean }[] = [];
  for (const [name, config] of Object.entries(parsed.data)) {
    if (!name.trim()) continue;
    const disabled = isRecord(config) && readNumber(config.disabledAt) !== null;
    entries.push({ name, disabled });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
}

const verifySchema = z.looseObject({
  ok: z.boolean().optional(),
  role: z.string().optional(),
  keyName: z.union([z.string(), z.null()]).optional(),
});

export interface VerifyResult {
  readonly ok: boolean;
  readonly role: "admin" | "limited" | null;
  readonly keyName: string | null;
}

/** Parses `GET /v0/management/auth/verify`, which returns different shapes per role. */
export function toVerifyResult(payload: unknown): VerifyResult {
  const parsed = verifySchema.safeParse(payload);
  if (!parsed.success) return { ok: false, role: null, keyName: null };
  const role =
    parsed.data.role === "admin" || parsed.data.role === "limited" ? parsed.data.role : null;
  return {
    ok: parsed.data.ok === true,
    role,
    keyName: readText(parsed.data.keyName),
  };
}
