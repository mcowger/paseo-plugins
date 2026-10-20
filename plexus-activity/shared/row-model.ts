import { isPendingStatus } from "./format";
import type { UsageRow } from "./view";

/**
 * Server-side record folding for Plexus usage events.
 *
 * The SSE stream is deliberately uneven: `started` is a partial record, `updated` carries only the
 * fields that changed, and `completed` is a full record. Folding is therefore a per-field merge where
 * an explicit value (including `null`) wins and `undefined` means "unchanged".
 */

export interface NormalizedRecord {
  requestId: string;
  startTime: number;
  date: string | null;
  responseStatus: string | null;
  apiKey: string | null;
  incomingApiType: string | null;
  outgoingApiType: string | null;
  isStreamed: boolean;
  isRaw: boolean;
  isPassthrough: boolean;
  isVisionFallthrough: boolean;
  incomingModelAlias: string | null;
  selectedModelName: string | null;
  finalAttemptModel: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  requestedServiceTier: string | null;
  tokensInput: number | null;
  tokensCached: number | null;
  tokensCacheWrite: number | null;
  tokensOutput: number | null;
  tokensReasoning: number | null;
  tokensEstimated: boolean;
  costTotal: number | null;
  durationMs: number | null;
  ttftMs: number | null;
  tokensPerSec: number | null;
}

export type RecordPatch = Partial<NormalizedRecord> & { requestId: string };

export function createEmptyRecord(requestId: string, startTime: number): NormalizedRecord {
  return {
    requestId,
    startTime,
    date: null,
    responseStatus: null,
    apiKey: null,
    incomingApiType: null,
    outgoingApiType: null,
    isStreamed: false,
    isRaw: false,
    isPassthrough: false,
    isVisionFallthrough: false,
    incomingModelAlias: null,
    selectedModelName: null,
    finalAttemptModel: null,
    reasoningEffort: null,
    serviceTier: null,
    requestedServiceTier: null,
    tokensInput: null,
    tokensCached: null,
    tokensCacheWrite: null,
    tokensOutput: null,
    tokensReasoning: null,
    tokensEstimated: false,
    costTotal: null,
    durationMs: null,
    ttftMs: null,
    tokensPerSec: null,
  };
}

const MERGE_KEYS = [
  "startTime",
  "date",
  "responseStatus",
  "apiKey",
  "incomingApiType",
  "outgoingApiType",
  "isStreamed",
  "isRaw",
  "isPassthrough",
  "isVisionFallthrough",
  "incomingModelAlias",
  "selectedModelName",
  "finalAttemptModel",
  "reasoningEffort",
  "serviceTier",
  "requestedServiceTier",
  "tokensInput",
  "tokensCached",
  "tokensCacheWrite",
  "tokensOutput",
  "tokensReasoning",
  "tokensEstimated",
  "costTotal",
  "durationMs",
  "ttftMs",
  "tokensPerSec",
] as const satisfies readonly (keyof NormalizedRecord)[];

/** Field-wise merge; explicit `null` is a value, `undefined` means "unchanged". */
export function mergeRecord(base: NormalizedRecord, patch: RecordPatch): NormalizedRecord {
  const merged: NormalizedRecord = { ...base, requestId: base.requestId };
  for (const key of MERGE_KEYS) {
    const incoming = patch[key];
    if (incoming !== undefined) {
      // Safe: each key keeps its own type through the MERGE_KEYS union.
      (merged as unknown as Record<string, unknown>)[key] = incoming;
    }
  }
  return merged;
}

/** A request is in flight while Plexus reports it as pending (its `durationMs` is still null). */
export function isInFlight(record: NormalizedRecord): boolean {
  return isPendingStatus(record.responseStatus);
}

export function matchesScope(record: NormalizedRecord, scope: string | null): boolean {
  if (scope === null) return true;
  return record.apiKey === scope;
}

export function compareNewestFirst(
  left: { startTime: number; requestId: string; date?: string | null },
  right: { startTime: number; requestId: string; date?: string | null },
): number {
  if (left.startTime !== right.startTime) return right.startTime - left.startTime;
  const leftDate = left.date ?? "";
  const rightDate = right.date ?? "";
  if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
  return right.requestId.localeCompare(left.requestId);
}

/** Projection to the wire view model. `liveTokensPerSec` comes from the latest progress event. */
export function toUsageRow(
  record: NormalizedRecord,
  updatedSeq: number,
  liveTokensPerSec: number | null,
): UsageRow {
  return {
    requestId: record.requestId,
    startTime: record.startTime,
    status: record.responseStatus,
    incomingApiType: record.incomingApiType,
    outgoingApiType: record.outgoingApiType,
    isStreamed: record.isStreamed,
    isRaw: record.isRaw,
    isPassthrough: record.isPassthrough,
    isVisionFallthrough: record.isVisionFallthrough,
    modelSlug: record.finalAttemptModel ?? record.selectedModelName,
    reasoningEffort: record.reasoningEffort,
    serviceTier: record.serviceTier,
    requestedServiceTier: record.requestedServiceTier,
    tokens: {
      input: record.tokensInput,
      cached: record.tokensCached,
      cacheWrite: record.tokensCacheWrite,
      output: record.tokensOutput,
      reasoning: record.tokensReasoning,
      estimated: record.tokensEstimated,
    },
    costTotal: record.costTotal,
    durationMs: record.durationMs,
    ttftMs: record.ttftMs,
    tokensPerSec: record.tokensPerSec,
    liveTokensPerSec,
    updatedSeq,
  };
}
