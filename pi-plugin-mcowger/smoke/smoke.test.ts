/**
 * Real-pi smoke test: exercises the SDK path in-process — session creation,
 * model catalog, a live prompt with streaming, presets, and resume.
 * Run with: npx vitest run --config vitest.smoke.config.ts
 * Uses ~/.pi/agent auth; no pi binary spawning.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";

const MODEL = process.env.PI_SMOKE_MODEL ?? "plexus/gemini-3.5-flash-lite";

// Same warmup the plugin does: one in-memory session loads user extensions so
// extension-registered providers (e.g. plexus) appear in the model registry.
async function createModelRuntime(): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create();
  const loader = new DefaultResourceLoader({ cwd: homedir(), agentDir: getAgentDir() });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: homedir(),
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(homedir()),
    resourceLoader: loader,
  });
  session.dispose();
  return runtime;
}

describe("real pi SDK smoke", () => {
  it("lists authenticated models with per-model thinking maps", async () => {
    const modelRuntime = await createModelRuntime();
    const available = await modelRuntime.getAvailable();
    expect(available.length).toBeGreaterThan(0);
    const withMap = available.filter((m) => m.reasoning && m.thinkingLevelMap);
    console.log(`models=${available.length} reasoningWithMap=${withMap.length}`);
    expect(withMap.length).toBeGreaterThan(0);
  });

  it("creates a session, applies model+thinking via SDK, and completes a prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-sdk-smoke-"));
    const events: AgentSessionEvent[] = [];
    const modelRuntime = await createModelRuntime();
    try {
      const [provider, ...rest] = MODEL.split("/");
      const model = modelRuntime.getModel(provider, rest.join("/"));
      expect(model).toBeDefined();

      const { session } = await createAgentSession({
        cwd,
        modelRuntime,
        model,
        thinkingLevel: "low",
        sessionManager: SessionManager.inMemory(cwd),
      });
      session.subscribe((event) => events.push(event));
      try {
        expect(session.model?.id).toBe(rest.join("/"));
        expect(session.thinkingLevel).toBe("low");

        await session.prompt('Reply with exactly the word "OK" and nothing else.');
        const deltas = events.filter(
          (event) =>
            event.type === "message_update" &&
            (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent
              ?.type === "text_delta",
        );
        const text = deltas
          .map(
            (event) =>
              (event as { assistantMessageEvent?: { delta?: string } }).assistantMessageEvent
                ?.delta ?? "",
          )
          .join("");
        console.log(`assistant text: ${text.slice(0, 120)}`);
        expect(text).toContain("OK");
        expect(events.some((event) => event.type === "agent_end")).toBe(true);
      } finally {
        session.dispose();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);

  it("persists and resumes a session with history intact", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-sdk-resume-"));
    const modelRuntime = await createModelRuntime();
    try {
      const [provider, ...rest] = MODEL.split("/");
      const model = modelRuntime.getModel(provider, rest.join("/"));

      const first = await createAgentSession({
        cwd,
        modelRuntime,
        model,
        thinkingLevel: "low",
        sessionManager: SessionManager.create(cwd),
      });
      await first.session.prompt('Reply with exactly the word "BONGO".');
      const sessionFile = first.session.sessionFile;
      const sessionId = first.session.sessionId;
      expect(sessionFile).toBeTruthy();
      first.session.dispose();

      const resumed = await createAgentSession({
        cwd,
        modelRuntime,
        sessionManager: SessionManager.open(sessionFile!),
      });
      try {
        expect(resumed.session.sessionId).toBe(sessionId);
        const text = JSON.stringify(resumed.session.messages);
        expect(text).toContain("BONGO");
        await resumed.session.prompt('Reply with exactly the word "TWICE".');
        expect(JSON.stringify(resumed.session.messages)).toContain("TWICE");
      } finally {
        resumed.session.dispose();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);
});
