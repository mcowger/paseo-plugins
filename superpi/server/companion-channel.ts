import { randomUUID } from "node:crypto";
import { companionPrefix, companionReplySchema, type CompanionOperation } from "../shared/companion.js";

interface RpcTransport {
  request(command: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  onRecord(listener: (record: Record<string, unknown>) => void): () => void;
}

export function createCompanionChannel(rpc: RpcTransport, sessionKey: string, timeoutMs = 15_000) {
  const pending = new Map<string, {
    operation: CompanionOperation;
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let closed = false;
  const remove = rpc.onRecord((record) => {
    if (record.type !== "extension_ui_request" || record.method !== "notify"
      || typeof record.message !== "string" || !record.message.startsWith(companionPrefix)) return;
    let json: unknown;
    try { json = JSON.parse(record.message.slice(companionPrefix.length)); } catch { return; }
    const parsed = companionReplySchema.safeParse(json);
    if (!parsed.success || parsed.data.sessionKey !== sessionKey) return;
    const reply = parsed.data;
    const waiter = pending.get(reply.requestId);
    if (!waiter || waiter.operation !== reply.operation) return;
    pending.delete(reply.requestId);
    clearTimeout(waiter.timer);
    if (reply.ok) waiter.resolve(reply.data);
    else waiter.reject(new Error(reply.error ?? "Companion operation failed"));
  });
  return {
    async verify(): Promise<void> {
      const result = await rpc.request({ type: "get_commands" }) as { commands?: Array<{ name?: string }> };
      if (!result?.commands?.some((command) => command.name === "superpi-control")) {
        throw new Error("The required Superpi companion did not load. Check the explicit extension path and Pi extension diagnostics.");
      }
    },
    async request(operation: CompanionOperation, data?: unknown): Promise<unknown> {
      if (closed) throw new Error("Companion channel is closed");
      const requestId = randomUUID();
      let rejectReply!: (error: Error) => void;
      const reply = new Promise<unknown>((resolve, reject) => {
        rejectReply = reject;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Superpi companion ${operation} timed out; its outcome may be uncertain`));
        }, timeoutMs);
        pending.set(requestId, { operation, resolve, reject, timer });
      });
      const encoded = Buffer.from(JSON.stringify({ version: 1, sessionKey, requestId, operation, data })).toString("base64url");
      const admission = rpc.request({ type: "prompt", message: `/superpi-control ${encoded}` }, timeoutMs)
        .then((result) => {
          if ((result as { disposition?: string })?.disposition !== "handled") {
            throw new Error("Superpi companion command was not handled; refusing to treat it as a chat turn");
          }
        }).catch((error: unknown) => {
          rejectReply(error instanceof Error ? error : new Error(String(error)));
          throw error;
        });
      try { return (await Promise.all([reply, admission]))[0]; }
      finally {
        const waiter = pending.get(requestId);
        if (waiter) clearTimeout(waiter.timer);
        pending.delete(requestId);
      }
    },
    close(reason = new Error("Companion channel closed")): void {
      if (closed) return;
      closed = true;
      remove();
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(reason); }
      pending.clear();
    },
  };
}
