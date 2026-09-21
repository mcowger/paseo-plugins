import { expect, test } from "vitest";

import {
  assertBoundedJson,
  assertBoundedProviderInput,
  assertPiIdentifier,
  assertPiPath,
  boundedJsonBytes,
  isPiPublicError,
  MAX_PI_NESTED_VALUE_BYTES,
  MAX_PI_PROVIDER_INPUT_BYTES,
  PI_PUBLIC_PROMPT_FAILURE_MESSAGE,
  PI_PUBLIC_REQUEST_FAILURE_MESSAGE,
  PiPublicError,
  toPublicPromptMessage,
  toPublicRequestMessage,
} from "./bounds.js";

test("accepts well-formed identifiers", () => {
  expect(() => assertPiIdentifier("bridge-session", "session id")).not.toThrow();
  expect(() => assertPiIdentifier("a", "session id")).not.toThrow();
  expect(() => assertPiIdentifier(`x${"y".repeat(255)}`, "session id")).not.toThrow();
  expect(() => assertPiIdentifier("req:1.2_3-4", "request id")).not.toThrow();
});

test("rejects malformed identifiers as public errors", () => {
  for (const value of ["", "-lead", ".lead", "has space", "semi;colon", "a".repeat(258), 42, undefined, null, "nul\u0000"]) {
    try {
      assertPiIdentifier(value, "session id");
      expect.unreachable(`accepted ${JSON.stringify(value)}`);
    } catch (error) {
      expect(isPiPublicError(error)).toBe(true);
    }
  }
  expect(() => assertPiIdentifier("../escape", "session id")).toThrowError(PiPublicError);
});

test("rejects NUL and oversized paths as public errors", () => {
  expect(() => assertPiPath("/workspace", "cwd")).not.toThrow();
  expect(() => assertPiPath("rel/path", "cwd")).not.toThrow();
  expect(() => assertPiPath("/a\u0000b", "cwd")).toThrowError(PiPublicError);
  expect(() => assertPiPath("", "cwd")).toThrowError(PiPublicError);
  expect(() => assertPiPath(`/${"a".repeat(4096)}`, "cwd")).toThrowError(PiPublicError);
});

test("rejects over-depth, excessive-node, and cyclic structures without serializing", () => {
  let deep: unknown = "leaf";
  for (let index = 0; index < 40; index += 1) deep = { next: deep };
  expect(boundedJsonBytes(deep, MAX_PI_PROVIDER_INPUT_BYTES)).toBe(Number.POSITIVE_INFINITY);

  const wide = { items: Array.from({ length: 2000 }, (_, index) => index) };
  expect(
    boundedJsonBytes(wide, MAX_PI_PROVIDER_INPUT_BYTES, { maxItems: 128 }),
  ).toBe(Number.POSITIVE_INFINITY);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(boundedJsonBytes(cyclic, MAX_PI_PROVIDER_INPUT_BYTES)).toBe(Number.POSITIVE_INFINITY);

  expect(boundedJsonBytes({ fn: () => undefined }, MAX_PI_PROVIDER_INPUT_BYTES)).toBe(
    Number.POSITIVE_INFINITY,
  );
  expect(boundedJsonBytes({ nan: Number.NaN }, MAX_PI_PROVIDER_INPUT_BYTES)).toBe(
    Number.POSITIVE_INFINITY,
  );
});

test("rejects oversized nested values at the 256 KiB boundary", () => {
  expect(boundedJsonBytes({ v: "x".repeat(1024) }, MAX_PI_NESTED_VALUE_BYTES)).toBeLessThan(
    MAX_PI_NESTED_VALUE_BYTES,
  );
  expect(
    boundedJsonBytes({ v: "x".repeat(MAX_PI_NESTED_VALUE_BYTES) }, MAX_PI_NESTED_VALUE_BYTES),
  ).toBe(Number.POSITIVE_INFINITY);
  expect(() =>
    assertBoundedJson({ v: "x".repeat(MAX_PI_NESTED_VALUE_BYTES) }, MAX_PI_NESTED_VALUE_BYTES, "Session persistence input"),
  ).toThrowError(PiPublicError);
});

test("16 MiB envelope fits an 8 MiB decoded image turn after base64 overhead", () => {
  // Decision guard (NG item 10): worst-case item-2 turn is four 2 MiB images.
  // Base64 inflates 8 MiB to ~10.7 MiB; the 16 MiB envelope must hold it.
  const imageData = Buffer.alloc(2 * 1024 * 1024, 7).toString("base64");
  const input = {
    type: "session.prompt",
    sessionId: "bridge-session",
    prompt: {
      clientMessageId: "client-1",
      input: {
        type: "message",
        content: [
          { type: "text", text: "describe these" },
          ...[0, 1, 2, 3].map(() => ({ type: "image", data: imageData, mimeType: "image/png" })),
        ],
      },
    },
  };
  const measured = boundedJsonBytes(input, MAX_PI_PROVIDER_INPUT_BYTES);
  expect(measured).toBeLessThan(MAX_PI_PROVIDER_INPUT_BYTES);
  expect(measured).toBeGreaterThan(8 * 1024 * 1024);
});

test("accepts shared acyclic references while rejecting true cycles", () => {
  const shared = { block: "text", nested: { n: 1 } };
  const dag = { first: shared, second: [shared, shared] };
  expect(boundedJsonBytes(dag, MAX_PI_PROVIDER_INPUT_BYTES)).toBeLessThan(
    MAX_PI_PROVIDER_INPUT_BYTES,
  );

  const cyclic: Record<string, unknown> = { other: shared };
  cyclic.self = cyclic;
  expect(boundedJsonBytes(cyclic, MAX_PI_PROVIDER_INPUT_BYTES)).toBe(
    Number.POSITIVE_INFINITY,
  );

  // Indirect cycles (a -> b -> a) also terminate.
  const a: Record<string, unknown> = {};
  const b: Record<string, unknown> = { parent: a };
  a.child = b;
  expect(boundedJsonBytes(a, MAX_PI_PROVIDER_INPUT_BYTES)).toBe(Number.POSITIVE_INFINITY);
});

test("envelope helper allows long small-item arrays the nested cap rejects", () => {
  const input = { content: Array.from({ length: 5000 }, (_, index) => ({ n: index })) };
  expect(boundedJsonBytes(input, MAX_PI_PROVIDER_INPUT_BYTES)).toBe(Number.POSITIVE_INFINITY);
  expect(() => assertBoundedProviderInput(input, "Provider input")).not.toThrow();
});

test("public errors keep safe messages while internals map to fixed messages", () => {
  const leak = new Error("spawn pi ENOENT /secret/path/sk-abc123\n    at stack");
  expect(toPublicRequestMessage(leak)).toBe(PI_PUBLIC_REQUEST_FAILURE_MESSAGE);
  expect(toPublicPromptMessage(leak)).toBe(PI_PUBLIC_PROMPT_FAILURE_MESSAGE);
  expect(toPublicRequestMessage("plain string")).toBe(PI_PUBLIC_REQUEST_FAILURE_MESSAGE);

  const publik = new PiPublicError("Session persistence input is too large");
  expect(toPublicRequestMessage(publik)).toBe("Session persistence input is too large");
  expect(toPublicPromptMessage(publik)).toBe("Session persistence input is too large");
  expect(isPiPublicError(publik)).toBe(true);
  expect(isPiPublicError(new Error("other"))).toBe(false);
});
