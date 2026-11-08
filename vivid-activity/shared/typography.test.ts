import { describe, expect, it } from "vitest";
import { activitySettings } from "./settings";
import { DEFAULT_TYPOGRAPHY, monoFontStack, typeset, typesetStyle, typography } from "./typography";

describe("monoFontStack", () => {
  it("quotes font names and keeps generic keywords", () => {
    expect(monoFontStack("")).toBe("");
    expect(monoFontStack("   ")).toBe("");
    expect(monoFontStack('"JetBrains Mono", monospace')).toBe('"JetBrains Mono", monospace');
    expect(monoFontStack("Iosevka Term,  Fira  Code , UI-Monospace")).toBe('"Iosevka Term", "Fira Code", ui-monospace');
    expect(monoFontStack("'Sarasa Mono SC'")).toBe('"Sarasa Mono SC"');
    expect(monoFontStack("更纱黑体 Mono SC Nerd-Font_2.1+")).toBe('"更纱黑体 Mono SC Nerd-Font_2.1+"');
  });

  it("refuses anything that could leave the font-family value", () => {
    for (const value of [
      "Mono; } body { display: none",
      'a"b',
      "Mono}",
      "Mono</style>",
      "url(x)",
      "Mono\\61",
      "Mono, , monospace",
      '"Mono',
      "Mono\nmonospace",
      "a".repeat(201),
    ]) expect(monoFontStack(value), value).toBeNull();
  });
});

describe("typeset", () => {
  const styles = {
    summary: { color: "#888", fontFamily: "monospace", fontSize: 12, lineHeight: 17 },
    title: { color: "#fff", fontSize: 13, lineHeight: 18 },
    frame: { padding: 4 },
  };

  it("leaves the styles alone at the defaults", () => {
    expect(typography("standard", "standard")).toBe(DEFAULT_TYPOGRAPHY);
    expect(typeset(styles, DEFAULT_TYPOGRAPHY)).toBe(styles);
    expect(typesetStyle(styles.summary, DEFAULT_TYPOGRAPHY)).toBe(styles.summary);
  });

  it("changes only monospace text", () => {
    const type = typography("large", "relaxed", '"JetBrains Mono", ui-monospace, monospace');
    expect(typography("large", "relaxed", '"JetBrains Mono", ui-monospace, monospace')).toBe(type);
    const out = typeset(styles, type);
    expect(out.summary).toEqual({ color: "#888", fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 14, lineHeight: 25 });
    expect(out.title).toBe(styles.title);
    expect(out.frame).toBe(styles.frame);
    expect(styles.summary.fontSize).toBe(12);
  });

  it("scales size and line height without a family (native)", () => {
    expect(typesetStyle(styles.summary, typography("small", "compact"))).toEqual({ color: "#888", fontFamily: "monospace", fontSize: 11, lineHeight: 14 });
    expect(typesetStyle(styles.summary, typography("larger", "standard"))).toEqual({ color: "#888", fontFamily: "monospace", fontSize: 16, lineHeight: 23 });
  });
});

describe("display settings", () => {
  it("reads old settings with the default code font", () => {
    const values = activitySettings.schema.parse({ palette: "soft" });
    expect(values).toMatchObject({ monoFont: "", textSize: "standard", lineSpacing: "standard" });
  });

  it("rejects unknown sizes and over-long font lists", () => {
    expect(activitySettings.schema.safeParse({ textSize: "huge" }).success).toBe(false);
    expect(activitySettings.schema.safeParse({ lineSpacing: "double" }).success).toBe(false);
    expect(activitySettings.schema.safeParse({ monoFont: "a".repeat(201) }).success).toBe(false);
  });
});
