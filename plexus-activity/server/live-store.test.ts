import { describe, expect, it } from "vitest";
import type { RecordPatch } from "../shared/row-model";
import { createLiveStore } from "./live-store";

function patch(overrides: Partial<RecordPatch> & { requestId: string }): RecordPatch {
  return { startTime: 1_000, ...overrides };
}

describe("createLiveStore", () => {
  it("projects a full snapshot newest first", () => {
    const store = createLiveStore({ clock: () => 5_000 });
    store.applyPatches([
      patch({ requestId: "old", startTime: 1_000, selectedModelName: "m-old" }),
      patch({ requestId: "new", startTime: 3_000, selectedModelName: "m-new" }),
    ]);

    const snapshot = store.snapshot({ scope: null, since: null });

    expect(snapshot.reset).toBe(true);
    expect(snapshot.rows.map((row) => row.requestId)).toEqual(["new", "old"]);
    expect(snapshot.rows[0]?.modelSlug).toBe("m-new");
    expect(snapshot.cursor).toBe(2);
    expect(snapshot.serverNow).toBe(5_000);
  });

  it("merges sparse updates into an existing row", () => {
    const store = createLiveStore();
    store.applyPatch(patch({ requestId: "req", responseStatus: "pending", apiKey: "team-a" }));
    store.applyPatch({ requestId: "req", tokensOutput: 42 });

    const [row] = store.snapshot({ scope: null, since: null }).rows;
    expect(row?.status).toBe("pending");
    expect(row?.tokens.output).toBe(42);
    expect(row?.startTime).toBe(1_000);
  });

  it("returns only rows that changed after the cursor", () => {
    const store = createLiveStore();
    store.applyPatch(patch({ requestId: "a" }));
    const cursor = store.snapshot({ scope: null, since: null }).cursor;

    store.applyPatch(patch({ requestId: "b", startTime: 2_000 }));

    const delta = store.snapshot({ scope: null, since: cursor });
    expect(delta.reset).toBe(false);
    expect(delta.rows.map((row) => row.requestId)).toEqual(["b"]);
    expect(delta.cursor).toBeGreaterThan(cursor);
  });

  it("returns an empty delta when nothing changed", () => {
    const store = createLiveStore();
    store.applyPatch(patch({ requestId: "a" }));
    const cursor = store.snapshot({ scope: null, since: null }).cursor;
    expect(store.snapshot({ scope: null, since: cursor })).toMatchObject({
      reset: false,
      rows: [],
      cursor,
    });
  });

  it("forces a reset when the cursor was evicted from the journal", () => {
    const store = createLiveStore({ journalMax: 3 });
    for (const id of ["a", "b", "c", "d", "e"]) store.applyPatch(patch({ requestId: id }));

    const snapshot = store.snapshot({ scope: null, since: 1 });
    expect(snapshot.reset).toBe(true);
    expect(snapshot.rows).toHaveLength(5);
  });

  it("forces a reset for a cursor from a previous process", () => {
    const store = createLiveStore();
    store.applyPatch(patch({ requestId: "a" }));
    expect(store.snapshot({ scope: null, since: 99 })).toMatchObject({ reset: true });
  });

  it("scopes by exact key name", () => {
    const store = createLiveStore();
    store.applyPatches([
      patch({ requestId: "a", apiKey: "team-a", startTime: 1_000 }),
      patch({ requestId: "b", apiKey: "team-a2", startTime: 2_000 }),
      patch({ requestId: "c", apiKey: null, startTime: 3_000 }),
    ]);

    const scoped = store.snapshot({ scope: "team-a", since: null });
    expect(scoped.rows.map((row) => row.requestId)).toEqual(["a"]);

    const unscoped = store.snapshot({ scope: null, since: null });
    expect(unscoped.rows.map((row) => row.requestId)).toEqual(["c", "b", "a"]);
  });

  it("decorates in-flight rows with the live estimate and drops it on completion", () => {
    const store = createLiveStore();
    store.applyPatch(patch({ requestId: "a", responseStatus: "pending", incomingApiType: "chat" }));
    store.applyProgress("a", {
      bytesPerSec: 21_500,
      semanticBytesPerSec: null,
      semanticBytesReceived: null,
      elapsedMs: 1_000,
      isStreamed: true,
    });

    expect(store.snapshot({ scope: null, since: null }).rows[0]?.liveTokensPerSec).toBe(100);

    store.applyPatch({ requestId: "a", responseStatus: "success", durationMs: 2_000 });
    expect(store.snapshot({ scope: null, since: null }).rows[0]?.liveTokensPerSec).toBeNull();
  });

  it("ignores progress for requests it has not seen", () => {
    const store = createLiveStore();
    store.applyProgress("ghost", {
      bytesPerSec: 1_000,
      semanticBytesPerSec: null,
      semanticBytesReceived: null,
      elapsedMs: 1_000,
      isStreamed: true,
    });
    expect(store.snapshot({ scope: null, since: null }).rows).toEqual([]);
  });

  it("evicts the oldest rows beyond the cap", () => {
    const store = createLiveStore({ maxRows: 2 });
    store.applyPatches([
      patch({ requestId: "oldest", startTime: 1_000 }),
      patch({ requestId: "middle", startTime: 2_000 }),
      patch({ requestId: "newest", startTime: 3_000 }),
    ]);

    expect(store.size()).toBe(2);
    expect(store.snapshot({ scope: null, since: null }).rows.map((row) => row.requestId)).toEqual([
      "newest",
      "middle",
    ]);
  });

  it("skips delta rows whose records were evicted", () => {
    const store = createLiveStore({ maxRows: 1, journalMax: 10 });
    store.applyPatch(patch({ requestId: "gone", startTime: 1_000 }));
    const cursor = store.snapshot({ scope: null, since: null }).cursor;
    store.applyPatch(patch({ requestId: "kept", startTime: 2_000 }));

    const delta = store.snapshot({ scope: null, since: cursor });
    expect(delta.rows.map((row) => row.requestId)).toEqual(["kept"]);
  });

  it("reports the latest state for a row mutated several times after the cursor", () => {
    const store = createLiveStore();
    store.applyPatch(patch({ requestId: "a", responseStatus: "pending" }));
    const cursor = store.snapshot({ scope: null, since: null }).cursor;

    store.applyPatch({ requestId: "a", tokensOutput: 5 });
    store.applyPatch({ requestId: "a", tokensOutput: 9, responseStatus: "success" });

    const delta = store.snapshot({ scope: null, since: cursor });
    expect(delta.rows).toHaveLength(1);
    expect(delta.rows[0]?.tokens.output).toBe(9);
    expect(delta.rows[0]?.status).toBe("success");
  });
});
