import { describe, expect, it } from "vitest";
import { mapPiModels } from "./session.js";

const models = [
  { provider: "plexus", id: "luna", name: "Plexus Luna Extra Long Name", plexusShortName: "Luna" },
  { provider: "plexus", id: "plain", name: "Plexus Plain Name" },
];

describe("mapPiModels model name style", () => {
  it("labels models with full names by default", () => {
    const mapped = mapPiModels(models);
    expect(mapped.map((model) => model.label)).toEqual([
      "Plexus Luna Extra Long Name",
      "Plexus Plain Name",
    ]);
    expect(mapped.map((model) => model.description)).toEqual(["plexus/luna", "plexus/plain"]);
  });

  it("labels models with short names where advertised", () => {
    const mapped = mapPiModels(models, undefined, "short");
    expect(mapped.map((model) => model.label)).toEqual(["Luna", "Plexus Plain Name"]);
    expect(mapped[0]?.description).toBe("Plexus Luna Extra Long Name (plexus/luna)");
    expect(mapped[1]?.description).toBe("plexus/plain");
  });

  it("ignores blank short names", () => {
    const mapped = mapPiModels(
      [{ provider: "plexus", id: "blank", name: "Blank Name", plexusShortName: "   " }],
      undefined,
      "short",
    );
    expect(mapped[0]?.label).toBe("Blank Name");
    expect(mapped[0]?.description).toBe("plexus/blank");
  });

  it("still marks the default model when labels are short", () => {
    const mapped = mapPiModels(models, "plexus/luna", "short");
    expect(mapped.find((model) => model.id === "plexus/luna")?.isDefault).toBe(true);
  });
});
