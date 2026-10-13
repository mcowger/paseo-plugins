import { mkdtempSync, existsSync, lstatSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { prepareAuthSnapshot } from "./auth-snapshot.js";

describe("prepareAuthSnapshot", () => {
  let root: string;
  let source: string;
  let state: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "superpi-auth-snapshot-"));
    source = path.join(root, "agent");
    state = path.join(root, "state");
    mkdirSync(source, { recursive: true });
    mkdirSync(state, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("copies auth.json into a snapshot dir and links the other agent files", () => {
    writeFileSync(path.join(source, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "sk-a" } }));
    writeFileSync(path.join(source, "settings.json"), "{}");
    writeFileSync(path.join(source, "models.json"), "{}");
    writeFileSync(path.join(source, "auth.json.lock"), "");

    const dir = prepareAuthSnapshot({ root: state, env: { PI_CODING_AGENT_DIR: source } });

    expect(dir).toBe(path.join(state, "agent-dir"));
    expect(JSON.parse(readFileSync(path.join(dir!, "auth.json"), "utf-8"))).toEqual({
      openai: { type: "api_key", key: "sk-a" },
    });
    expect(statSync(path.join(dir!, "auth.json")).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.join(dir!, "settings.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(dir!, "settings.json"))).toBe(path.join(source, "settings.json"));
    expect(existsSync(path.join(dir!, "auth.json.lock"))).toBe(false);
  });

  test("auth.json in the snapshot is a copy, not a link to the real file", () => {
    writeFileSync(path.join(source, "auth.json"), JSON.stringify({ a: { type: "api_key", key: "k" } }));
    const dir = prepareAuthSnapshot({ root: state, env: { PI_CODING_AGENT_DIR: source } })!;
    expect(lstatSync(path.join(dir, "auth.json")).isSymbolicLink()).toBe(false);
  });

  test("refreshes the snapshot on each call", () => {
    writeFileSync(path.join(source, "auth.json"), JSON.stringify({ a: { type: "api_key", key: "old" } }));
    prepareAuthSnapshot({ root: state, env: { PI_CODING_AGENT_DIR: source } });
    writeFileSync(path.join(source, "auth.json"), JSON.stringify({ a: { type: "api_key", key: "new" } }));

    const dir = prepareAuthSnapshot({ root: state, env: { PI_CODING_AGENT_DIR: source } })!;

    expect(JSON.parse(readFileSync(path.join(dir, "auth.json"), "utf-8")).a.key).toBe("new");
  });

  test("drops links for agent files that were removed from the real dir", () => {
    writeFileSync(path.join(source, "auth.json"), "{}");
    writeFileSync(path.join(source, "models.json"), "{}");
    const dir = prepareAuthSnapshot({ root: state, env: { PI_CODING_AGENT_DIR: source } })!;
    rmSync(path.join(source, "models.json"));

    prepareAuthSnapshot({ root: state, env: { PI_CODING_AGENT_DIR: source } });

    expect(existsSync(path.join(dir, "models.json"))).toBe(false);
    expect(isSymlinkPath(path.join(dir, "models.json"))).toBe(false);
  });

  test("writes the snapshot under XDG_RUNTIME_DIR when it is set", () => {
    writeFileSync(path.join(source, "auth.json"), "{}");
    const runtime = path.join(root, "runtime");
    mkdirSync(runtime, { recursive: true });

    const dir = prepareAuthSnapshot({ env: { PI_CODING_AGENT_DIR: source, XDG_RUNTIME_DIR: runtime } });

    expect(dir).toBe(path.join(runtime, "superpi", "agent-dir"));
    expect(existsSync(path.join(dir!, "auth.json"))).toBe(true);
  });

  test("returns undefined when auth.json is missing", () => {
    expect(prepareAuthSnapshot({ root: state, env: { PI_CODING_AGENT_DIR: source } })).toBeUndefined();
  });

  test("returns undefined when auth.json is torn", () => {
    writeFileSync(path.join(source, "auth.json"), "{ not json");
    expect(prepareAuthSnapshot({ root: state, env: { PI_CODING_AGENT_DIR: source } })).toBeUndefined();
  });

  test("expands a tilde in PI_CODING_AGENT_DIR", () => {
    const home = mkdtempSync(path.join(tmpdir(), "superpi-home-"));
    const original = process.env.HOME;
    process.env.HOME = home;
    try {
      mkdirSync(path.join(home, "custom"), { recursive: true });
      writeFileSync(path.join(home, "custom", "auth.json"), "{}");
      const dir = prepareAuthSnapshot({ root: state, env: { PI_CODING_AGENT_DIR: "~/custom" } });
      expect(dir).toBe(path.join(state, "agent-dir"));
    } finally {
      process.env.HOME = original;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function isSymlinkPath(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
