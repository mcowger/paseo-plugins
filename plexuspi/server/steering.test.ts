import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type ProviderEvent,
  ProviderEventSchema,
  type ProviderPrompt,
} from "@getpaseo/plugin/server/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-snapshot.js", () => ({ prepareAuthSnapshot: () => undefined }));

import { FakePiRpc, type FakePiRpcOptions } from "../tests/fixtures/fake-pi-rpc.js";
import { PiRpcTimeoutError } from "./pi-rpc.js";
import { createPlexuspiSession, type PlexuspiSession } from "./session.js";

let root: string;
const sessions: PlexuspiSession[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "plexuspi-steering-"));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await fs.rm(root, { recursive: true, force: true });
});

function ofType<T extends ProviderEvent["type"]>(events: readonly ProviderEvent[], type: T) {
  return events.filter(
    (event): event is Extract<ProviderEvent, { type: T }> => event.type === type,
  );
}

function prompt(
  clientMessageId: string,
  delivery: "auto" | "steer" = "steer",
  text = clientMessageId,
): ProviderPrompt {
  return {
    clientMessageId,
    delivery,
    input: { type: "message", content: [{ type: "text", text }] },
  };
}

function echo(fake: FakePiRpc, text: string, timestamp: number): void {
  const message = { role: "user", content: text, timestamp };
  fake.emit({ type: "message_start", message });
  fake.emit({ type: "message_end", message });
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function harness(options: FakePiRpcOptions = {}, start = true) {
  const fake = new FakePiRpc({
    ...options,
    ...(options.commands ? { commands: [{ name: "plexuspi-control" }, ...options.commands] } : {}),
  });
  const events: ProviderEvent[] = [];
  const session = createPlexuspiSession({
    sessionId: "host-steering",
    config: { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: false },
    history: "skip",
    stateDirectory: path.join(root, "state"),
    command: "pi",
    createPiRpc: async () => fake,
    emit(event) {
      ProviderEventSchema.parse(event);
      events.push(event);
    },
  });
  sessions.push(session);
  await session.open("open");
  if (start) await session.prompt(prompt("original", "auto"));
  const turnId = ofType(events, "session.turn").find((event) => event.state === "started")?.turnId;
  return { session, fake, events, turnId };
}

function result(events: ProviderEvent[], clientMessageId: string) {
  const results = ofType(events, "session.prompt_result").filter(
    (event) => event.clientMessageId === clientMessageId,
  );
  expect(results).toHaveLength(1);
  const first = results[0];
  if (!first) throw new Error("expected one prompt result");
  return first.result;
}

async function settled(fake: FakePiRpc, events: ProviderEvent[]) {
  fake.emit({ type: "agent_settled" });
  await vi.waitFor(() =>
    expect(
      ofType(events, "session.turn").filter((event) => event.state !== "started"),
    ).toHaveLength(1),
  );
}

describe("native prompt steering", () => {
  it("keeps one active turn and binds every native user start/end to its own host message", async () => {
    const { session, fake, events, turnId } = await harness();
    echo(fake, "original", 1);
    const promptCount = fake.requestsOfType("prompt").length;
    await session.prompt(prompt("steer-1"));
    await session.prompt(prompt("steer-2"));
    expect(result(events, "steer-1")).toEqual({ type: "steer", turnId });
    expect(result(events, "steer-2")).toEqual({ type: "steer", turnId });
    expect(fake.requestsOfType("steer")).toEqual([
      { type: "steer", message: "steer-1" },
      { type: "steer", message: "steer-2" },
    ]);
    expect(fake.requestsOfType("prompt")).toHaveLength(promptCount);
    expect(fake.requestsOfType("abort")).toHaveLength(0);
    expect(fake.requestsOfType("clear_queue")).toHaveLength(0);
    echo(fake, "steer-1", 2);
    echo(fake, "steer-2", 3);
    const rows = ofType(events, "timeline.item").filter(
      (event) => event.item.type === "user_message",
    );
    expect(
      rows.map((event) =>
        event.item.type === "user_message" ? event.item.clientMessageId : undefined,
      ),
    ).toEqual(["original", "original", "steer-1", "steer-1", "steer-2", "steer-2"]);
    expect(new Set(rows.map((event) => event.item.id)).size).toBe(3);
    await settled(fake, events);
    expect(ofType(events, "session.turn").map((event) => [event.turnId, event.state])).toEqual([
      [turnId, "started"],
      [turnId, "completed"],
    ]);
  });

  it("binds an echo carrying Pi's image annotation to its admission", async () => {
    const { session, fake, events, turnId } = await harness();
    echo(fake, "original", 1);
    await session.prompt(prompt("img-1", "steer", "look"));
    expect(result(events, "img-1")).toEqual({ type: "steer", turnId });
    // Pi annotates attached images in the user message it echoes back; the
    // prompt PlexusPi sent was just "look". The annotation must not defeat
    // the bind, or the host records the prompt a second time.
    echo(
      fake,
      "look\n\n[Image: original 10x10, displayed at 10x10. Multiply coordinates by 1.00 to map to original image.]",
      2,
    );
    const rows = ofType(events, "timeline.item").filter(
      (event) => event.item.type === "user_message",
    );
    expect(
      rows.map((event) =>
        event.item.type === "user_message" ? event.item.clientMessageId : undefined,
      ),
    ).toEqual(["original", "original", "img-1", "img-1"]);
    expect(new Set(rows.map((event) => event.item.id)).size).toBe(2);
  });

  it("does not let an unechoed admission strand every later bind", async () => {
    const { session, fake, events } = await harness({}, false);
    // A prompt Pi accepted but whose user message never echoes (an abort can
    // land before the first event) must not sit at the head of the queue and
    // fail every later bind; the host would duplicate every later prompt.
    await session.prompt(prompt("lost", "auto", "lost-text"));
    fake.emit({ type: "agent_settled" });
    await vi.waitFor(() =>
      expect(
        ofType(events, "session.turn").filter((event) => event.state !== "started"),
      ).toHaveLength(1),
    );
    await session.prompt(prompt("next", "auto", "next-text"));
    echo(fake, "next-text", 2);
    const rows = ofType(events, "timeline.item").filter(
      (event) => event.item.type === "user_message",
    );
    expect(
      rows.map((event) =>
        event.item.type === "user_message" ? event.item.clientMessageId : undefined,
      ),
    ).toEqual(["next", "next"]);
  });

  it("binds a steer echoed before its admission response without starting a new turn", async () => {
    const { session, fake, events, turnId } = await harness({
      onSteer(_command) {
        echo(fake, "early", 2);
      },
    });
    echo(fake, "original", 1);
    await session.prompt(prompt("early"));
    expect(result(events, "early")).toEqual({ type: "steer", turnId });
    expect(ofType(events, "timeline.item").at(-1)?.item).toMatchObject({
      type: "user_message",
      clientMessageId: "early",
    });
    expect(ofType(events, "session.turn")).toHaveLength(1);
  });

  it("refuses idle steering rather than parking it in Pi or inventing a turn", async () => {
    const { session, fake, events } = await harness({}, false);
    await session.prompt(prompt("idle"));
    expect(result(events, "idle")).toMatchObject({
      type: "failed",
      error: { message: expect.stringContaining("no active turn") },
    });
    expect(fake.requestsOfType("steer")).toHaveLength(0);
    expect(ofType(events, "session.turn")).toHaveLength(0);
  });

  it.each(["compact", "autocompact", "model", "settings", "plexuspi-control", "extension-test"])(
    "refuses /%s rather than executing it or sending it as model text",
    async (name) => {
      const { session, fake, events } = await harness({
        commands: [{ name: "extension-test", source: "extension" }],
      });
      const before = fake.requests.length;
      await expect(session.prompt(prompt("command", "steer", `  /${name} args`))).rejects.toThrow(
        "unavailable while steering",
      );
      expect(result(events, "command").type).toBe("failed");
      expect(fake.requests).toHaveLength(before);
    },
  );

  it("rejects structured extension commands but allows native skill/template expansion", async () => {
    const { session, fake, events, turnId } = await harness({
      commands: [
        { name: "extension-test", source: "extension" },
        { name: "review", source: "prompt" },
        { name: "skill:review", source: "skill" },
      ],
    });
    await expect(
      session.prompt({
        ...prompt("blocked"),
        input: { type: "command", name: "extension-test", arguments: "now" },
      }),
    ).rejects.toThrow("unavailable while steering");
    expect(result(events, "blocked").type).toBe("failed");
    await session.prompt(prompt("template", "steer", "/review now"));
    await session.prompt({
      ...prompt("skill"),
      input: { type: "command", name: "skill:review", arguments: "now" },
    });
    expect(fake.requestsOfType("steer").map((command) => command.message)).toEqual([
      "/review now",
      "/skill:review now",
    ]);
    expect(result(events, "template")).toEqual({ type: "steer", turnId });
    expect(result(events, "skill")).toEqual({ type: "steer", turnId });
  });

  it("forwards validated inline images to an image-capable model", async () => {
    const { session, fake, events, turnId } = await harness({
      state: { model: { provider: "test", id: "image", input: ["text", "image"] } },
    });
    const image = { type: "image" as const, data: "YQ==", mimeType: "image/png" };
    await session.prompt({
      ...prompt("image"),
      input: { type: "message", content: [{ type: "text", text: "look" }, image] },
    });
    expect(fake.requestsOfType("steer")).toEqual([
      { type: "steer", message: "look", images: [image] },
    ]);
    expect(result(events, "image")).toEqual({ type: "steer", turnId });
  });

  it("reports image omission for a text-only model", async () => {
    const { session, fake } = await harness();
    await session.prompt({
      ...prompt("image"),
      input: { type: "message", content: [{ type: "image", data: "YQ==", mimeType: "image/png" }] },
    });
    expect(fake.requestsOfType("steer")[0]?.message).toContain("The image was not analyzed");
    expect(fake.requestsOfType("steer")[0]?.images).toBeUndefined();
  });

  it("denies pending dialogs before accepting a clearPendingPermissions steer", async () => {
    const { session, fake, events, turnId } = await harness({
      onSteer() {
        expect(fake.sent).toContainEqual({
          type: "extension_ui_response",
          id: "permission",
          cancelled: true,
        });
      },
    });
    fake.emit({
      type: "extension_ui_request",
      id: "permission",
      method: "confirm",
      title: "Allow?",
      message: "Proceed?",
    });
    await session.prompt({ ...prompt("deny"), clearPendingPermissions: true });
    expect(ofType(events, "session.permission_resolved")).toHaveLength(1);
    expect(result(events, "deny")).toEqual({ type: "steer", turnId });
    expect(fake.requestsOfType("abort")).toHaveLength(0);
  });

  it("leaves pending dialogs alone unless clearing was requested", async () => {
    const { session, fake, events } = await harness();
    fake.emit({
      type: "extension_ui_request",
      id: "permission",
      method: "confirm",
      title: "Allow?",
      message: "Proceed?",
    });
    await session.prompt(prompt("keep"));
    expect(fake.sent).toHaveLength(0);
    expect(ofType(events, "session.permission_resolved")).toHaveLength(0);
  });

  it("fails steering if a requested permission denial cannot be written", async () => {
    const { session, fake, events } = await harness();
    fake.emit({
      type: "extension_ui_request",
      id: "permission",
      method: "confirm",
      title: "Allow?",
      message: "Proceed?",
    });
    vi.spyOn(fake, "send").mockRejectedValueOnce(new Error("denial failed"));
    await expect(
      session.prompt({ ...prompt("deny"), clearPendingPermissions: true }),
    ).rejects.toThrow("denial failed");
    expect(result(events, "deny").type).toBe("failed");
    expect(fake.requestsOfType("steer")).toHaveLength(0);
  });

  it("completes an input-handler-consumed steer and removes its unused echo binding", async () => {
    const { session, fake, events } = await harness({ steerDisposition: "handled" });
    echo(fake, "original", 1);
    await session.prompt(prompt("handled"));
    expect(result(events, "handled")).toEqual({ type: "completed" });
    echo(fake, "extension-owned message", 2);
    expect(ofType(events, "timeline.item").at(-1)?.item).not.toHaveProperty(
      "clientMessageId",
      "handled",
    );
    expect(ofType(events, "session.turn")).toHaveLength(1);
  });

  it("rejects a steer refused by Pi without breaking the original turn or later message IDs", async () => {
    const { session, fake, events, turnId } = await harness({
      onRequest(command) {
        if (command.type === "steer" && command.message === "refused")
          throw new Error("Pi refused");
      },
    });
    echo(fake, "original", 1);
    await expect(session.prompt(prompt("refused"))).rejects.toThrow("Pi refused");
    expect(result(events, "refused").type).toBe("failed");
    await session.prompt(prompt("accepted"));
    echo(fake, "accepted", 2);
    expect(result(events, "accepted")).toEqual({ type: "steer", turnId });
    expect(ofType(events, "timeline.item").at(-1)?.item).toMatchObject({
      clientMessageId: "accepted",
    });
  });

  it("fails and clears a queued steer when settlement beats its admission reply", async () => {
    const entered = gate();
    const reply = gate();
    const { session, fake, events } = await harness({
      async onRequest(command) {
        if (command.type === "steer") {
          entered.release();
          await reply.promise;
        }
      },
    });
    const pending = session.prompt(prompt("late")).catch((error: Error) => error);
    await entered.promise;
    await settled(fake, events);
    reply.release();
    expect(await pending).toMatchObject({
      message: expect.stringContaining("ended before the steer was accepted"),
    });
    expect(result(events, "late").type).toBe("failed");
    expect(fake.requestsOfType("clear_queue")).toHaveLength(1);
    expect(ofType(events, "session.turn")).toHaveLength(2);
  });

  it("rechecks the active turn after waiting for another serialized operation", async () => {
    const entered = gate();
    const configured = gate();
    const { session, fake, events } = await harness({
      async onRequest(command) {
        if (command.type === "set_thinking_level") {
          entered.release();
          await configured.promise;
        }
      },
    });
    const configuration = session.configure("thinking", { thinkingOption: "high" });
    await entered.promise;
    const steering = session.prompt(prompt("waiting")).catch((error: Error) => error);
    await settled(fake, events);
    configured.release();
    await configuration;
    expect(await steering).toMatchObject({
      message: expect.stringContaining("ended before the steer was sent"),
    });
    expect(result(events, "waiting").type).toBe("failed");
    expect(fake.requestsOfType("steer")).toHaveLength(0);
  });

  it("does not accept a pending steer after Stop clears the queue and aborts", async () => {
    const entered = gate();
    const reply = gate();
    const { session, events } = await harness({
      async onRequest(command) {
        if (command.type === "steer") {
          entered.release();
          await reply.promise;
        }
      },
    });
    const pending = session.prompt(prompt("stopped")).catch((error: Error) => error);
    await entered.promise;
    await session.interrupt("stop");
    reply.release();
    await pending;
    expect(result(events, "stopped").type).toBe("failed");
    expect(ofType(events, "session.turn").map((event) => event.state)).toEqual([
      "started",
      "canceled",
    ]);
  });

  it("purges already-admitted steering echo bindings on Stop even though they share the active turn ID", async () => {
    const { session, fake, events } = await harness();
    echo(fake, "original", 1);
    await session.prompt(prompt("discarded-1"));
    await session.prompt(prompt("discarded-2"));
    await session.interrupt("stop");
    await session.prompt(prompt("later", "auto"));
    echo(fake, "later", 2);
    expect(ofType(events, "timeline.item").at(-1)?.item).toMatchObject({
      clientMessageId: "later",
    });
  });

  it("fails a pending steer exactly once when the session closes before its reply", async () => {
    const entered = gate();
    const reply = gate();
    const { session, events } = await harness({
      async onRequest(command) {
        if (command.type === "steer") {
          entered.release();
          await reply.promise;
        }
      },
    });
    const pending = session.prompt(prompt("closed"));
    await entered.promise;
    await session.close();
    reply.release();
    await pending;
    expect(result(events, "closed").type).toBe("failed");
    expect(ofType(events, "session.turn").map((event) => event.state)).toEqual([
      "started",
      "canceled",
    ]);
  });

  it("preserves the original run's error stop reason when steering is queued", async () => {
    const { session, fake, events } = await harness();
    fake.emit({
      type: "message_end",
      message: { role: "assistant", timestamp: 1, content: [], stopReason: "error" },
    });
    await session.prompt(prompt("after-error"));
    await settled(fake, events);
    expect(ofType(events, "session.turn").at(-1)?.state).toBe("failed");
  });

  it("invalidates the runtime after an uncertain steer timeout instead of allowing duplicate retries", async () => {
    const { session, events } = await harness({
      onRequest(command) {
        if (command.type === "steer") throw new PiRpcTimeoutError("steer timed out");
      },
    });
    await expect(session.prompt(prompt("timeout"))).rejects.toThrow("steer timed out");
    expect(result(events, "timeout").type).toBe("failed");
    expect(ofType(events, "session.runtime_failed")).toHaveLength(1);
    await expect(session.prompt(prompt("retry"))).rejects.toThrow("not ready");
  });

  it("discards accepted steers that were never echoed when an extension ends the run", async () => {
    const { session, fake, events } = await harness();
    echo(fake, "original", 1);
    await session.prompt(prompt("undelivered"));
    fake.emit({
      type: "message_end",
      message: { role: "assistant", timestamp: 2, content: [], stopReason: "aborted" },
    });
    await settled(fake, events);
    expect(fake.requestsOfType("clear_queue")).toHaveLength(1);
    expect(ofType(events, "session.notice").at(-1)?.notice.title).toBe(
      "Queued steering was discarded",
    );
    expect(ofType(events, "session.turn").at(-1)?.state).toBe("canceled");
    await session.prompt(prompt("later", "auto"));
    echo(fake, "later", 3);
    expect(ofType(events, "timeline.item").at(-1)?.item).toMatchObject({
      clientMessageId: "later",
      text: "later",
    });
  });

  it("does not let extension-injected user messages steal queued plain-text steering IDs", async () => {
    const { session, fake, events } = await harness();
    echo(fake, "original", 1);
    await session.prompt(prompt("host-steer"));
    echo(fake, "extension-owned input", 2);
    const external = ofType(events, "timeline.item").at(-1)?.item;
    expect(external?.type).toBe("user_message");
    expect(external).not.toHaveProperty("clientMessageId");
    echo(fake, "host-steer", 3);
    expect(ofType(events, "timeline.item").at(-1)?.item).toMatchObject({
      clientMessageId: "host-steer",
    });
    await settled(fake, events);
    expect(fake.requestsOfType("clear_queue")).toHaveLength(0);
  });

  it("preserves a replacement prompt waiting behind late-steer queue cleanup", async () => {
    const entered = gate();
    const reply = gate();
    const { session, fake, events } = await harness({
      async onRequest(command) {
        if (command.type === "steer") {
          entered.release();
          await reply.promise;
        }
      },
    });
    echo(fake, "original", 1);
    const steering = session.prompt(prompt("late")).catch((error: Error) => error);
    await entered.promise;
    await settled(fake, events);
    const next = session.prompt(prompt("later", "auto"));
    reply.release();
    await steering;
    await next;
    echo(fake, "later", 2);
    expect(result(events, "late").type).toBe("failed");
    expect(result(events, "later").type).toBe("turn");
    expect(ofType(events, "timeline.item").at(-1)?.item).toMatchObject({
      clientMessageId: "later",
    });
  });

  it("orders settlement cleanup behind a pending steer and ahead of the next prompt without deadlocking", async () => {
    const entered = gate();
    const reply = gate();
    const { session, fake, events } = await harness({
      async onRequest(command) {
        if (command.type === "steer" && command.message === "pending") {
          entered.release();
          await reply.promise;
        }
      },
    });
    echo(fake, "original", 1);
    await session.prompt(prompt("accepted-but-undelivered"));
    const pending = session.prompt(prompt("pending")).catch((error: Error) => error);
    await entered.promise;
    fake.emit({ type: "agent_settled" });
    const next = session.prompt(prompt("later", "auto"));
    reply.release();
    await pending;
    await next;
    expect(fake.requestsOfType("clear_queue")).toHaveLength(1);
    expect(ofType(events, "session.notice").at(-1)?.notice.title).toBe(
      "Queued steering was discarded",
    );
    expect(ofType(events, "session.turn").map((event) => event.state)).toEqual([
      "started",
      "completed",
      "started",
    ]);
    echo(fake, "later", 2);
    expect(ofType(events, "timeline.item").at(-1)?.item).toMatchObject({
      clientMessageId: "later",
    });
  });

  it("invalidates the runtime if end-of-turn queue cleanup fails", async () => {
    const { session, fake, events } = await harness({
      onRequest(command) {
        if (command.type === "clear_queue") throw new Error("queue state unknown");
      },
    });
    echo(fake, "original", 1);
    await session.prompt(prompt("undelivered"));
    fake.emit({ type: "agent_settled" });
    await vi.waitFor(() => expect(ofType(events, "session.runtime_failed")).toHaveLength(1));
    await expect(session.prompt(prompt("later", "auto"))).rejects.toThrow("not ready");
    expect(ofType(events, "session.turn").at(-1)?.state).toBe("failed");
  });

  it("rejects a malformed started disposition for steer without inventing a second turn", async () => {
    const { session, fake, events } = await harness();
    const request = fake.request.bind(fake);
    vi.spyOn(fake, "request").mockImplementation(async (command) =>
      command.type === "steer" ? { disposition: "started" } : request(command),
    );
    await expect(session.prompt(prompt("invalid"))).rejects.toThrow(
      "Unsupported Pi steer disposition",
    );
    expect(result(events, "invalid").type).toBe("failed");
    expect(ofType(events, "session.turn")).toHaveLength(1);
  });
});
