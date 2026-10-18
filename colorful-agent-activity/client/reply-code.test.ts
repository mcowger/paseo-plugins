import { describe, expect, it, vi } from "vitest";
import { rule, sunken } from "../shared/color";

// Off-web: react-native itself cannot be loaded under Node (Flow syntax).
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

const { installReplyCodeStyles, replyCodeCss, replyCodeStyleKey } = await import("./web");

const palette = {
  surface0: "#1e2227",
  surface2: "#3e4452",
  border: "#5c6370",
  foreground: "#abb2bf",
  foregroundMuted: "#7f848e",
};

describe("replyCodeCss", () => {
  const css = replyCodeCss(palette);

  it("scopes the inline and block selectors to the assistant message", () => {
    expect(css).toContain('[data-testid="assistant-message"] span[data-paseo-markdown-tag="code"]');
    expect(css).toContain('[data-testid="assistant-message"] [data-paseo-markdown-tag="pre"]');
    for (const line of css.split("\n")) {
      if (line.includes("data-paseo-markdown-tag")) {
        expect(line.startsWith('[data-testid="assistant-message"] ')).toBe(true);
      }
    }
  });

  it("labels the block from the language attribute and guards bare fences", () => {
    expect(css).toContain("content: attr(data-paseo-markdown-language)");
    expect(css).toContain(':not([data-paseo-markdown-language=""])');
  });

  it("derives colors from the palette", () => {
    expect(css).toContain(sunken(palette.surface0));
    expect(css).toContain(rule(palette.border));
    expect(css).toContain(palette.surface2);
    expect(css).toContain(palette.foregroundMuted);
  });

  it("is deterministic for the same palette", () => {
    expect(replyCodeCss(palette)).toBe(css);
  });

  it("gives each palette a stable, distinct key so callers can skip re-installing", () => {
    expect(replyCodeStyleKey(palette)).toBe(replyCodeStyleKey({ ...palette }));
    expect(replyCodeStyleKey(palette)).not.toBe(replyCodeStyleKey({ ...palette, border: "#000000" }));
  });
});

describe("installReplyCodeStyles", () => {
  it("is a no-op off web and returns a function without touching the DOM", () => {
    expect((globalThis as { document?: unknown }).document).toBeUndefined();
    const remove = installReplyCodeStyles(palette);
    expect(typeof remove).toBe("function");
    expect(() => remove()).not.toThrow();
    expect(() => installReplyCodeStyles(null)()).not.toThrow();
  });
});
