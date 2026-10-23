import { describe, expect, it } from "vitest";
import { pickHostMarkdown } from "./host-markdown";

/**
 * 0.13 added `Markdown` to the plugin UI entry; 0.12 and earlier have no such
 * export. The selector is the whole guard, so keep it covered.
 */

describe("pickHostMarkdown", () => {
  it("uses the host renderer when the host exposes one", () => {
    const Markdown = () => null;
    expect(pickHostMarkdown(Markdown)).toBe(Markdown);
  });

  it("returns null when the host has no renderer", () => {
    expect(pickHostMarkdown(undefined)).toBeNull();
    expect(pickHostMarkdown(null)).toBeNull();
    expect(pickHostMarkdown({})).toBeNull();
    expect(pickHostMarkdown("Markdown")).toBeNull();
  });
});
