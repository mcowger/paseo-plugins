import { randomUUID } from "node:crypto";
import {
  CONTROL_COMMAND_NAME,
  type ControlOperation,
  controlReplyPrefix,
  controlReplySchema,
} from "../shared/control.js";

interface RpcTransport {
  request(command: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  onRecord(listener: (record: Record<string, unknown>) => void): () => void;
}

export function createControlChannel(rpc: RpcTransport, sessionKey: string, timeoutMs = 15_000) {
  const pending = new Map<
    string,
    {
      operation: ControlOperation;
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let closed = false;
  const remove = rpc.onRecord((record) => {
    if (
      record.type !== "extension_ui_request" ||
      record.method !== "notify" ||
      typeof record.message !== "string" ||
      !record.message.startsWith(controlReplyPrefix)
    )
      return;
    let json: unknown;
    try {
      json = JSON.parse(record.message.slice(controlReplyPrefix.length));
    } catch {
      return;
    }
    const parsed = controlReplySchema.safeParse(json);
    if (!parsed.success || parsed.data.sessionKey !== sessionKey) return;
    const reply = parsed.data;
    const waiter = pending.get(reply.requestId);
    if (!waiter || waiter.operation !== reply.operation) return;
    pending.delete(reply.requestId);
    clearTimeout(waiter.timer);
    if (reply.ok) waiter.resolve(reply.data);
    else waiter.reject(new Error(reply.error ?? "PlexusPi control operation failed"));
  });
  return {
    async verify(): Promise<void> {
      const result = (await rpc.request({ type: "get_commands" })) as {
        commands?: Array<{ name?: string }>;
      };
      if (!result?.commands?.some((command) => command.name === CONTROL_COMMAND_NAME)) {
        throw new Error(
          `PlexusPi control command /${CONTROL_COMMAND_NAME} is not available. Install or update the plexus-pi extension in Pi and check Pi's extension diagnostics.`,
        );
      }
    },
    async request(operation: ControlOperation, data?: unknown): Promise<unknown> {
      if (closed) throw new Error("Control channel is closed");
      const requestId = randomUUID();
      let rejectReply!: (error: Error) => void;
      const reply = new Promise<unknown>((resolve, reject) => {
        rejectReply = reject;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(
            new Error(`PlexusPi control ${operation} timed out; its outcome may be uncertain`),
          );
        }, timeoutMs);
        pending.set(requestId, { operation, resolve, reject, timer });
      });
      const encoded = Buffer.from(
        JSON.stringify({ version: 1, sessionKey, requestId, operation, data }),
      ).toString("base64url");
      const admission = rpc
        .request({ type: "prompt", message: `/${CONTROL_COMMAND_NAME} ${encoded}` }, timeoutMs)
        .then((result) => {
          if ((result as { disposition?: string })?.disposition !== "handled") {
            throw new Error(
              "PlexusPi control command was not handled; refusing to treat it as a chat turn",
            );
          }
        })
        .catch((error: unknown) => {
          rejectReply(error instanceof Error ? error : new Error(String(error)));
          throw error;
        });
      try {
        return (await Promise.all([reply, admission]))[0];
      } finally {
        const waiter = pending.get(requestId);
        if (waiter) clearTimeout(waiter.timer);
        pending.delete(requestId);
      }
    },
    close(reason = new Error("Control channel closed")): void {
      if (closed) return;
      closed = true;
      remove();
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(reason);
      }
      pending.clear();
    },
  };
}
