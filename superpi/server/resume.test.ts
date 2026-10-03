import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { SessionStore } from "./persistence.js";
import { buildResumeCommand } from "./resume.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

it("copies a quoted native transcript command while the provider owns its writer lock", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "superpi resume ' "));
  directories.push(cwd);
  const stateDirectory = path.join(cwd, "state");
  const store = await SessionStore.open(stateDirectory, cwd);
  try {
    const transcript = path.join(store.sessionDirectory, "session ' quoted.jsonl");
    await fs.writeFile(transcript, "{}\n");
    await store.recordNative("native-id", transcript);
    const command = await buildResumeCommand({ stateDirectory, cwd, persistence: store.persistence, command: "printf", companionPath: "/companion ' file.ts", agentDirectory: "/agent ' directory" });
    expect(command).toContain("PI_CODING_AGENT_DIR='/agent '\\'' directory'");
    const output = execFileSync("sh", ["-c", command.replace("'printf'", "'printf' '%s\\n' --")], { encoding: "utf8" });
    expect(output.split("\n")).toEqual(["--", "--session", transcript, "--session-dir", store.sessionDirectory, "--extension", "/companion ' file.ts", "--superpi-companion-root", ""]);
    await expect(SessionStore.open(stateDirectory, cwd, store.persistence)).rejects.toThrow("active writer");
  } finally { await store.release(); }
});

it("refuses missing, foreign, and escaping transcripts", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "superpi-resume-"));
  directories.push(cwd);
  const stateDirectory = path.join(cwd, "state");
  const store = await SessionStore.open(stateDirectory, cwd);
  const input = { stateDirectory, cwd, persistence: store.persistence, command: "pi", companionPath: "/companion.ts" };
  try {
    await expect(buildResumeCommand(input)).rejects.toThrow("no saved Pi transcript");
    await expect(buildResumeCommand({ ...input, persistence: { version: 1, data: { id: "../outside" } } })).rejects.toThrow();
    const other = path.join(cwd, "other");
    await fs.mkdir(other);
    await expect(buildResumeCommand({ ...input, cwd: other })).rejects.toThrow("workspace");
    const outside = path.join(cwd, "outside.jsonl");
    await fs.writeFile(outside, "{}\n");
    await store.save({ nativeSessionFile: "../outside.jsonl" });
    await expect(buildResumeCommand(input)).rejects.toThrow("identity");
  } finally { await store.release(); }
});
