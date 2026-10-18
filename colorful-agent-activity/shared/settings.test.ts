import { describe, expect, it } from "vitest";
import { activitySettings, DEFAULT_EXPANSION, EXPANSION_TARGETS } from "./settings";

describe("activity settings", () => {
  it("stays on schema version 4 with a migration for older stored values", () => {
    expect(activitySettings.version).toBe(4);
    expect(activitySettings.migrate?.({ palette: "soft" }, 1)).toEqual({ palette: "soft" });
    expect(activitySettings.migrate?.({ palette: "soft" }, 2)).toEqual({ palette: "soft" });
  });

  it("backfills expansion defaults for legacy stored values", () => {
    const parsed = activitySettings.schema.parse({ palette: "vivid" });
    expect(parsed.expansion).toEqual(DEFAULT_EXPANSION);
  });

  it("defaults every value when nothing is stored", () => {
    const parsed = activitySettings.schema.parse({});
    expect(parsed.palette).toBe("vivid");
    expect(parsed.expansion).toEqual(DEFAULT_EXPANSION);
    expect(parsed.quiet).toBe("faded");
    expect(parsed.commandColor).toBe("expanded");
    expect(parsed.codeChrome).toBe("header");
    expect(parsed.diffWrap).toBe("off");
    expect(parsed.replyCode).toBe("on");
    expect(parsed.blockHeights).toEqual({
      thinking: 420,
      read: 420,
      shell: 320,
      write: 420,
      edit: 520,
    });
  });

  it("accepts a zero line limit, and rejects a negative or fractional one", () => {
    expect(
      activitySettings.schema.parse({ blockHeights: { thinking: 0 } }).blockHeights,
    ).toEqual({ thinking: 0, read: 420, shell: 320, write: 420, edit: 520 });
    expect(
      activitySettings.schema.safeParse({ blockHeights: { thinking: -1 } }).success,
    ).toBe(false);
    expect(
      activitySettings.schema.safeParse({ blockHeights: { shell: 1.5 } }).success,
    ).toBe(false);
    // Values from before the switch to heights are dropped, not carried along.
    const migrated = activitySettings.schema.parse({ previewLines: 20, thinkingLines: 400 });
    expect(migrated.blockHeights.thinking).toBe(420);
  });

  it("fills presentation defaults for a version 1 payload", () => {
    const parsed = activitySettings.schema.parse(
      activitySettings.migrate?.({ palette: "high_contrast", expansion: { shell: "never" } }, 1),
    );
    expect(parsed.palette).toBe("high_contrast");
    expect(parsed.expansion.shell).toBe("never");
    expect(parsed.quiet).toBe("faded");
    expect(parsed.commandColor).toBe("expanded");
  });

  it("rejects unknown enum values instead of guessing", () => {
    expect(activitySettings.schema.safeParse({ quiet: "invisible" }).success).toBe(false);
    expect(activitySettings.schema.safeParse({ commandColor: "sometimes" }).success).toBe(false);
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

  it("defaults task updates to the latest row", () => {
    expect(DEFAULT_EXPANSION.todo).toBe("latest");
    expect(activitySettings.schema.parse({}).expansion.todo).toBe("latest");
  });
});
