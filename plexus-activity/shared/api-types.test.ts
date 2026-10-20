import { describe, expect, it } from "vitest";
import {
  estimateTokensPerSec,
  formatApiTransition,
  formatApiType,
  getApiBaseType,
  getEstimatedBytesPerToken,
} from "./api-types";

describe("getApiBaseType", () => {
  it("strips qualifiers and normalizes case", () => {
    expect(getApiBaseType("Chat")).toBe("chat");
    expect(getApiBaseType("openai-responses:stream")).toBe("openai-responses");
    expect(getApiBaseType(null)).toBe("");
    expect(getApiBaseType("   ")).toBe("");
  });
});

describe("formatApiType", () => {
  it("drops vendor prefixes that do not change the protocol family", () => {
    expect(formatApiType("anthropic-messages")).toBe("messages");
    expect(formatApiType("openai-completions")).toBe("completions");
    expect(formatApiType("google-generative-ai")).toBe("gemini");
  });

  it("passes through short protocol names", () => {
    expect(formatApiType("chat")).toBe("chat");
    expect(formatApiType("messages")).toBe("messages");
    expect(formatApiType("oauth")).toBe("oauth");
    expect(formatApiType("systemone")).toBe("systemone");
  });

  it("renders a dash when missing", () => {
    expect(formatApiType(null)).toBe("-");
  });
});

describe("formatApiTransition", () => {
  it("collapses identical protocols", () => {
    expect(formatApiTransition("chat", "openai-chat")).toBe("chat");
    expect(formatApiTransition("messages", "anthropic-messages")).toBe("messages");
  });

  it("shows a translation between protocols", () => {
    expect(formatApiTransition("chat", "anthropic-messages")).toBe("chat→messages");
    expect(formatApiTransition("responses", "openai-completions")).toBe("responses→completions");
  });

  it("survives a missing side", () => {
    expect(formatApiTransition("chat", null)).toBe("chat");
    expect(formatApiTransition(null, "chat")).toBe("chat");
    expect(formatApiTransition(null, null)).toBe("-");
  });
});

describe("getEstimatedBytesPerToken", () => {
  it("matches the Plexus heuristics for streamed protocols", () => {
    expect(getEstimatedBytesPerToken({ incomingApiType: "messages", isStreamed: true })).toBe(140);
    expect(getEstimatedBytesPerToken({ incomingApiType: "chat", isStreamed: true })).toBe(215);
    expect(getEstimatedBytesPerToken({ incomingApiType: "responses", isStreamed: true })).toBe(200);
    expect(getEstimatedBytesPerToken({ incomingApiType: "gemini", isStreamed: true })).toBe(140);
    expect(getEstimatedBytesPerToken({ incomingApiType: "raw", isStreamed: true })).toBe(140);
    expect(
      getEstimatedBytesPerToken({ outgoingApiType: "anthropic-messages", isStreamed: true }),
    ).toBe(140);
  });

  it("uses the bulk-response factor for non-streamed requests", () => {
    expect(getEstimatedBytesPerToken({ incomingApiType: "chat", isStreamed: false })).toBe(4.5);
  });
});

describe("estimateTokensPerSec", () => {
  it("divides the semantic byte rate by the per-protocol factor", () => {
    expect(
      estimateTokensPerSec(
        { semanticBytesPerSec: 21_500, elapsedMs: 1000, isStreamed: true },
        { incomingApiType: "chat" },
      ),
    ).toBe(100);
  });

  it("falls back to received bytes over elapsed time", () => {
    expect(
      estimateTokensPerSec(
        { semanticBytesReceived: 14_000, elapsedMs: 2000, isStreamed: true },
        { incomingApiType: "messages" },
      ),
    ).toBeCloseTo(50, 5);
  });

  it("returns null without usable byte data", () => {
    expect(estimateTokensPerSec({}, { incomingApiType: "chat" })).toBeNull();
    expect(
      estimateTokensPerSec({ semanticBytesPerSec: 0, elapsedMs: 0 }, { incomingApiType: "chat" }),
    ).toBeNull();
  });
});
