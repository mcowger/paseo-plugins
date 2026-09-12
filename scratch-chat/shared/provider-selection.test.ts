import { describe, expect, it } from "vitest";
import { selectProviderModel } from "./provider-selection.js";

describe("selectProviderModel", () => {
  it("prefers the first selectable default model", () => {
    expect(
      selectProviderModel([
        {
          provider: "first",
          models: [{ id: "one" }],
        },
        {
          provider: "second",
          models: [{ id: "two", isDefault: true }],
        },
      ]),
    ).toBe("first/one");
  });

  it("skips disabled providers and unavailable models", () => {
    expect(
      selectProviderModel([
        {
          provider: "disabled",
          enabled: false,
          models: [{ id: "one" }],
        },
        {
          provider: "available",
          models: [{ id: "two", isSelectable: false }],
        },
      ]),
    ).toBeNull();
  });
});
