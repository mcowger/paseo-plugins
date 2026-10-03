import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "./persistence.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "superpi-persistence-"));
  directories.push(directory);
  return { cwd: directory, root: path.join(directory, "state") };
}

describe("session persistence", () => {
  it("allows Pi's lazy transcript creation but records the file as soon as it exists", async () => {
    const { cwd, root } = await fixture();
    const store = await SessionStore.open(root, cwd);
    const transcript = path.join(store.sessionDirectory, "lazy.jsonl");
    await store.recordNative("pi-id", transcript);
    expect(await store.transcript()).toBeUndefined();
    await fs.writeFile(transcript, "{}\n");
    await store.recordNative("pi-id", transcript);
    expect(await store.transcript()).toBe(transcript);
    await fs.unlink(transcript);
    await expect(store.recordNative("pi-id", transcript)).rejects.toThrow();
    await store.release();
    await expect(SessionStore.open(root, cwd, store.persistence)).rejects.toThrow();
  });
  it("restores opaque owned handles and private metadata", async () => {
    const { cwd, root } = await fixture();
    const store = await SessionStore.open(root, cwd);
    const transcript = path.join(store.sessionDirectory, "session.jsonl");
    await fs.writeFile(transcript, "{}\n");
    await store.recordNative("pi-id", transcript);
    const handle = store.persistence;
    expect(JSON.stringify(handle)).not.toContain(root);
    expect((await fs.stat(path.join(store.directory, "manifest.json"))).mode & 0o077).toBe(0);
    await store.release();
    const restored = await SessionStore.open(root, cwd, handle);
    expect(await restored.transcript()).toBe(transcript);
    expect(restored.data.nativeSessionId).toBe("pi-id");
    await restored.release();
  });

  it("refuses concurrent writers and releases idempotently", async () => {
    const { cwd, root } = await fixture();
    const store = await SessionStore.open(root, cwd);
    await expect(SessionStore.open(root, cwd, store.persistence)).rejects.toThrow("active writer");
    await Promise.all([store.release(), store.release()]);
  });

  it("rejects traversal, wrong cwd, and external transcript links", async () => {
    const { cwd, root } = await fixture();
    await expect(SessionStore.open(root, cwd, { version: 1, data: { id: "../../outside" } })).rejects.toThrow();
    const store = await SessionStore.open(root, cwd);
    const outside = path.join(cwd, "outside.jsonl");
    await fs.writeFile(outside, "{}\n");
    await fs.symlink(outside, path.join(store.sessionDirectory, "bad.jsonl"));
    await expect(store.recordNative("id", path.join(store.sessionDirectory, "bad.jsonl"))).rejects.toThrow("outside");
    await store.release();
    await fs.mkdir(path.join(cwd, "other"));
    await expect(SessionStore.open(root, path.join(cwd, "other"), store.persistence)).rejects.toThrow("workspace");
  });

  it("serializes changes and preserves interrupted state", async () => {
    const { cwd, root } = await fixture();
    const store = await SessionStore.open(root, cwd);
    await Promise.all([store.save({ nativeSessionId: "first" }), store.save({ interrupted: true })]);
    expect(store.data).toMatchObject({ nativeSessionId: "first", interrupted: true });
    await store.release();
    await expect(store.save({})).rejects.toThrow("released");
  });
});
