// NG item 10: bounded ingress + public-error convention.
//
// Scaled-down port of the paseo-omp `security.ts`/`connection.ts` pattern:
// byte-bounded ingress checks before dispatch, regex-validated identifiers,
// NUL rejection on path-like values, and a `PiPublicError` vs internal error
// convention so unexpected failures surface fixed messages instead of leaking
// subprocess output, credentials, paths, stacks, or `Error.message`.
//
// DIVERGENCE(pi-ingress-budgets): the whole-provider-input envelope is 16 MiB
// so a valid 8 MiB decoded image turn (item 2 aggregate budget, ~10.7 MiB
// base64 plus JSON overhead) fits with headroom; nested persistence, settings,
// MCP, and permission values are capped at 256 KiB like the OMP reference.
// Measured in `bounds.test.ts` ("16 MiB envelope fits an 8 MiB image turn").
// Recorded per NG item 10; do not shrink without re-measuring.

export const MAX_PI_PROVIDER_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_PI_NESTED_VALUE_BYTES = 256 * 1024;
export const MAX_PI_PATH_BYTES = 4096;
export const MAX_PI_BOUND_JSON_DEPTH = 32;
export const MAX_PI_BOUND_JSON_NODES = 100_000;
export const MAX_PI_BOUND_JSON_ITEMS = 1024;

export const PI_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export const PI_PUBLIC_REQUEST_FAILURE_MESSAGE = "Pi provider request failed";
export const PI_PUBLIC_PROMPT_FAILURE_MESSAGE = "Pi prompt failed";

export class PiPublicError extends Error {
  override readonly name = "PiPublicError";
}

export function isPiPublicError(error: unknown): error is PiPublicError {
  return (
    error instanceof PiPublicError ||
    (error instanceof Error && error.name === "PiPublicError")
  );
}

/** Safe message for `request.failed` emissions: public errors keep their message. */
export function toPublicRequestMessage(error: unknown): string {
  return toPublicMessage(error, PI_PUBLIC_REQUEST_FAILURE_MESSAGE);
}

/** Safe message for `session.prompt_result` failure emissions. */
export function toPublicPromptMessage(error: unknown): string {
  return toPublicMessage(error, PI_PUBLIC_PROMPT_FAILURE_MESSAGE);
}

function toPublicMessage(error: unknown, fallback: string): string {
  return isPiPublicError(error) && error.message ? error.message : fallback;
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

interface BoundOverrides {
  maxItems?: number;
  maxStringBytes?: number;
  maxNodes?: number;
  maxDepth?: number;
}

/**
 * Walk `value` without serializing it and return its approximate UTF-8 JSON
 * byte size, or `Number.POSITIVE_INFINITY` when any bound is crossed:
 * over-depth nesting, excessive nodes/items, oversized strings, non-JSON
 * scalars (functions, symbols, bigints, undefined, non-finite numbers), or
 * cumulative bytes beyond `maxBytes`. True cycles terminate via the
 * ancestor chain and report as over-budget, never loop; shared but acyclic
 * references (a DAG, e.g. a host-passed config object referenced twice) are
 * measured each time they occur and are NOT treated as cyclic.
 */
export function boundedJsonBytes(
  value: unknown,
  maxBytes: number,
  overrides: BoundOverrides = {},
): number {
  const maxItems = overrides.maxItems ?? MAX_PI_BOUND_JSON_ITEMS;
  const maxStringBytes = overrides.maxStringBytes ?? maxBytes;
  const maxNodes = overrides.maxNodes ?? MAX_PI_BOUND_JSON_NODES;
  const maxDepth = overrides.maxDepth ?? MAX_PI_BOUND_JSON_DEPTH;
  const state = { nodes: 0, bytes: 0 };
  const ancestors = new Set<object>();
  const ok = walkBoundedJson(value, 0, { maxItems, maxStringBytes, maxNodes, maxDepth }, state, ancestors);
  return ok && state.bytes <= maxBytes ? state.bytes : Number.POSITIVE_INFINITY;
}

interface BoundLimits {
  maxItems: number;
  maxStringBytes: number;
  maxNodes: number;
  maxDepth: number;
}

interface BoundState {
  nodes: number;
  bytes: number;
}

function walkBoundedJson(
  item: unknown,
  depth: number,
  limits: BoundLimits,
  state: BoundState,
  ancestors: Set<object>,
): boolean {
  state.nodes += 1;
  if (state.nodes > limits.maxNodes || depth > limits.maxDepth) return false;
  if (item === null || typeof item === "boolean") {
    state.bytes += item === null ? 4 : 5;
    return true;
  }
  if (typeof item === "number") {
    if (!Number.isFinite(item)) return false;
    state.bytes += utf8Bytes(JSON.stringify(item));
    return true;
  }
  if (typeof item === "string") {
    const itemBytes = utf8Bytes(item);
    if (itemBytes > limits.maxStringBytes) return false;
    state.bytes += itemBytes;
    return true;
  }
  if (typeof item !== "object") return false;
  // Ancestor chain (not a global visited list): a repeat on the current
  // descent path is a true cycle; the same object in two sibling subtrees
  // is a harmless DAG repeat.
  if (ancestors.has(item)) return false;
  if (Array.isArray(item)) {
    if (item.length > limits.maxItems) return false;
    state.bytes += 2;
    ancestors.add(item);
    try {
      for (const child of item) {
        if (!walkBoundedJson(child, depth + 1, limits, state, ancestors)) return false;
      }
    } finally {
      ancestors.delete(item);
    }
    return true;
  }
  state.bytes += 2;
  ancestors.add(item);
  try {
    let itemCount = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      const child = (item as Record<string, unknown>)[key];
      if (child === undefined) continue;
      itemCount += 1;
      if (itemCount > limits.maxItems) return false;
      state.bytes += utf8Bytes(key) + 3;
      if (!walkBoundedJson(child, depth + 1, limits, state, ancestors)) return false;
    }
  } finally {
    ancestors.delete(item);
  }
  return true;
}

/** Throw `PiPublicError` when `value` exceeds `maxBytes` under the bounded walk. */
export function assertBoundedJson(value: unknown, maxBytes: number, label: string): void {
  if (boundedJsonBytes(value, maxBytes) === Number.POSITIVE_INFINITY) {
    throw new PiPublicError(`${label} is too large or not serializable`);
  }
}

// Envelope item cap for whole-provider-input checks: a legitimate prompt
// can carry thousands of small content parts, so the per-level 1024 cap
// does not apply here. Nested depth, node count, and byte budgets still
// hold. Provider dispatch should prefer this over `assertBoundedJson` for
// the outer envelope.
export const MAX_PI_ENVELOPE_JSON_ITEMS = 65536;

/** Envelope variant of `assertBoundedJson` with a raised per-level item cap. */
export function assertBoundedProviderInput(value: unknown, label: string): void {
  if (
    boundedJsonBytes(value, MAX_PI_PROVIDER_INPUT_BYTES, {
      maxItems: MAX_PI_ENVELOPE_JSON_ITEMS,
    }) === Number.POSITIVE_INFINITY
  ) {
    throw new PiPublicError(`${label} is too large or not serializable`);
  }
}

/** Throw `PiPublicError` when `value` is not a safe `label` identifier. */
export function assertPiIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !PI_IDENTIFIER_PATTERN.test(value)) {
    throw new PiPublicError(`${label} is malformed`);
  }
}

/** Throw `PiPublicError` when `value` is not a safe path-like `label`. */
export function assertPiPath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    throw new PiPublicError(`${label} is malformed`);
  }
  if (utf8Bytes(value) > MAX_PI_PATH_BYTES) {
    throw new PiPublicError(`${label} is too large`);
  }
}
