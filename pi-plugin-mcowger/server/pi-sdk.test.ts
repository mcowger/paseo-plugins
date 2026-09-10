import { describe, expect, it } from "vitest";

import { SettingsManager } from "./pi-sdk.js";

describe("vendored Pi SDK", () => {
  it("exports a working SettingsManager", () => {
    expect(typeof SettingsManager.inMemory).toBe("function");
    expect(SettingsManager.inMemory({})).toBeDefined();
  });
});
