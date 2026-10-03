import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  ProviderEvent,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import type { DialogAnswer, DialogView } from "../shared/dialogs.js";

/**
 * Native Pi extension-UI dialog bridge.
 *
 * Pi emits `extension_ui_request` records for blocking `select`, `confirm`,
 * `input`, and `editor` dialogs and resolves them from `extension_ui_response`
 * records keyed only by the native dialog id. This bridge maps those records onto
 * the public provider permission contract (`session.permission`) and maps
 * responses back to native records.
 *
 * Boundary decisions:
 *
 * - `accept` consumes only blocking dialogs. `notify`, status/widget/title
 *   records, companion `superpi:v1:` envelopes, and anything unknown return
 *   `false` so the root can route them through its ordinary notification path.
 * - Timeouts are honored only when Pi supplies a `timeout`. Editor has no
 *   timeout field, so no timer is invented for it. When a timer fires the host
 *   card is resolved and no response is sent: Pi already resolved the dialog to
 *   its own default locally.
 * - Late, duplicate, or stale replies are safe no-ops. `close` settles every
 *   pending card and is idempotent.
 * - This bridge makes no MCP/tool-policy decision; answering a dialog is not a
 *   permission-policy translation.
 */

const CONFIRM_LABEL = "Confirm";
const CANCEL_LABEL = "Cancel";

const selectDialogSchema = z.object({
  type: z.literal("extension_ui_request"),
  id: z.string().min(1),
  method: z.literal("select"),
  title: z.string(),
  options: z.array(z.string().min(1)).min(1),
  timeout: z.number().positive().optional(),
});

const confirmDialogSchema = z.object({
  type: z.literal("extension_ui_request"),
  id: z.string().min(1),
  method: z.literal("confirm"),
  title: z.string(),
  message: z.string(),
  timeout: z.number().positive().optional(),
});

const inputDialogSchema = z.object({
  type: z.literal("extension_ui_request"),
  id: z.string().min(1),
  method: z.literal("input"),
  title: z.string(),
  placeholder: z.string().optional(),
  timeout: z.number().positive().optional(),
});

const editorDialogSchema = z.object({
  type: z.literal("extension_ui_request"),
  id: z.string().min(1),
  method: z.literal("editor"),
  title: z.string(),
  prefill: z.string().optional(),
});

const nativeDialogSchema = z.union([
  selectDialogSchema,
  confirmDialogSchema,
  inputDialogSchema,
  editorDialogSchema,
]);

export type NativeDialog = z.infer<typeof nativeDialogSchema>;

/** Parse a raw record as a supported blocking dialog, or return null. */
export function parseNativeDialog(record: unknown): NativeDialog | null {
  const result = nativeDialogSchema.safeParse(record);
  return result.success ? result.data : null;
}

/** True for records this bridge is responsible for consuming. */
export function isBlockingDialogRequest(record: unknown): boolean {
  return parseNativeDialog(record) !== null;
}

type NativeAnswer =
  | {
      behavior: "allow";
      value: string | boolean;
    }
  | {
      behavior: "deny";
    };

export interface CreateDialogBridgeInput {
  sessionId: string;
  /** Writes a raw Pi record (for example `extension_ui_response`). */
  rpc: { send(record: Record<string, unknown>): Promise<void> };
  emit: (event: ProviderEvent) => void;
  /** Runtime generation tag carried onto emitted permission requests. */
  generation?: string;
}

export interface DialogBridge {
  accept(record: unknown): boolean;
  respond(permissionId: string, response: ProviderPermissionResponse): Promise<void>;
  /** Pending dialogs for the plugin editor surface. */
  list(): DialogView[];
  /** Resolve a dialog from the plugin editor surface. */
  answer(permissionId: string, answer: DialogAnswer): Promise<boolean>;
  cancelAll(): Promise<void>;
  close(): Promise<void>;
}

interface PendingDialog {
  dialog: NativeDialog;
  view: DialogView;
  timer: ReturnType<typeof setTimeout> | null;
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function questionFor(dialog: NativeDialog): Record<string, unknown> {
  if (dialog.method === "select") {
    return {
      question: dialog.title,
      header: dialog.title,
      options: dialog.options.map((label) => ({ label })),
      multiSelect: false,
      allowOther: false,
      allowEmpty: false,
    };
  }
  if (dialog.method === "confirm") {
    return {
      question: dialog.message.length > 0 ? dialog.message : dialog.title,
      header: dialog.title,
      options: [{ label: CONFIRM_LABEL }, { label: CANCEL_LABEL }],
      multiSelect: false,
      allowOther: false,
      allowEmpty: false,
    };
  }
  // input and editor: no fixed options, so the generic card shows its text field.
  // `allowEmpty: false` keeps the card's dismiss button mapped to a real cancel
  // instead of an ambiguous empty submission; the plugin editor still allows an
  // explicit empty value through `answer`.
  return {
    question: dialog.title,
    header: dialog.title,
    options: [],
    multiSelect: false,
    allowEmpty: false,
    ...(dialog.method === "editor" && dialog.prefill !== undefined
      ? { placeholder: dialog.prefill }
      : {}),
    ...(dialog.method === "input" && dialog.placeholder !== undefined
      ? { placeholder: dialog.placeholder }
      : {}),
  };
}

function buildPermissionRequest(dialog: NativeDialog, generation?: string): ProviderPermissionRequest {
  const request: Record<string, unknown> = {
    id: dialog.id,
    name: dialog.method,
    kind: "question",
    title: dialog.title,
    input: toJson({ questions: [questionFor(dialog)] }),
    metadata: toJson({
      superpiDialog: {
        method: dialog.method,
        nativeId: dialog.id,
        ...(dialog.method === "select" ? { options: dialog.options } : {}),
        ...(dialog.method === "input" && dialog.placeholder !== undefined
          ? { placeholder: dialog.placeholder }
          : {}),
        ...(dialog.method === "editor" && dialog.prefill !== undefined
          ? { prefill: dialog.prefill }
          : {}),
        ...(dialog.method === "confirm" ? { confirmLabel: CONFIRM_LABEL } : {}),
        ...("timeout" in dialog && dialog.timeout !== undefined ? { timeoutMs: dialog.timeout } : {}),
        ...(generation ? { generation } : {}),
      },
    }),
  };
  if (dialog.method === "confirm") {
    request.description = dialog.message;
  }
  return request as unknown as ProviderPermissionRequest;
}

function buildView(dialog: NativeDialog, sessionId: string, generation?: string): DialogView {
  return {
    permissionId: dialog.id,
    sessionId,
    method: dialog.method,
    title: dialog.title,
    ...(dialog.method === "confirm" ? { message: dialog.message } : {}),
    ...(dialog.method === "select" ? { options: dialog.options } : {}),
    ...(dialog.method === "input" && dialog.placeholder !== undefined
      ? { placeholder: dialog.placeholder }
      : {}),
    ...(dialog.method === "editor" && dialog.prefill !== undefined
      ? { prefill: dialog.prefill }
      : {}),
    ...(dialog.method === "confirm" ? { confirmLabel: CONFIRM_LABEL } : {}),
    ...("timeout" in dialog && dialog.timeout !== undefined ? { timeoutMs: dialog.timeout } : {}),
    ...(generation ? { generation } : {}),
  };
}

function nativeResponse(dialog: NativeDialog, answer: NativeAnswer): Record<string, unknown> {
  const base = { type: "extension_ui_response", id: dialog.id } as const;
  if (answer.behavior === "deny") {
    return { ...base, cancelled: true };
  }
  if (dialog.method === "select") {
    if (typeof answer.value === "string" && dialog.options.includes(answer.value)) {
      return { ...base, value: answer.value };
    }
    return { ...base, cancelled: true };
  }
  if (dialog.method === "confirm") {
    const confirmed =
      answer.value === true ||
      answer.value === "true" ||
      answer.value === CONFIRM_LABEL;
    return { ...base, confirmed };
  }
  if (typeof answer.value === "string") {
    return { ...base, value: answer.value };
  }
  return { ...base, cancelled: true };
}

function readHostValue(
  updatedInput: Readonly<Record<string, JsonValue>> | undefined,
  header: string,
): string | boolean | undefined {
  if (!updatedInput) return undefined;
  const answers = updatedInput.answers;
  if (answers && typeof answers === "object" && !Array.isArray(answers)) {
    const value = (answers as Record<string, unknown>)[header];
    if (typeof value === "string" || typeof value === "boolean") return value;
  }
  const direct = updatedInput[header];
  if (typeof direct === "string" || typeof direct === "boolean") return direct;
  const generic = updatedInput.value;
  if (typeof generic === "string" || typeof generic === "boolean") return generic;
  return undefined;
}

export interface DialogRegistry {
  /** Register a session bridge; returns an idempotent removal function. */
  register(sessionId: string, bridge: DialogBridge): () => void;
  /** Every pending dialog across registered sessions, for the plugin UI. */
  list(): DialogView[];
  /** Route a plugin UI answer to the owning session bridge. */
  answer(sessionId: string, permissionId: string, answer: DialogAnswer): Promise<boolean>;
}

/**
 * Aggregates per-session bridges for the plugin RPC surface. Root owns the
 * lifetime: register on session open, unregister on close.
 */
export function createDialogRegistry(): DialogRegistry {
  const bridges = new Map<string, DialogBridge>();
  return {
    register(sessionId, bridge) {
      bridges.set(sessionId, bridge);
      return () => {
        if (bridges.get(sessionId) === bridge) bridges.delete(sessionId);
      };
    },
    list() {
      return [...bridges.values()].flatMap((bridge) => bridge.list());
    },
    async answer(sessionId, permissionId, answer) {
      return (await bridges.get(sessionId)?.answer(permissionId, answer)) ?? false;
    },
  };
}

export function createDialogBridge(input: CreateDialogBridgeInput): DialogBridge {
  const { sessionId, rpc, emit, generation } = input;
  const pending = new Map<string, PendingDialog>();
  let closed = false;
  let closing: Promise<void> | null = null;
  const invalidWrites = new Set<Promise<void>>();

  function emitResolved(permissionId: string): void {
    emit({ type: "session.permission_resolved", sessionId, permissionId });
  }

  function clearPending(permissionId: string): PendingDialog | undefined {
    const entry = pending.get(permissionId);
    if (!entry) return undefined;
    if (entry.timer) clearTimeout(entry.timer);
    pending.delete(permissionId);
    return entry;
  }

  async function resolveNative(permissionId: string, answer: NativeAnswer): Promise<boolean> {
    const entry = clearPending(permissionId);
    if (!entry) return false;
    try {
      await rpc.send(nativeResponse(entry.dialog, answer));
    } finally {
      emitResolved(permissionId);
    }
    return true;
  }

  async function cancelAll(): Promise<void> {
    const results = await Promise.allSettled([...pending.keys()].map((id) => resolveNative(id, { behavior: "deny" })));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  return {
    accept(record: unknown): boolean {
      if (closed) return false;
      const dialog = parseNativeDialog(record);
      if (!dialog) {
        const raw = record as Record<string, unknown> | null;
        if (!raw || raw.type !== "extension_ui_request" || typeof raw.id !== "string"
          || !["select", "confirm", "input", "editor"].includes(String(raw.method))) return false;
        emit({ type: "timeline.item", sessionId, item: {
          type: "notification", id: `invalid-dialog:${raw.id}`, level: "error",
          message: "Pi sent a malformed blocking dialog. Sending a cancellation response.",
        } });
        const write = rpc.send({ type: "extension_ui_response", id: raw.id, cancelled: true }).catch(() => {
          emit({ type: "timeline.item", sessionId, item: {
            type: "notification", id: `invalid-dialog-cancel:${raw.id}`, level: "error",
            message: "The malformed Pi dialog could not be canceled because its connection failed.",
          } });
        });
        invalidWrites.add(write);
        void write.finally(() => invalidWrites.delete(write));
        return true;
      }
      if (pending.has(dialog.id)) return false;

      const timer =
        "timeout" in dialog && dialog.timeout !== undefined
          ? setTimeout(() => {
              if (!clearPending(dialog.id)) return;
              emitResolved(dialog.id);
            }, dialog.timeout)
          : null;
      timer?.unref?.();

      pending.set(dialog.id, {
        dialog,
        view: buildView(dialog, sessionId, generation),
        timer,
      });
      emit({
        type: "session.permission",
        sessionId,
        request: buildPermissionRequest(dialog, generation),
      });
      return true;
    },

    async respond(permissionId: string, response: ProviderPermissionResponse): Promise<void> {
      if (closed) return;
      const entry = pending.get(permissionId);
      if (!entry) return;
      if (response.behavior !== "allow") {
        await resolveNative(permissionId, { behavior: "deny" });
        return;
      }
      const value = readHostValue(response.updatedInput, entry.dialog.title);
      if (value === undefined) {
        await resolveNative(permissionId, { behavior: "deny" });
        return;
      }
      await resolveNative(permissionId, { behavior: "allow", value });
    },

    list(): DialogView[] {
      return [...pending.values()].map((entry) => entry.view);
    },

    async answer(permissionId: string, answer: DialogAnswer): Promise<boolean> {
      if (closed) return false;
      if (!pending.has(permissionId)) return false;
      if (answer.behavior === "deny") {
        return resolveNative(permissionId, { behavior: "deny" });
      }
      return resolveNative(permissionId, { behavior: "allow", value: answer.value });
    },

    cancelAll,

    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await Promise.all([...invalidWrites, cancelAll()]);
      })();
      return closing;
    },
  };
}
