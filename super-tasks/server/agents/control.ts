import { randomUUID } from "node:crypto";
import type {
  ProviderSubagentItem,
  ProviderSubagentTimelineEntry,
} from "../../shared/agents/control";

export interface AgentControlPort {
  send(frame: string): void;
  onMessage(handler: (message: unknown) => void): () => void;
}

export interface CreateAgentCancellerOptions {
  timeoutMs?: number;
  createRequestId?: () => string;
}

export function createAgentCanceller(
  port: AgentControlPort,
  options?: CreateAgentCancellerOptions,
): (agentId: string) => Promise<{ ok: boolean; error: string | null }> {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const createRequestId = options?.createRequestId ?? (() => `wa-cancel-${randomUUID()}`);

  return (agentId: string): Promise<{ ok: boolean; error: string | null }> => {
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new TypeError("agentId must be a non-empty string");
    }

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (unsubscribe !== undefined) {
          try {
            unsubscribe();
          } catch {
            // Ignore listener cleanup errors.
          }
          unsubscribe = undefined;
        }
      };

      const settle = (result: { ok: boolean; error: string | null }) => {
        cleanup();
        resolve(result);
      };

      const requestId = createRequestId();

      unsubscribe = port.onMessage((rawMessage: unknown) => {
        if (settled) return;
        if (!rawMessage || typeof rawMessage !== "object") return;
        const envelope = rawMessage as {
          type?: unknown;
          isBinary?: unknown;
          data?: unknown;
        };
        if (
          envelope.type !== "paseo_frame" ||
          envelope.isBinary !== false ||
          typeof envelope.data !== "string"
        ) {
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(envelope.data);
        } catch {
          return;
        }

        if (!parsed || typeof parsed !== "object") return;
        const dataObj = parsed as {
          type?: unknown;
          message?: unknown;
          payload?: unknown;
        };

        let messageType: unknown;
        let payload: unknown;

        if (dataObj.type === "session" && dataObj.message && typeof dataObj.message === "object") {
          const sessionMsg = dataObj.message as {
            type?: unknown;
            payload?: unknown;
          };
          messageType = sessionMsg.type;
          payload = sessionMsg.payload;
        } else {
          messageType = dataObj.type;
          payload = dataObj.payload;
        }

        if (!payload || typeof payload !== "object") return;
        const payloadObj = payload as {
          requestId?: unknown;
          error?: unknown;
        };

        if (payloadObj.requestId !== requestId) return;

        if (messageType === "cancel_agent_response") {
          const error =
            typeof payloadObj.error === "string" && payloadObj.error.length > 0
              ? payloadObj.error
              : payloadObj.error
                ? String(payloadObj.error)
                : null;
          settle({
            ok: !error,
            error,
          });
        } else if (messageType === "rpc_error") {
          const error =
            typeof payloadObj.error === "string"
              ? payloadObj.error
              : payloadObj.error
                ? String(payloadObj.error)
                : "RPC error";
          settle({
            ok: false,
            error,
          });
        }
      });

      timer = setTimeout(() => {
        settle({
          ok: false,
          error: "Timed out waiting for the daemon to cancel the agent",
        });
      }, timeoutMs);

      const outbound = JSON.stringify({
        type: "session",
        message: {
          type: "cancel_agent_request",
          agentId,
          requestId,
        },
      });

      try {
        port.send(outbound);
      } catch (err) {
        cleanup();
        throw err;
      }
    });
  };
}

export function createProviderSubagentLister(
  port: AgentControlPort,
  options?: { timeoutMs?: number; createRequestId?: () => string },
): (parentAgentId: string) => Promise<ProviderSubagentItem[]> {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const createRequestId = options?.createRequestId ?? (() => `wa-subagents-${randomUUID()}`);

  return (parentAgentId: string): Promise<ProviderSubagentItem[]> => {
    if (typeof parentAgentId !== "string" || parentAgentId.length === 0) {
      throw new TypeError("parentAgentId must be a non-empty string");
    }

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (unsubscribe !== undefined) {
          try {
            unsubscribe();
          } catch {
            // Ignore listener cleanup errors.
          }
          unsubscribe = undefined;
        }
      };

      const settle = (subagents: ProviderSubagentItem[]) => {
        cleanup();
        resolve(subagents);
      };

      const requestId = createRequestId();

      unsubscribe = port.onMessage((rawMessage: unknown) => {
        if (settled) return;
        if (!rawMessage || typeof rawMessage !== "object") return;
        const envelope = rawMessage as {
          type?: unknown;
          isBinary?: unknown;
          data?: unknown;
        };
        if (
          envelope.type !== "paseo_frame" ||
          envelope.isBinary !== false ||
          typeof envelope.data !== "string"
        ) {
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(envelope.data);
        } catch {
          return;
        }

        if (!parsed || typeof parsed !== "object") return;
        const dataObj = parsed as {
          type?: unknown;
          message?: unknown;
          payload?: unknown;
        };

        const innerMessage =
          dataObj.message && typeof dataObj.message === "object"
            ? (dataObj.message as { type?: unknown; payload?: unknown })
            : undefined;

        const messageType = innerMessage?.type ?? dataObj.type;
        const messagePayload = innerMessage?.payload ?? dataObj.payload;

        if (
          messageType === "agent.provider_subagents.list.response" &&
          messagePayload &&
          typeof messagePayload === "object"
        ) {
          const payloadObj = messagePayload as {
            requestId?: unknown;
            subagents?: unknown;
            error?: unknown;
          };
          if (payloadObj.requestId === requestId) {
            if (Array.isArray(payloadObj.subagents)) {
              settle(payloadObj.subagents as ProviderSubagentItem[]);
            } else {
              settle([]);
            }
          }
        }
      });

      timer = setTimeout(() => {
        settle([]);
      }, timeoutMs);

      const outbound = JSON.stringify({
        type: "session",
        message: {
          type: "agent.provider_subagents.list.request",
          parentAgentId,
          requestId,
        },
      });

      try {
        port.send(outbound);
      } catch {
        cleanup();
        resolve([]);
      }
    });
  };
}

export function createProviderSubagentTimelineFetcher(
  port: AgentControlPort,
  options?: { timeoutMs?: number; createRequestId?: () => string },
): (
  parentAgentId: string,
  subagentId: string,
  limit?: number,
) => Promise<ProviderSubagentTimelineEntry[]> {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const createRequestId = options?.createRequestId ?? (() => `wa-subagent-tl-${randomUUID()}`);

  return (
    parentAgentId: string,
    subagentId: string,
    limit = 150,
  ): Promise<ProviderSubagentTimelineEntry[]> => {
    if (typeof parentAgentId !== "string" || parentAgentId.length === 0) {
      throw new TypeError("parentAgentId must be a non-empty string");
    }
    if (typeof subagentId !== "string" || subagentId.length === 0) {
      throw new TypeError("subagentId must be a non-empty string");
    }

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (unsubscribe !== undefined) {
          try {
            unsubscribe();
          } catch {
            // Ignore listener cleanup errors.
          }
          unsubscribe = undefined;
        }
      };

      const settle = (entries: ProviderSubagentTimelineEntry[]) => {
        cleanup();
        resolve(entries);
      };

      const requestId = createRequestId();

      unsubscribe = port.onMessage((rawMessage: unknown) => {
        if (settled) return;
        if (!rawMessage || typeof rawMessage !== "object") return;
        const envelope = rawMessage as {
          type?: unknown;
          isBinary?: unknown;
          data?: unknown;
        };
        if (
          envelope.type !== "paseo_frame" ||
          envelope.isBinary !== false ||
          typeof envelope.data !== "string"
        ) {
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(envelope.data);
        } catch {
          return;
        }

        if (!parsed || typeof parsed !== "object") return;
        const dataObj = parsed as {
          type?: unknown;
          message?: unknown;
          payload?: unknown;
        };

        const innerMessage =
          dataObj.message && typeof dataObj.message === "object"
            ? (dataObj.message as { type?: unknown; payload?: unknown })
            : undefined;

        const messageType = innerMessage?.type ?? dataObj.type;
        const messagePayload = innerMessage?.payload ?? dataObj.payload;

        if (
          messageType === "agent.provider_subagents.timeline.get.response" &&
          messagePayload &&
          typeof messagePayload === "object"
        ) {
          const payloadObj = messagePayload as {
            requestId?: unknown;
            entries?: unknown;
            error?: unknown;
          };
          if (payloadObj.requestId === requestId) {
            if (Array.isArray(payloadObj.entries)) {
              settle(payloadObj.entries as ProviderSubagentTimelineEntry[]);
            } else {
              settle([]);
            }
          }
        }
      });

      timer = setTimeout(() => {
        settle([]);
      }, timeoutMs);

      const outbound = JSON.stringify({
        type: "session",
        message: {
          type: "agent.provider_subagents.timeline.get.request",
          parentAgentId,
          subagentId,
          direction: "tail",
          limit,
          requestId,
        },
      });

      try {
        port.send(outbound);
      } catch {
        cleanup();
        resolve([]);
      }
    });
  };
}

const defaultPort: AgentControlPort = {
  send(frame: string): void {
    if (typeof process.send === "function") {
      process.send({ type: "paseo_frame", data: frame, isBinary: false });
    }
  },
  onMessage(handler: (message: unknown) => void): () => void {
    const listener = (msg: unknown) => {
      handler(msg);
    };
    process.on("message", listener);
    return () => {
      process.off("message", listener);
    };
  },
};

const defaultCanceller = createAgentCanceller(defaultPort);

export async function cancelAgentTurn(input: {
  agentId: string;
}): Promise<{ ok: boolean; error: string | null }> {
  if (typeof process.send !== "function") {
    return { ok: false, error: "Plugin process has no daemon channel" };
  }
  return defaultCanceller(input.agentId);
}

const defaultSubagentLister = createProviderSubagentLister(defaultPort);
const defaultSubagentTimelineFetcher = createProviderSubagentTimelineFetcher(defaultPort);

export async function listProviderSubagentsForParents(input: {
  parentAgentIds: string[];
}): Promise<{ subagents: ProviderSubagentItem[] }> {
  if (
    typeof process.send !== "function" ||
    !Array.isArray(input.parentAgentIds) ||
    input.parentAgentIds.length === 0
  ) {
    return { subagents: [] };
  }
  const results = await Promise.all(
    input.parentAgentIds.map((id) => defaultSubagentLister(id).catch(() => [])),
  );
  return { subagents: results.flat() };
}

export async function fetchProviderSubagentTimelineHandler(input: {
  parentAgentId: string;
  subagentId: string;
  limit?: number;
}): Promise<{ entries: ProviderSubagentTimelineEntry[] }> {
  if (typeof process.send !== "function") {
    return { entries: [] };
  }
  const entries = await defaultSubagentTimelineFetcher(
    input.parentAgentId,
    input.subagentId,
    input.limit,
  ).catch(() => []);
  return { entries };
}

export default cancelAgentTurn;
