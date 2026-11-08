import { describe, expect, it } from "vitest";
import { activitySettings, DEFAULT_EXPANSION, DEFAULT_STRENGTH, EXPANSION_TARGETS, foldFromValues, visibleExpansionTargets } from "./settings";

/**
 * 宿主读写设置时的版本信封检查，照 getpaseo/paseo packages/server/src/server/plugins/settings/index.ts
 * （v0.11.1 起到 v0.15.2 逐字相同）的 read()/write() 判定抄写：存档 `{ version, values }`，版本不等时更新的版本
 * 直接 invalid，更旧的版本没有 migrate 也 invalid；保存时存档版本与定义版本不等一律拒绝。
 * 只调 schema.parse 的测试经不过这一层（0.11.0 曾因此把每位老用户的设置读成 invalid）。
 */
type Definition = { version: number; migrate?: (values: unknown, fromVersion: number) => unknown; schema: { parseAsync: (values: unknown) => Promise<unknown> } };
async function hostRead(definition: Definition, raw: string | null) {
  try {
    const envelope = raw === null ? null : (JSON.parse(raw) as { version: number; values: unknown });
    let values: unknown = envelope?.values ?? {};
    if (envelope && envelope.version !== definition.version) {
      if (envelope.version > definition.version) throw new Error("Settings were saved by a newer plugin version");
      if (!definition.migrate) throw new Error(`Settings version ${envelope.version} requires a migration`);
      values = await definition.migrate(values, envelope.version);
    }
    return { status: "ready" as const, values: (await definition.schema.parseAsync(values)) as Record<string, unknown> };
  } catch (error) {
    return { status: "invalid" as const, error: error instanceof Error ? error.message : String(error) };
  }
}
function hostSaveAllowed(definition: Definition, raw: string | null): boolean {
  return raw === null || (JSON.parse(raw) as { version: number }).version === definition.version;
}

describe("activity settings", () => {
  it("reads settings stored by 0.10.x (envelope version 1) through the host's version check, keeping every value", async () => {
    // 0.10.0 的真实存档形状：信封版本 1，只有当时已有的键。
    const stored = JSON.stringify({ version: 1, values: { takeover: "off", palette: "soft", fold: false, density: "standard", expansion: { shell: "always" }, loader: "orb" } });
    const state = await hostRead(activitySettings, stored);
    expect(state).toMatchObject({ status: "ready" });
    if (state.status !== "ready") return;
    expect(state.values).toMatchObject({ takeover: "off", palette: "soft", fold: false, density: "standard", loader: "orb" });
    expect((state.values.expansion as Record<string, string>).shell).toBe("always");
    // 0.11.0 的新键取默认值。
    expect(state.values).toMatchObject({
      sidebar: true,
      strength: "full",
      commandColors: "expanded",
      thoughtTailFollow: false,
      thoughtTailLines: 20,
      followOutput: { shell: true, logs: true, todo: true, browser: true },
      wrapLines: { diff: false, code: false, output: false },
    });
    // 读到 ready 之后还要能保存（宿主拒绝覆盖不同版本的存档）。
    expect(hostSaveAllowed(activitySettings, stored)).toBe(true);
  });

  it("reads a first run (nothing stored) and older envelopes without a migration", async () => {
    expect(await hostRead(activitySettings, null)).toMatchObject({ status: "ready", values: { takeover: "all" } });
    // 0.3.0 起的存档都是版本 1：更早的形状同样直接解析。
    expect(await hostRead(activitySettings, JSON.stringify({ version: 1, values: { palette: "vivid" } }))).toMatchObject({ status: "ready" });
    // 版本号只有配上 migrate 才能升：两者必须同时出现，否则老存档被宿主判 invalid。
    expect(activitySettings.version === 1 || typeof activitySettings.migrate === "function").toBe(true);
  });

  it("ignores the pre-release diffWrap key; matrices default", () => {
    const parsed = activitySettings.schema.parse({ takeover: "all", diffWrap: "on" });
    expect(parsed.wrapLines).toEqual({ diff: false, code: false, output: false });
    expect(parsed.followOutput).toEqual({ shell: true, logs: true, todo: true, browser: true });
  });

  it("defaults both matrices when nothing is stored", () => {
    const parsed = activitySettings.schema.parse({});
    expect(parsed.followOutput).toEqual({ shell: true, logs: true, todo: true, browser: true });
    expect(parsed.wrapLines).toEqual({ diff: false, code: false, output: false });
  });

  it("backfills expansion defaults and the takeover scope for older stored values", () => {
    const parsed = activitySettings.schema.parse({ palette: "vivid" });
    expect(parsed.expansion).toEqual(DEFAULT_EXPANSION);
    expect(parsed.takeover).toBe("all");
  });

  it("defaults every value when nothing is stored", () => {
    const parsed = activitySettings.schema.parse({});
    expect(parsed.palette).toBe("vivid");
    expect(parsed.takeover).toBe("all");
    expect(parsed.expansion).toEqual(DEFAULT_EXPANSION);
  });

  it("keeps an explicit expansion choice and fills the rest", () => {
    const parsed = activitySettings.schema.parse({ expansion: { shell: "always" } });
    expect(parsed.expansion.shell).toBe("always");
    expect(parsed.expansion.read).toBe("never");
    expect(parsed.expansion.search).toBe("latest");
  });

  it("collapses edit, write and shell rows by default (local default)", () => {
    expect(DEFAULT_EXPANSION.edit).toBe("never");
    expect(DEFAULT_EXPANSION.write).toBe("never");
    expect(DEFAULT_EXPANSION.shell).toBe("never");
    expect(DEFAULT_EXPANSION.read).toBe("never");
    expect(DEFAULT_EXPANSION.thinking).toBe("latest");
  });

  it("covers every target with a default", () => {
    for (const target of EXPANSION_TARGETS) {
      expect(DEFAULT_EXPANSION[target.key]).toBe(target.default);
    }
  });

  it("defaults task-list tool rows to the latest row", () => {
    expect(DEFAULT_EXPANSION.todo).toBe("latest");
    expect(activitySettings.schema.parse({}).expansion.todo).toBe("latest");
  });

  it("lists only the rows the current takeover scope draws", () => {
    const all = visibleExpansionTargets("all").map((target) => target.key);
    expect(all).toContain("shell");
    expect(all).not.toContain("plan");
    expect(visibleExpansionTargets("reasoning").map((target) => target.key)).toEqual(["thinking"]);
    expect(visibleExpansionTargets("off").map((target) => target.key)).toEqual(["thinking"]);
  });

  it("labels every listed target in Chinese", () => {
    for (const target of EXPANSION_TARGETS) expect(target.label).toMatch(/[一-鿿]/);
  });

  it("folds finished runs and uses the compact density by default, also for settings stored before 0.3.0-local.2", () => {
    const stored = activitySettings.schema.parse({ takeover: "reasoning", palette: "soft", expansion: { shell: "always" } });
    expect(stored.fold).toBe(true);
    expect(stored.density).toBe("compact");
    expect(activitySettings.schema.parse({ fold: false, density: "standard" })).toMatchObject({ fold: false, density: "standard" });
    expect(activitySettings.schema.safeParse({ density: "huge" }).success).toBe(false);
  });

  it("hands the folding switch and the scope to the fold runtime", () => {
    expect(foldFromValues({})).toEqual({ enabled: true, scope: "all" });
    expect(foldFromValues({ fold: false, takeover: "reasoning" })).toEqual({ enabled: false, scope: "reasoning" });
    expect(foldFromValues({ fold: "yes" })).toBeNull();
  });

  it("keeps finished rows at full strength by default, also for settings stored before 0.11.0", () => {
    expect(DEFAULT_STRENGTH).toBe("full");
    expect(activitySettings.schema.parse({}).strength).toBe("full");
    expect(activitySettings.schema.parse({ fold: false }).strength).toBe("full");
    expect(activitySettings.schema.parse({ strength: "soft" }).strength).toBe("soft");
    expect(activitySettings.schema.safeParse({ strength: "half" }).success).toBe(false);
  });

  it("keeps long lines scrolling by default; a stored pre-release diffWrap is ignored (no migration)", () => {
    expect(activitySettings.schema.parse({}).wrapLines).toEqual({ diff: false, code: false, output: false });
    expect(activitySettings.schema.parse({ strength: "dim", diffWrap: "on" }).wrapLines).toEqual({ diff: false, code: false, output: false });
  });

  it("colors the row command only while open by default, and accepts always", () => {
    expect(activitySettings.schema.parse({}).commandColors).toBe("expanded");
    expect(activitySettings.schema.parse({ commandColors: "always" }).commandColors).toBe("always");
    expect(activitySettings.schema.safeParse({ commandColors: "never" }).success).toBe(false);
  });

  it("keeps the thought tail window off at 20 lines by default, clamped to 5–500", () => {
    const parsed = activitySettings.schema.parse({});
    expect(parsed.thoughtTailFollow).toBe(false);
    expect(parsed.thoughtTailLines).toBe(20);
    expect(activitySettings.schema.parse({ thoughtTailFollow: true, thoughtTailLines: 5 }).thoughtTailLines).toBe(5);
    expect(activitySettings.schema.parse({ thoughtTailLines: 500 }).thoughtTailLines).toBe(500);
    expect(activitySettings.schema.safeParse({ thoughtTailLines: 4 }).success).toBe(false);
    expect(activitySettings.schema.safeParse({ thoughtTailLines: 501 }).success).toBe(false);
    expect(activitySettings.schema.safeParse({ thoughtTailLines: 20.5 }).success).toBe(false);
  });
});
