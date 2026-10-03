import { describe, expect, it } from "vitest";
import {
  ConfigureDataSchema,
  decodeBase64Url,
  encodeBase64Url,
  encodeRequest,
  formatIssues,
  parseRequestArg,
  PROTOCOL_VERSION,
  SuperpiRequestSchema,
  SuperpiStateSchema,
} from "../src/protocol.ts";

const validRequest = {
  version: 1,
  sessionKey: "key-1",
  requestId: "req-1",
  operation: "hello",
} as const;

describe("base64url codec", () => {
  it("round-trips unicode JSON", () => {
    const json = JSON.stringify({ text: "héllo — superpi" });
    expect(decodeBase64Url(encodeBase64Url(json))).toBe(json);
  });
});

describe("parseRequestArg", () => {
  it("parses a valid encoded request", () => {
    const result = parseRequestArg(encodeRequest(validRequest));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toEqual(validRequest);
  });

  it("rejects empty input", () => {
    const result = parseRequestArg("   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("missing");
  });

  it("rejects payloads that are not JSON", () => {
    const result = parseRequestArg(encodeBase64Url("not json"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("JSON");
  });

  it("rejects a wrong protocol version and preserves correlation fields", () => {
    const result = parseRequestArg(
      encodeBase64Url(JSON.stringify({ ...validRequest, version: PROTOCOL_VERSION + 1 })),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("invalid request");
    expect(result.sessionKey).toBe("key-1");
    expect(result.requestId).toBe("req-1");
    expect(result.operation).toBe("hello");
  });

  it("rejects an unknown operation", () => {
    expect(SuperpiRequestSchema.safeParse({ ...validRequest, operation: "explode" }).success).toBe(false);
  });
});

describe("ConfigureDataSchema", () => {
  it("accepts partial tier/context updates", () => {
    expect(ConfigureDataSchema.safeParse({ tier: "fast" }).success).toBe(true);
    expect(ConfigureDataSchema.safeParse({ longContext: true }).success).toBe(true);
    expect(ConfigureDataSchema.safeParse({}).success).toBe(true);
  });

  it("rejects unknown keys and bad values", () => {
    expect(ConfigureDataSchema.safeParse({ tier: "turbo" }).success).toBe(true);
    expect(ConfigureDataSchema.safeParse({ tier: "" }).success).toBe(false);
    expect(ConfigureDataSchema.safeParse({ longContext: "yes" }).success).toBe(false);
    expect(ConfigureDataSchema.safeParse({ extra: true }).success).toBe(false);
  });
});

describe("formatIssues", () => {
  it("includes the path of failing fields", () => {
    const parsed = ConfigureDataSchema.safeParse({ tier: "" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(formatIssues(parsed.error)).toContain("tier");
  });
});

describe("SuperpiStateSchema", () => {
  const state = {
    capabilities: ["hello"],
    settings: { tier: "default", longContext: false },
    origin: "root",
    tiers: ["default", "fast", "flex", "ultrafast"],
    tierApplicable: true,
    conflicts: [],
    limitations: [],
  } as const;

  it("accepts the exact state shape", () => {
    expect(SuperpiStateSchema.safeParse(state).success).toBe(true);
  });

  it("rejects undeclared state keys", () => {
    expect(SuperpiStateSchema.safeParse({ ...state, surprise: true }).success).toBe(false);
  });
});
