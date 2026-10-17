import { describe, expect, it } from "vitest";
import { tierSettingPresentation } from "./tiers.js";

describe("tierSettingPresentation", () => {
  it.each(["default", "auto", "standard"])("shows selected %s as default", (selected) => {
    expect(
      tierSettingPresentation(["default", "auto", "standard", "flex", "priority"], selected),
    ).toEqual({
      value: "default",
      options: [
        { label: "default", value: "default" },
        { label: "flex", value: "flex" },
        { label: "priority", value: "priority" },
      ],
    });
  });

  it.each([["auto"], ["standard"], ["default"], ["standard", "auto"], ["auto", "standard"]])(
    "groups advertised aliases %j without requiring all three",
    (...choices) => {
      const first = choices[0];
      if (first === undefined) throw new Error("expected at least one choice");
      expect(tierSettingPresentation(choices, first)).toEqual({
        value: "default",
        options: [{ label: "default", value: "default" }],
      });
    },
  );

  it("preserves the first group's position and other advertised tier names", () => {
    expect(
      tierSettingPresentation(
        ["flex", "standard", "priority", "auto", "ultrafast", "custom"],
        "custom",
      ),
    ).toEqual({
      value: "custom",
      options: ["flex", "default", "priority", "ultrafast", "custom"].map((value) => ({
        label: value,
        value,
      })),
    });
  });

  it("does not manufacture a default option or select a premium tier", () => {
    expect(tierSettingPresentation(["priority", "flex"], "default")).toEqual({
      value: null,
      options: [
        { label: "priority", value: "priority" },
        { label: "flex", value: "flex" },
      ],
    });
    expect(tierSettingPresentation([], "default")).toEqual({ value: null, options: [] });
  });

  it("leaves unsupported selections unselected", () => {
    expect(tierSettingPresentation(["auto", "priority"], "removed").value).toBeNull();
    expect(tierSettingPresentation(["auto", "priority"], "standard").value).toBeNull();
  });
});
