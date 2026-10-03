import { afterEach, describe, expect, test, vi } from "vitest";
import { ProviderEventSchema, type ProviderEvent } from "@getpaseo/plugin/server/provider";
import { createDialogBridge, createDialogRegistry, isBlockingDialogRequest, parseNativeDialog } from "./dialogs";
import { dialogAnswerSchema, dialogViewSchema, initialDialogDraft } from "../shared/dialogs.js";

function harness(generation?: string) {
  const events: ProviderEvent[] = [];
  const sent: Record<string, unknown>[] = [];
  const bridge = createDialogBridge({
    sessionId: "session-1",
    rpc: {
      send: async (record) => {
        sent.push(record);
      },
    },
    emit: (event) => events.push(event),
    ...(generation ? { generation } : {}),
  });
  const permissions = () =>
    events.filter((event) => event.type === "session.permission").map((event) => event.request);
  const resolved = () =>
    events.filter((event) => event.type === "session.permission_resolved").map((event) => event.permissionId);
  return { bridge, events, sent, permissions, resolved };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseNativeDialog", () => {
  test("accepts supported blocking dialogs and rejects fire-and-forget or malformed records", () => {
    expect(
      parseNativeDialog({ type: "extension_ui_request", id: "d1", method: "select", title: "Pick", options: ["A"] }),
    ).toMatchObject({ method: "select" });
    expect(
      parseNativeDialog({ type: "extension_ui_request", id: "d2", method: "notify", message: "hi" }),
    ).toBeNull();
    expect(
      parseNativeDialog({ type: "extension_ui_request", id: "d3", method: "setStatus", statusKey: "k" }),
    ).toBeNull();
    expect(parseNativeDialog({ type: "extension_ui_request", id: "d4", method: "select", title: "x", options: [] })).toBeNull();
    expect(parseNativeDialog({ type: "response", command: "prompt" })).toBeNull();
    expect(isBlockingDialogRequest({ type: "extension_ui_request", id: "d5", method: "editor", title: "Edit" })).toBe(true);
  });
});

describe("shared dialog contract", () => {
  test("seeds an editor draft from prefill and leaves input empty", () => {
    const editor = dialogViewSchema.parse({
      permissionId: "e1",
      sessionId: "s1",
      method: "editor",
      title: "Message",
      prefill: "draft",
    });
    const input = dialogViewSchema.parse({
      permissionId: "i1",
      sessionId: "s1",
      method: "input",
      title: "Name",
      placeholder: "hint",
    });
    expect(initialDialogDraft(editor)).toBe("draft");
    expect(initialDialogDraft(input)).toBe("");
  });

  test("parses allow and deny answers", () => {
    expect(dialogAnswerSchema.parse({ behavior: "allow", value: true })).toEqual({ behavior: "allow", value: true });
    expect(dialogAnswerSchema.parse({ behavior: "deny" })).toEqual({ behavior: "deny" });
    expect(dialogAnswerSchema.safeParse({ behavior: "allow" }).success).toBe(false);
  });
});

describe("createDialogBridge accept", () => {
  test("maps select to a supported question permission with native id and metadata", () => {
    const { bridge, permissions, events } = harness("gen-1");
    const accepted = bridge.accept({
      type: "extension_ui_request",
      id: "dialog-1",
      method: "select",
      title: "Allow this call?",
      options: ["Allow", "Block"],
      timeout: 10000,
    });
    expect(accepted).toBe(true);
    const [request] = permissions();
    expect(request).toMatchObject({
      id: "dialog-1",
      name: "select",
      kind: "question",
      title: "Allow this call?",
    });
    expect(request.input).toEqual({
      questions: [
        {
          question: "Allow this call?",
          header: "Allow this call?",
          options: [{ label: "Allow" }, { label: "Block" }],
          multiSelect: false,
          allowOther: false,
          allowEmpty: false,
        },
      ],
    });
    expect(request.metadata).toMatchObject({
      superpiDialog: { method: "select", nativeId: "dialog-1", options: ["Allow", "Block"], timeoutMs: 10000, generation: "gen-1" },
    });
    for (const event of events) expect(() => ProviderEventSchema.parse(event)).not.toThrow();
  });

  test("maps confirm and input without inventing fields", () => {
    const { bridge, permissions } = harness();
    bridge.accept({ type: "extension_ui_request", id: "c1", method: "confirm", title: "Proceed?", message: "Apply changes", timeout: 500 });
    bridge.accept({ type: "extension_ui_request", id: "i1", method: "input", title: "Name", placeholder: "type here", timeout: 500 });
    const [confirm, input] = permissions();
    expect(confirm.description).toBe("Apply changes");
    expect(confirm.input).toMatchObject({
      questions: [{ options: [{ label: "Confirm" }, { label: "Cancel" }] }],
    });
    expect(input.input).toMatchObject({ questions: [{ options: [], placeholder: "type here", allowEmpty: false }] });
    expect((input.metadata as { superpiDialog: Record<string, unknown> }).superpiDialog.placeholder).toBe("type here");
  });

  test("retains editor prefill in metadata and the plugin view but not as a real generic value", () => {
    const { bridge, permissions } = harness();
    expect(bridge.accept({ type: "extension_ui_request", id: "e1", method: "editor", title: "Message", prefill: "draft body" })).toBe(true);
    const [request] = permissions();
    expect((request.metadata as { superpiDialog: Record<string, unknown> }).superpiDialog).toMatchObject({
      method: "editor",
      nativeId: "e1",
      prefill: "draft body",
    });
    expect(request.input).toMatchObject({ questions: [{ placeholder: "draft body" }] });
    expect(bridge.list()).toEqual([
      {
        permissionId: "e1",
        sessionId: "session-1",
        method: "editor",
        title: "Message",
        prefill: "draft body",
      },
    ]);
  });

  test("does not consume notifications, companion envelopes, or duplicates", () => {
    const { bridge, permissions } = harness();
    expect(bridge.accept({ type: "extension_ui_request", id: "n1", method: "notify", message: "superpi:v1:hello" })).toBe(false);
    expect(bridge.accept({ type: "extension_ui_request", id: "t1", method: "set_editor_text", text: "x" })).toBe(false);
    expect(bridge.accept({ type: "extension_ui_request", id: "s1", method: "select", title: "Pick", options: ["A"] })).toBe(true);
    expect(bridge.accept({ type: "extension_ui_request", id: "s1", method: "select", title: "Pick", options: ["A"] })).toBe(false);
    expect(permissions()).toHaveLength(1);
  });
});

describe("createDialogBridge respond", () => {
  test("maps select answers to native value records", async () => {
    const { bridge, sent, resolved } = harness();
    bridge.accept({ type: "extension_ui_request", id: "s1", method: "select", title: "Allow this call?", options: ["Allow", "Block"] });
    await bridge.respond("s1", {
      behavior: "allow",
      updatedInput: { answers: { "Allow this call?": "Allow" } },
    });
    expect(sent).toEqual([{ type: "extension_ui_response", id: "s1", value: "Allow" }]);
    expect(resolved()).toEqual(["s1"]);
  });

  test("maps confirm answers to a native confirmed boolean", async () => {
    const { bridge, sent } = harness();
    bridge.accept({ type: "extension_ui_request", id: "c1", method: "confirm", title: "Proceed?", message: "Apply" });
    await bridge.respond("c1", { behavior: "allow", updatedInput: { answers: { "Proceed?": "Confirm" } } });
    expect(sent).toEqual([{ type: "extension_ui_response", id: "c1", confirmed: true }]);
  });

  test("keeps an explicit empty input submission", async () => {
    const { bridge, sent } = harness();
    bridge.accept({ type: "extension_ui_request", id: "i1", method: "input", title: "Name", placeholder: "x" });
    await bridge.respond("i1", { behavior: "allow", updatedInput: { answers: { Name: "" } } });
    expect(sent).toEqual([{ type: "extension_ui_response", id: "i1", value: "" }]);
  });

  test("maps deny and invalid select values to cancel", async () => {
    const { bridge, sent, resolved } = harness();
    bridge.accept({ type: "extension_ui_request", id: "s2", method: "select", title: "Pick", options: ["A"] });
    await bridge.respond("s2", { behavior: "deny", message: "no" });
    bridge.accept({ type: "extension_ui_request", id: "s3", method: "select", title: "Pick", options: ["A"] });
    await bridge.respond("s3", { behavior: "allow", updatedInput: { answers: { Pick: "Not an option" } } });
    expect(sent).toEqual([
      { type: "extension_ui_response", id: "s2", cancelled: true },
      { type: "extension_ui_response", id: "s3", cancelled: true },
    ]);
    expect(resolved()).toEqual(["s2", "s3"]);
  });

  test("ignores unknown, late, and already-answered permissions", async () => {
    const { bridge, sent } = harness();
    await bridge.respond("missing", { behavior: "allow", updatedInput: {} });
    bridge.accept({ type: "extension_ui_request", id: "s4", method: "input", title: "T", placeholder: "p" });
    await bridge.respond("s4", { behavior: "allow", updatedInput: { answers: { T: "one" } } });
    await bridge.respond("s4", { behavior: "allow", updatedInput: { answers: { T: "two" } } });
    expect(sent).toEqual([{ type: "extension_ui_response", id: "s4", value: "one" }]);
  });

  test("supports the plugin editor answer path", async () => {
    const { bridge, sent } = harness();
    bridge.accept({ type: "extension_ui_request", id: "e2", method: "editor", title: "Message", prefill: "body" });
    expect(await bridge.answer("e2", { behavior: "allow", value: "body edited" })).toBe(true);
    expect(await bridge.answer("e2", { behavior: "deny" })).toBe(false);
    expect(sent).toEqual([{ type: "extension_ui_response", id: "e2", value: "body edited" }]);
  });
});

describe("createDialogRegistry", () => {
  test("aggregates pending dialogs and routes answers to the owning bridge", async () => {
    const registry = createDialogRegistry();
    const sent: Record<string, unknown>[] = [];
    const bridge = createDialogBridge({
      sessionId: "session-1",
      rpc: { send: async (record) => { sent.push(record); } },
      emit: () => {},
    });
    const remove = registry.register("session-1", bridge);
    bridge.accept({ type: "extension_ui_request", id: "r1", method: "input", title: "Name", placeholder: "p" });
    expect(registry.list()).toHaveLength(1);
    expect(await registry.answer("session-1", "r1", { behavior: "allow", value: "Ada" })).toBe(true);
    expect(sent).toEqual([{ type: "extension_ui_response", id: "r1", value: "Ada" }]);
    expect(await registry.answer("other", "r1", { behavior: "deny" })).toBe(false);
    remove();
    expect(registry.list()).toEqual([]);
  });
});

describe("createDialogBridge timeouts and close", () => {
  test("interrupt cancels pending dialogs without disabling later dialogs", async () => {
    const { bridge, sent } = harness();
    bridge.accept({ type: "extension_ui_request", id: "editor-old", method: "editor", title: "Old" });
    await bridge.cancelAll();
    expect(sent).toEqual([{ type: "extension_ui_response", id: "editor-old", cancelled: true }]);
    expect(bridge.accept({ type: "extension_ui_request", id: "editor-new", method: "editor", title: "New" })).toBe(true);
    await bridge.close();
  });
  test("cancels malformed blocking dialogs rather than leaving Pi waiting", async () => {
    const { bridge, sent, events } = harness();
    expect(bridge.accept({ type: "extension_ui_request", id: "bad-select", method: "select", title: "Pick", options: [] })).toBe(true);
    await Promise.resolve();
    expect(sent).toEqual([{ type: "extension_ui_response", id: "bad-select", cancelled: true }]);
    expect(events.some((event) => event.type === "timeline.item" && event.item.type === "notification" && event.item.level === "error")).toBe(true);
  });
  test("expires a supplied timeout without sending a response", async () => {
    vi.useFakeTimers();
    const { bridge, sent, resolved } = harness();
    bridge.accept({ type: "extension_ui_request", id: "t1", method: "select", title: "Pick", options: ["A"], timeout: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved()).toEqual(["t1"]);
    expect(sent).toEqual([]);
    await bridge.respond("t1", { behavior: "allow", updatedInput: { answers: { Pick: "A" } } });
    expect(sent).toEqual([]);
  });

  test("never invents a timeout for editor", async () => {
    vi.useFakeTimers();
    const { bridge, resolved } = harness();
    bridge.accept({ type: "extension_ui_request", id: "e3", method: "editor", title: "Message", prefill: "x" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolved()).toEqual([]);
  });

  test("close settles pending dialogs once and makes later calls safe", async () => {
    const { bridge, events, sent } = harness();
    bridge.accept({ type: "extension_ui_request", id: "a", method: "input", title: "A", placeholder: "p" });
    bridge.accept({ type: "extension_ui_request", id: "b", method: "confirm", title: "B", message: "m" });
    await bridge.close();
    await bridge.close();
    const resolved = events.filter((event) => event.type === "session.permission_resolved");
    expect(resolved.map((event) => event.permissionId).sort()).toEqual(["a", "b"]);
    expect(bridge.list()).toEqual([]);
    expect(await bridge.answer("a", { behavior: "allow", value: "x" })).toBe(false);
    await bridge.respond("b", { behavior: "allow", updatedInput: {} });
    expect(sent).toEqual([
      { type: "extension_ui_response", id: "a", cancelled: true },
      { type: "extension_ui_response", id: "b", cancelled: true },
    ]);
  });
});
