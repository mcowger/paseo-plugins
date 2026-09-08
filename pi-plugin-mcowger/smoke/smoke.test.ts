/**
 * Real-pi smoke test: spawns the actual pi binary (>= 0.85.1) in RPC mode and
 * exercises version probe, catalog, session lifecycle, and a live prompt.
 *
 * Run with: npx vitest run --config vitest.smoke.config.ts
 * Requires pi installed with valid auth (~/.pi/agent/auth.json).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { PiRuntimeEvent } from "../shared/rpc-types.js";
import { compareVersions, MIN_PI_VERSION, PiCliRuntime } from "../server/runtime.js";

const runtime = new PiCliRuntime();

describe("real pi smoke", () => {
  it("applies model + thinking via RPC in under 5s (CLI flags are slow)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const cwd = mkdtempSync(join(tmpdir(), "pi-smoke-fast-open-"));
    const startedAt = Date.now();
    try {
      const session = await runtime.startSession({ cwd, noSession: true });
      try {
        const model = process.env.PI_SMOKE_MODEL ?? "plexus/gemini-3.5-flash-lite";
        const [provider, ...rest] = model.split("/");
        await session.setModel(provider, rest.join("/"));
        await session.setThinkingLevel("high");
        const state = await session.getState();
        expect(state.model?.id).toBe(rest.join("/"));
        expect(state.thinkingLevel).toBe("high");
      } finally {
        await session.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("probes a compatible pi version", async () => {
    const version = await runtime.probeVersion();
    expect(compareVersions(version, MIN_PI_VERSION)).toBeGreaterThanOrEqual(0);
  });

  it("opens a session, lists models with thinking maps, and completes a prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-smoke-"));
    const events: PiRuntimeEvent[] = [];
    try {
      const session = await runtime.startSession({
        cwd,
        noSession: true,
        model: process.env.PI_SMOKE_MODEL ?? "plexus/gemini-3.5-flash-lite",
      });
      session.onEvent((event) => events.push(event));
      try {
        const state = await session.getState();
        expect(state.sessionId).toBeTruthy();

        const models = await session.getAvailableModels(null);
        expect(models.length).toBeGreaterThan(0);
        const reasoningModel = models.find((model) => model.reasoning === true);
        console.log(
          `models=${models.length} reasoningWithMap=${
            models.filter((m) => m.reasoning && m.thinkingLevelMap).length
          }`,
        );
        expect(reasoningModel).toBeDefined();

        const commands = await session.getCommands();
        console.log(`commands=${commands.map((command) => command.name).join(",")}`);

        await session.prompt('Reply with exactly the word "OK" and nothing else.');
        const settled = await waitFor(
          events,
          (event) => event.type === "agent_settled",
          90_000,
        );
        expect(settled).toBe(true);

        console.log(
          `event types: ${[...new Set(events.map((event) => event.type))].join(",")}`,
        );
        const updateSample = events.find((event) => event.type === "message_update");
        if (updateSample) {
          console.log(`message_update sample: ${JSON.stringify(updateSample).slice(0, 400)}`);
        }
        for (const event of events) {
          if (event.type === "message_end" || event.type === "agent_end" || event.type === "auto_retry_start") {
            console.log(`${event.type}: ${JSON.stringify(event).slice(0, 500)}`);
          }
        }
        const deltas = events.filter(
          (event) =>
            event.type === "message_update" &&
            "assistantMessageEvent" in event &&
            (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent
              ?.type === "text_delta",
        );
        expect(deltas.length).toBeGreaterThan(0);
        const text = deltas
          .map(
            (event) =>
              (event as { assistantMessageEvent?: { delta?: string } }).assistantMessageEvent
                ?.delta ?? "",
          )
          .join("");
        console.log(`assistant text: ${text.slice(0, 100)}`);
        expect(text).toContain("OK");

        const stats = await session.getSessionStats();
        console.log(`stats: ${JSON.stringify(stats.tokens ?? {})}`);
      } finally {
        await session.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loads the paseo-integration extension and answers entry capture", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-smoke-ext-"));
    const { createPiPaseoExtensionFile } = await import("../server/extension.js");
    const extension = createPiPaseoExtensionFile("PASEO_SMOKE_SYSTEM_PROMPT_MARKER");
    const events: PiRuntimeEvent[] = [];
    try {
      const session = await runtime.startSession({
        cwd,
        noSession: true,
        extensionPaths: [extension.path],
      });
      session.onEvent((event) => events.push(event));
      try {
        // The extension emits an entry capture notification on session_start.
        const captured = await waitFor(
          events,
          (event) =>
            event.type === "extension_ui_request" &&
            typeof (event as Record<string, unknown>).message === "string" &&
            ((event as Record<string, unknown>).message as string).startsWith(
              "PASEO_ENTRY_CAPTURE",
            ),
          15_000,
        );
        expect(captured).toBe(true);

        const commands = await session.getCommands();
        const names = commands.map((command) => command.name);
        expect(names).toContain("paseo_tree");
        expect(names).toContain("paseo_capture_entries");
      } finally {
        await session.close();
      }
    } finally {
      extension.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

async function waitFor(
  events: PiRuntimeEvent[],
  predicate: (event: PiRuntimeEvent) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (events.some(predicate)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
