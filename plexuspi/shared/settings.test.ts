import { describe, expect, it } from "vitest";
import { plexuspiSettings, resolveModelNameStyle } from "./settings.js";

describe("plexuspi host settings", () => {
  it("defaults to full model names", () => {
    expect(plexuspiSettings.schema.parse({}).modelNameStyle).toBe("full");
  });

  it("accepts the short model name style", () => {
    expect(plexuspiSettings.schema.parse({ modelNameStyle: "short" }).modelNameStyle).toBe("short");
  });

  it("rejects unknown model name styles", () => {
    expect(() => plexuspiSettings.schema.parse({ modelNameStyle: "tiny" })).toThrow();
  });

  it("falls back to full names for unknown stored values", () => {
    expect(resolveModelNameStyle("short")).toBe("short");
    expect(resolveModelNameStyle("full")).toBe("full");
    for (const value of [undefined, null, "", "tiny", 42, {}]) {
      expect(resolveModelNameStyle(value)).toBe("full");
    }
  });
});
