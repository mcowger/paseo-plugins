import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";

export interface PolicyIdentity { provider: string; modelId: string }
export interface PolicySnapshot<Policy extends PolicyIdentity> {
  publisherId: string;
  revision: number;
  requestId?: string;
  status: "ready" | "loading" | "unavailable";
  policies: Policy[];
}
interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, listener: (data: unknown) => void): () => void;
}

export function createPolicyConsumer<Policy extends PolicyIdentity>(bus: EventBus, requestChannel: string, snapshotChannel: string, schema: ZodType<PolicySnapshot<Policy>>, onChange: () => void) {
  let snapshot: PolicySnapshot<Policy> | undefined;
  let pending: { id: string; promise: Promise<void>; finish(): void } | undefined;
  let closed = false;
  const retired = new Set<string>();

  function request(): Promise<void> {
    if (closed) return Promise.resolve();
    if (pending) return pending.promise;
    const id = randomUUID();
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const timer = setTimeout(() => { pending = undefined; resolve(); }, 1000);
    pending = { id, promise, finish() { clearTimeout(timer); pending = undefined; resolve(); } };
    bus.emit(requestChannel, { version: 1, requestId: id });
    return promise;
  }

  const unsubscribe = bus.on(snapshotChannel, (data) => {
    if (closed) return;
    try { if (Buffer.byteLength(JSON.stringify(data)) > 1024 * 1024) return; } catch { return; }
    const parsed = schema.safeParse(data);
    if (!parsed.success) return;
    const next = parsed.data;
    const correlated = next.requestId !== undefined && next.requestId === pending?.id;
    if (next.requestId !== undefined && !correlated) return;
    if (retired.has(next.publisherId)) return;
    if (next.publisherId !== snapshot?.publisherId && !correlated) { void request(); return; }
    if (snapshot?.publisherId === next.publisherId && next.revision <= snapshot.revision) {
      if (correlated) pending?.finish();
      return;
    }
    if (snapshot && next.publisherId !== snapshot.publisherId) retired.add(snapshot.publisherId);
    snapshot = next;
    if (correlated) pending?.finish();
    onChange();
  });

  return {
    request,
    status() { return snapshot?.status; },
    policy(model: { provider?: string; id: string } | undefined): Policy | undefined {
      return snapshot?.status === "ready" && model
        ? snapshot.policies.find((policy) => policy.provider === model.provider && policy.modelId === model.id)
        : undefined;
    },
    close() { closed = true; unsubscribe(); pending?.finish(); snapshot = undefined; retired.clear(); },
  };
}
