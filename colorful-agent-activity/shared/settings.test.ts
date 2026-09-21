import { describe, expect, it } from "vitest";
import { activitySettings, DEFAULT_EXPANSION, EXPANSION_TARGETS } from "./settings";

describe("activity settings", () => {
  it("stays on version 1 so stored settings need no migration", () => {
    expect(activitySettings.version).toBe(1);
  });

  it("backfills expansion defaults for legacy stored values", () => {
    const parsed = activitySettings.schema.parse({ palette: "vivid" });
    expect(parsed.expansion).toEqual(DEFAULT_EXPANSION);
  });

  it("defaults every value when nothing is stored", () => {
    const parsed = activitySettings.schema.parse({});
    expect(parsed.palette).toBe("vivid");
    expect(parsed.expansion).toEqual(DEFAULT_EXPANSION);
  });

  it("keeps an explicit expansion choice and fills the rest", () => {
    const parsed = activitySettings.schema.parse({ expansion: { shell: "never" } });
    expect(parsed.expansion.shell).toBe("never");
    expect(parsed.expansion.read).toBe("never");
    expect(parsed.expansion.edit).toBe("latest");
  });

  it("covers every target with a default", () => {
    for (const target of EXPANSION_TARGETS) {
      expect(DEFAULT_EXPANSION[target.key]).toBe(target.default);
    }
  });
});
