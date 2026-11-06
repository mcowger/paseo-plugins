import { describe, expect, it } from "vitest";
import { createRevealText, nextRevealCount, safeCut } from "./reveal";

/**
 * Paseo 0.13 dropped `useRevealedText`, so the shipped payload has to pace
 * reasoning text itself when the host has no hook. These cover the pacing math
 * and the host/local choice; the frame loop is a thin wrapper over them.
 */

describe("safeCut", () => {
  it("keeps a surrogate pair whole", () => {
    const text = "a😀b";
    expect(safeCut(text, 2)).toBe(1);
  });

  it("leaves a combining mark with its base", () => {
    expect(safeCut("ae\u0301b", 2)).toBe(1);
  });

  it("leaves a variation selector with its base", () => {
    expect(safeCut("a\u2764\ufe0fb", 2)).toBe(1);
  });

  it("clamps to the text", () => {
    expect(safeCut("abc", 99)).toBe(3);
    expect(safeCut("abc", -1)).toBe(0);
  });
});

describe("nextRevealCount", () => {
  it("shows everything once the block is complete", () => {
    expect(nextRevealCount("hello", 0, "complete")).toBe(5);
    expect(nextRevealCount("hello", 3, "complete")).toBe(5);
  });

  it("advances while streaming and stops at the text length", () => {
    let count = 0;
    for (let frame = 0; frame < 40 && count < 5; frame += 1) {
      const next = nextRevealCount("hello", count, "streaming");
      expect(next).toBeGreaterThan(count);
      expect(next).toBeLessThanOrEqual(5);
      count = next;
    }
    expect(count).toBe(5);
  });

  it("stops revealing once the text is fully shown", () => {
    expect(nextRevealCount("hello", 5, "streaming")).toBe(5);
  });

  it("holds at zero for empty text", () => {
    expect(nextRevealCount("", 0, "streaming")).toBe(0);
  });

  it("never cuts a surrogate pair", () => {
    const text = "a😀😀😀";
    let count = 0;
    for (let frame = 0; frame < 20 && count < text.length; frame += 1) {
      count = nextRevealCount(text, count, "streaming");
      expect(text.slice(0, count)).not.toMatch(/[\uD800-\uDBFF]$/);
    }
  });
});

describe("createRevealText", () => {
  it("uses the host hook when the host still exports one", () => {
    const host = (text: string) => text.toUpperCase();
    expect(createRevealText(host)).toBe(host);
  });

  it("paces locally when the host dropped the hook", () => {
    expect(typeof createRevealText(undefined)).toBe("function");
    expect(typeof createRevealText(null)).toBe("function");
  });
});
