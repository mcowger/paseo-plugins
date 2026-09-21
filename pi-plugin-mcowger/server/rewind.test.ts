import { expect, test } from "vitest";

import {
  PI_REVERT_TOKEN_RE,
  PiRevertTokens,
  isRevertToken,
  mintRevertToken,
  parseCapturedEntries,
  parseExtensionMarkerPayload,
  revertPiConversation,
} from "./rewind.js";

test("mints opaque tokens matching the validated shape", () => {
  const token = mintRevertToken();
  expect(token).toMatch(PI_REVERT_TOKEN_RE);
  expect(token.startsWith("pi-revert:")).toBe(true);
  expect(token.slice("pi-revert:".length)).toHaveLength(43);
  expect(mintRevertToken()).not.toBe(token);
});

test("rejects malformed and forged tokens", () => {
  expect(isRevertToken("pi-revert:short")).toBe(false);
  expect(isRevertToken("entry-1-revert:abc")).toBe(false);
  expect(isRevertToken("")).toBe(false);
  expect(isRevertToken(undefined)).toBe(false);
  expect(isRevertToken(42)).toBe(false);
  expect(isRevertToken(` ${mintRevertToken()}`)).toBe(false);
  expect(isRevertToken(`${mintRevertToken()} `)).toBe(false);
  expect(isRevertToken(mintRevertToken())).toBe(true);
});

test("maps tokens to entry ids with a bounded store", () => {
  const tokens = new PiRevertTokens();
  const first = tokens.mint("entry-1");
  expect(tokens.resolve(first)).toBe("entry-1");
  expect(tokens.resolve(mintRevertToken())).toBeUndefined();
  for (let index = 0; index < 250; index += 1) {
    tokens.mint(`entry-x-${index}`);
  }
  expect(tokens.size).toBeLessThanOrEqual(200);
  expect(tokens.resolve(first)).toBeUndefined();
  tokens.clear();
  expect(tokens.size).toBe(0);
});

test("revertPiConversation delegates the resolved entry id", async () => {
  const seen: string[] = [];
  await revertPiConversation({
    entryId: "  entry-7  ",
    navigator: { navigateTree: async (targetId) => { seen.push(targetId); } },
  });
  expect(seen).toEqual(["entry-7"]);
  await expect(
    revertPiConversation({ entryId: "   ", navigator: { navigateTree: async () => {} } }),
  ).rejects.toThrow("Pi rewind requires a user message id");
});

test("parses captured entries defensively", () => {
  expect(parseCapturedEntries("nope")).toEqual([]);
  expect(
    parseCapturedEntries([
      { id: "a", parentId: null, text: "hello" },
      { id: "b", parentId: "a", text: "world" },
      { id: "", text: "blank" },
      { id: "c" },
      42,
    ]),
  ).toEqual([
    { id: "a", parentId: null, text: "hello" },
    { id: "b", parentId: "a", text: "world" },
  ]);
});

test("parses marker payloads only on exact prefix", () => {
  expect(parseExtensionMarkerPayload("PASEO_ENTRY_CAPTURE {\"a\":1}", "PASEO_ENTRY_CAPTURE")).toEqual({ a: 1 });
  expect(parseExtensionMarkerPayload("PASEO_ENTRY_CAPTURE not-json", "PASEO_ENTRY_CAPTURE")).toBeNull();
  expect(parseExtensionMarkerPayload("PASEO_ENTRY_CAPTURE [1]", "PASEO_ENTRY_CAPTURE")).toBeNull();
  expect(parseExtensionMarkerPayload("other marker", "PASEO_ENTRY_CAPTURE")).toBeNull();
});

test("re-minting a known entry id is idempotent", () => {
  const tokens = new PiRevertTokens();
  const first = tokens.mint("entry-1");
  expect(tokens.mint("entry-1")).toBe(first);
  expect(tokens.size).toBe(1);
  expect(tokens.resolve(first)).toBe("entry-1");
});

test("the fifo cap bounds distinct entries across replays", () => {
  const tokens = new PiRevertTokens();
  const seen = new Set<string>();
  for (let round = 0; round < 3; round += 1) {
    for (let index = 0; index < 150; index += 1) {
      seen.add(tokens.mint(`entry-${index}`));
    }
  }
  // Re-mints are idempotent, so three full replays still hold one token per
  // distinct entry instead of evicting everything before the cap.
  expect(tokens.size).toBe(150);
  expect(seen.size).toBe(150);
  for (let index = 150; index < 400; index += 1) {
    tokens.mint(`entry-${index}`);
  }
  expect(tokens.size).toBeLessThanOrEqual(200);
});
