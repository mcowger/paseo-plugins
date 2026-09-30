import { describe, expect, it, vi } from "vitest";
import {
  type AgentControlPort,
  cancelAgentTurn,
  createAgentCanceller,
  createProviderSubagentLister,
  createProviderSubagentTimelineFetcher,
} from "./control";
import {
  cancelWorkspaceAgent,
  getProviderSubagentTimeline,
  listWorkspaceProviderSubagents,
} from "../../shared/agents/control";

interface FakePort extends AgentControlPort {
  readonly sent: string[];
  readonly handlers: Set<(message: unknown) => void>;
  unsubscribedCount: number;
  emit(message: unknown): void;
  emitSessionFrame(sessionMessage: unknown): void;
}

function createFakePort(): FakePort {
  const sent: string[] = [];
  const handlers = new Set<(message: unknown) => void>();
  let unsubscribedCount = 0;

  return {
    sent,
    handlers,
    get unsubscribedCount() {
      return unsubscribedCount;
    },
    set unsubscribedCount(value: number) {
      unsubscribedCount = value;
    },
    send(frame: string): void {
      sent.push(frame);
    },
    onMessage(handler: (message: unknown) => void): () => void {
      handlers.add(handler);
      return () => {
        unsubscribedCount += 1;
        handlers.delete(handler);
      };
    },
    emit(message: unknown): void {
      for (const handler of Array.from(handlers)) {
        handler(message);
      }
    },
    emitSessionFrame(sessionMessage: unknown): void {
      this.emit({
        type: "paseo_frame",
        isBinary: false,
        data: JSON.stringify({
          type: "session",
          message: sessionMessage,
        }),
      });
    },
  };
}

describe("agent-control.server", () => {
  it("sends exactly one frame whose parsed JSON matches cancel_agent_request with injected requestId", async () => {
    const port = createFakePort();
    const canceller = createAgentCanceller(port, {
      createRequestId: () => "wa-cancel-test-1",
    });

    const promise = canceller("agent-alpha");

    expect(port.sent).toHaveLength(1);
    const sentFrame = port.sent[0];
    expect(sentFrame).toBeDefined();

    const parsed = JSON.parse(sentFrame as string) as {
      type?: unknown;
      message?: { type?: unknown; agentId?: unknown; requestId?: unknown };
    };
    expect(parsed).toEqual({
      type: "session",
      message: {
        type: "cancel_agent_request",
        agentId: "agent-alpha",
        requestId: "wa-cancel-test-1",
      },
    });

    port.emitSessionFrame({
      type: "cancel_agent_response",
      payload: {
        requestId: "wa-cancel-test-1",
        agentId: "agent-alpha",
        agent: null,
        error: null,
      },
    });

    const result = await promise;
    expect(result).toEqual({ ok: true, error: null });
    expect(cancelWorkspaceAgent.output.safeParse(result).success).toBe(true);
  });

  it("resolves ok on matching cancel_agent_response without error", async () => {
    const port = createFakePort();
    const canceller = createAgentCanceller(port, {
      createRequestId: () => "wa-cancel-test-2",
    });

    const promise = canceller("agent-beta");

    port.emitSessionFrame({
      type: "cancel_agent_response",
      payload: {
        requestId: "wa-cancel-test-2",
        agentId: "agent-beta",
        agent: { id: "agent-beta", status: "idle" },
        error: null,
      },
    });

    const result = await promise;
    expect(result).toEqual({ ok: true, error: null });
    expect(cancelWorkspaceAgent.output.safeParse(result).success).toBe(true);
    expect(port.handlers.size).toBe(0);
    expect(port.unsubscribedCount).toBe(1);
  });

  it("resolves { ok: false, error } when cancel_agent_response carries an error string", async () => {
    const port = createFakePort();
    const canceller = createAgentCanceller(port, {
      createRequestId: () => "wa-cancel-test-3",
    });

    const promise = canceller("agent-gamma");

    port.emitSessionFrame({
      type: "cancel_agent_response",
      payload: {
        requestId: "wa-cancel-test-3",
        agentId: "agent-gamma",
        agent: null,
        error: "Agent turn is not running",
      },
    });

    const result = await promise;
    expect(result).toEqual({ ok: false, error: "Agent turn is not running" });
    expect(cancelWorkspaceAgent.output.safeParse(result).success).toBe(true);
    expect(port.handlers.size).toBe(0);
    expect(port.unsubscribedCount).toBe(1);
  });

  it("ignores frames with different requestId, binary frames, and unparsable strings, then resolves on matching frame", async () => {
    const port = createFakePort();
    const canceller = createAgentCanceller(port, {
      createRequestId: () => "wa-cancel-target-id",
    });

    const promise = canceller("agent-delta");

    // Non-frame message
    port.emit({ type: "heartbeat" });

    // Binary frame
    port.emit({
      type: "paseo_frame",
      isBinary: true,
      data: new Uint8Array([1, 2, 3]),
    });

    // Unparsable JSON frame
    port.emit({
      type: "paseo_frame",
      isBinary: false,
      data: "{invalid-json",
    });

    // Different request ID
    port.emitSessionFrame({
      type: "cancel_agent_response",
      payload: {
        requestId: "wa-cancel-other-id",
        agentId: "agent-delta",
        agent: null,
        error: null,
      },
    });

    // Different request ID RPC error
    port.emitSessionFrame({
      type: "rpc_error",
      payload: {
        requestId: "wa-cancel-other-id",
        error: "Some other error",
      },
    });

    expect(port.handlers.size).toBe(1);

    // Matching response arrives
    port.emitSessionFrame({
      type: "cancel_agent_response",
      payload: {
        requestId: "wa-cancel-target-id",
        agentId: "agent-delta",
        agent: null,
        error: null,
      },
    });

    const result = await promise;
    expect(result).toEqual({ ok: true, error: null });
    expect(cancelWorkspaceAgent.output.safeParse(result).success).toBe(true);
    expect(port.handlers.size).toBe(0);
    expect(port.unsubscribedCount).toBe(1);
  });

  it("resolves { ok: false, error } on rpc_error with matching requestId", async () => {
    const port = createFakePort();
    const canceller = createAgentCanceller(port, {
      createRequestId: () => "wa-cancel-test-rpc-err",
    });

    const promise = canceller("agent-epsilon");

    port.emitSessionFrame({
      type: "rpc_error",
      payload: {
        requestId: "wa-cancel-test-rpc-err",
        error: "Daemon internal cancellation failure",
      },
    });

    const result = await promise;
    expect(result).toEqual({
      ok: false,
      error: "Daemon internal cancellation failure",
    });
    expect(cancelWorkspaceAgent.output.safeParse(result).success).toBe(true);
    expect(port.handlers.size).toBe(0);
    expect(port.unsubscribedCount).toBe(1);
  });

  it("times out using fake timers and unsubscribes the listener", async () => {
    vi.useFakeTimers();
    try {
      let unsubscribed = false;
      const port: AgentControlPort = {
        send(_frame: string): void {},
        onMessage(_handler: (message: unknown) => void): () => void {
          return () => {
            unsubscribed = true;
          };
        },
      };

      const canceller = createAgentCanceller(port, {
        timeoutMs: 3000,
        createRequestId: () => "wa-cancel-test-timeout",
      });

      const promise = canceller("agent-zeta");
      expect(unsubscribed).toBe(false);

      vi.advanceTimersByTime(3000);

      const result = await promise;
      expect(result).toEqual({
        ok: false,
        error: "Timed out waiting for the daemon to cancel the agent",
      });
      expect(cancelWorkspaceAgent.output.safeParse(result).success).toBe(true);
      expect(unsubscribed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancelAgentTurn resolves with error when process.send is not available", async () => {
    const originalSend = process.send;
    try {
      delete process.send;

      const result = await cancelAgentTurn({ agentId: "agent-eta" });
      expect(result).toEqual({
        ok: false,
        error: "Plugin process has no daemon channel",
      });
      expect(cancelWorkspaceAgent.output.safeParse(result).success).toBe(true);
    } finally {
      if (originalSend) {
        process.send = originalSend;
      }
    }
  });

  it("throws TypeError for empty agentId", () => {
    const port = createFakePort();
    const canceller = createAgentCanceller(port);
    expect(() => canceller("")).toThrow(TypeError);
  });

  it("sends provider_subagents.list.request and resolves with matching subagents", async () => {
    const port = createFakePort();
    const lister = createProviderSubagentLister(port, {
      createRequestId: () => "req-sub-1",
    });

    const promise = lister("parent-agent-alpha");
    expect(port.sent.length).toBe(1);
    const sentFrame = JSON.parse(port.sent[0] ?? "unexpected: no frame sent");
    expect(sentFrame).toEqual({
      type: "session",
      message: {
        type: "agent.provider_subagents.list.request",
        parentAgentId: "parent-agent-alpha",
        requestId: "req-sub-1",
      },
    });

    port.emitSessionFrame({
      type: "agent.provider_subagents.list.response",
      payload: {
        requestId: "req-sub-1",
        parentAgentId: "parent-agent-alpha",
        subagents: [
          {
            id: "sub-1",
            parentAgentId: "parent-agent-alpha",
            provider: "omp",
            title: "Task runner",
            description: "Audit files",
            subtitle: null,
            status: "completed",
            createdAt: "2026-09-02T12:00:00.000Z",
            updatedAt: "2026-09-02T12:05:00.000Z",
          },
        ],
        error: null,
      },
    });

    const result = await promise;
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("sub-1");
    expect(listWorkspaceProviderSubagents.output.safeParse({ subagents: result }).success).toBe(
      true,
    );
  });

  it("sends provider_subagents.timeline.get.request and resolves entries", async () => {
    const port = createFakePort();
    const fetcher = createProviderSubagentTimelineFetcher(port, {
      createRequestId: () => "req-tl-1",
    });

    const promise = fetcher("parent-1", "sub-1", 50);
    expect(port.sent.length).toBe(1);
    const sentFrame = JSON.parse(port.sent[0] ?? "unexpected: no frame sent");
    expect(sentFrame).toEqual({
      type: "session",
      message: {
        type: "agent.provider_subagents.timeline.get.request",
        parentAgentId: "parent-1",
        subagentId: "sub-1",
        direction: "tail",
        limit: 50,
        requestId: "req-tl-1",
      },
    });

    port.emitSessionFrame({
      type: "agent.provider_subagents.timeline.get.response",
      payload: {
        requestId: "req-tl-1",
        parentAgentId: "parent-1",
        subagentId: "sub-1",
        entries: [
          {
            timestamp: "2026-09-02T12:00:01.000Z",
            item: { type: "assistant_message", text: "Starting work" },
          },
        ],
      },
    });

    const result = await promise;
    expect(result).toHaveLength(1);
    expect(getProviderSubagentTimeline.output.safeParse({ entries: result }).success).toBe(true);
  });
});
