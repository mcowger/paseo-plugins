/**
 * Rewind history-replacement contract probe.
 *
 * Runs the installed Paseo host adapter (`@getpaseo/server` 0.11.0-beta.3 in the
 * isolated npm env) against a mocked *public* `ProviderRegistration`. It proves
 * the append-only behavior behind the Stage 5 rewind blocker: after
 * `revertConversation` succeeds, `PluginAgentSession.streamHistory()` still
 * yields the abandoned future rows, so the host's forced hydration
 * (`forceHydrateTimelineFromLegacyProviderHistory`) re-records them.
 *
 * Test-only: this file imports a host-internal compiled module by path as
 * evidence. Production Superpi code must never import Paseo internals.
 *
 * Skips (rather than fails) when the isolated 0.11 host is not installed, so
 * the repository's pinned 0.10 test run stays green. Point `PASEO_HOST_ROOT` at
 * a `@getpaseo/server` package to run it elsewhere.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const defaultHostRoot = fileURLToPath(
  new URL("../.test-env/simple/node_modules/@getpaseo/server", import.meta.url),
);
const hostRoot = process.env.PASEO_HOST_ROOT
  ? resolve(process.env.PASEO_HOST_ROOT)
  : defaultHostRoot;
const adapterEntry = join(hostRoot, "dist/server/server/agent/plugin-provider.js");
const pluginProviderTypes = join(hostRoot, "../plugin/dist/server/provider.d.ts");
const hostAvailable = existsSync(adapterEntry);

const CAPABILITIES = [
  "prompt.message",
  "session.persistence",
  "session.configure",
  "session.list",
  "session.revert.conversation",
  "session.revert.files",
  "session.revert.both",
] as const;

type ProviderEvent = { type: string; [key: string]: unknown };
type ProviderInput = { type: string; [key: string]: unknown };

interface MockProviderHarness {
  registry: { shutdown(): Promise<void> };
  session: {
    id: string | null;
    capabilities: { supportsRewindConversation: boolean };
    streamHistory(): AsyncGenerator<{ type: string; item?: { type: string; text?: string; messageId?: string } }>;
    revertConversation(input: { messageId: string }): Promise<void>;
  };
  received: ProviderInput[];
  /** Provider-facing session id used for provider -> host events. */
  providerSessionId: () => string | null;
  emit: (event: ProviderEvent) => void;
}

async function createHarness(): Promise<MockProviderHarness> {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(adapterEntry).href)) as {
    PluginAgentClientRegistry: new (logger: unknown) => {
      replace(registrations: unknown[]): void;
      clients(): Record<string, {
        createSession(config: unknown): Promise<MockProviderHarness["session"]>;
      }>;
      shutdown(): Promise<void>;
    };
  };

  const listeners = new Set<(event: ProviderEvent) => void>();
  const received: ProviderInput[] = [];
  let providerSessionId: string | null = null;

  const emit = (event: ProviderEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const registration = {
    id: "mock-rewind",
    label: "Mock Rewind",
    connect: async () => ({
      version: 1,
      capabilities: CAPABILITIES,
      send: async (input: ProviderInput): Promise<void> => {
        received.push(input);
        if (input.type === "session.open") {
          providerSessionId = input.sessionId as string;
          const requestId = input.requestId as string;
          emit({
            type: "session.opened",
            requestId,
            sessionId: providerSessionId,
            capabilities: CAPABILITIES,
            restoration: "core",
            cwd: (input.config as { cwd: string }).cwd,
          });
          emit({ type: "session.ready", requestId, sessionId: providerSessionId });
          return;
        }
        if (input.type === "session.revert") {
          // A real provider would drop its own future here. The host adapter's
          // own history mirror is what this test measures.
          emit({ type: "request.completed", requestId: input.requestId as string });
        }
      },
      onEvent: (listener: (event: ProviderEvent) => void): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: async (): Promise<void> => undefined,
    }),
  };

  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return this;
    },
  };

  const registry = new mod.PluginAgentClientRegistry(logger);
  registry.replace([registration]);
  const session = await registry.clients()["mock-rewind"].createSession({
    provider: "mock-rewind",
    cwd: "/tmp/mock-rewind",
  });

  return { registry, session, received, providerSessionId: () => providerSessionId, emit };
}

async function timelineTexts(session: MockProviderHarness["session"]): Promise<string[]> {
  const texts: string[] = [];
  for await (const event of session.streamHistory()) {
    if (event.type === "timeline" && event.item?.text) texts.push(event.item.text);
  }
  return texts;
}

describe.skipIf(!hostAvailable)("rewind history replacement against installed host adapter", () => {
  it("keeps the abandoned future in streamHistory after revertConversation", async () => {
    const harness = await createHarness();
    try {
      expect(harness.session.capabilities.supportsRewindConversation).toBe(true);
      const sessionId = harness.providerSessionId();
      expect(sessionId).toBeTruthy();

      for (const [text, revertToken] of [
        ["A", { token: "a" }],
        ["B", undefined],
        ["C", { token: "c" }],
      ] as const) {
        harness.emit({
          type: "timeline.item",
          sessionId,
          item: {
            type: "user_message",
            id: `m-${text}`,
            messageId: `msg-${text}`,
            text,
            ...(revertToken ? { revertToken } : {}),
          },
        });
      }

      expect(await timelineTexts(harness.session)).toEqual(["A", "B", "C"]);

      await harness.session.revertConversation({ messageId: "msg-A" });

      const reverts = harness.received.filter((input) => input.type === "session.revert");
      expect(reverts).toHaveLength(1);
      expect(reverts[0]).toMatchObject({
        sessionId,
        token: { token: "a" },
        scope: "conversation",
      });
      // The host holds the existing session reference; revert does not reopen.
      expect(harness.received.some((input) => input.type === "session.open")).toBe(true);
      expect(harness.received.filter((input) => input.type === "session.open")).toHaveLength(1);

      // BLOCKER CHARACTERIZATION: the adapter never prunes history, so the
      // forced hydration that follows a successful rewind re-reads A, B, C.
      expect(await timelineTexts(harness.session)).toEqual(["A", "B", "C"]);
    } finally {
      await harness.registry.shutdown();
    }
  });

  it("exposes no public provider reset/replace/refresh contract", () => {
    const types = readFileSync(pluginProviderTypes, "utf8");
    const memberLiterals = [...types.matchAll(/type:\s*"([^"]+)"/g)].map((m) => m[1]);

    expect(memberLiterals.length).toBeGreaterThan(0);
    expect(memberLiterals.filter((name) => /history|reset|replace|refresh/i.test(name))).toEqual(
      [],
    );
    // The only history-shaped values are the open-time replay mode.
    expect(types).toMatch(/history:\s*"replay"\s*\|\s*"skip"/);
    // No revert/history capability beyond the three documented scopes.
    expect(types).toMatch(/"session\.revert\.both"/);
    expect(types).not.toMatch(/"session\.[a-z.]*(history|reset|replace|refresh)/i);
  });
});
