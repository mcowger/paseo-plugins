import { describe, expect, it } from "vitest";

import { createPiPresetStore } from "./preset-store.js";

describe("createPiPresetStore", () => {
  it("publishes validated settings as provider presets", () => {
    const store = createPiPresetStore();
    const snapshots: string[] = [];
    const unsubscribe = store.subscribe((snapshot) => snapshots.push(snapshot.revision));

    store.update(
      {
        presets: [
          {
            id: "plan",
            name: "Plan",
            model: "openai/gpt-5.2",
            thinkingLevel: "high",
          },
        ],
      },
      "revision-1",
      null,
    );

    expect(store.snapshot()).toMatchObject({
      revision: "revision-1",
      presets: { plan: { name: "Plan", model: "openai/gpt-5.2" } },
    });
    expect(snapshots).toEqual(["revision-1"]);

    unsubscribe();
    store.update({ presets: [] }, "revision-2", "revision-1");
    expect(snapshots).toEqual(["revision-1"]);
  });

  it("rejects a delayed sync based on an older revision", () => {
    const store = createPiPresetStore();
    store.update({ presets: [] }, "revision-1", null);
    store.update({ presets: [] }, "revision-2", "revision-1");
    expect(() => store.update({ presets: [] }, "revision-old", "revision-1")).toThrow(
      /changed before this sync completed/,
    );
    expect(store.snapshot().revision).toBe("revision-2");
  });
});
