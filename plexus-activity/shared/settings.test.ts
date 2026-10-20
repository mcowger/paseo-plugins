import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, normalizeBaseUrl, resolveConfig } from "./settings";

describe("normalizeBaseUrl", () => {
  it("accepts plain origins and strips trailing slashes", () => {
    expect(normalizeBaseUrl("http://localhost:4000")).toEqual({
      ok: true,
      baseUrl: "http://localhost:4000",
    });
    expect(normalizeBaseUrl("  https://plexus.example.com/ ")).toEqual({
      ok: true,
      baseUrl: "https://plexus.example.com",
    });
  });

  it("keeps a path prefix without its trailing slash", () => {
    expect(normalizeBaseUrl("https://example.com/plexus/")).toEqual({
      ok: true,
      baseUrl: "https://example.com/plexus",
    });
  });

  it("lowercases the scheme", () => {
    expect(normalizeBaseUrl("HTTP://plexus.local:8080")).toEqual({
      ok: true,
      baseUrl: "http://plexus.local:8080",
    });
  });

  it("rejects blank input, non-http schemes, credentials, and query strings", () => {
    expect(normalizeBaseUrl("").ok).toBe(false);
    expect(normalizeBaseUrl("plexus.local:4000").ok).toBe(false);
    expect(normalizeBaseUrl("ftp://plexus.local").ok).toBe(false);
    expect(normalizeBaseUrl("http://user:pass@plexus.local").ok).toBe(false);
    expect(normalizeBaseUrl("http://plexus.local:4000/?x=1").ok).toBe(false);
  });

  it("explains the credential rejection", () => {
    const result = normalizeBaseUrl("http://user:pass@plexus.local");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("admin key field");
  });
});

describe("resolveConfig", () => {
  it("returns the normalised connection settings", () => {
    expect(
      resolveConfig({ baseUrl: "http://localhost:4000/", adminKey: "secret", defaultScope: null }),
    ).toEqual({ ok: true, baseUrl: "http://localhost:4000", adminKey: "secret" });
  });

  it("requires an admin key", () => {
    const result = resolveConfig({ baseUrl: DEFAULT_BASE_URL, adminKey: "", defaultScope: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("admin key");
  });
});
