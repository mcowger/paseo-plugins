export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiImageContent { type: "image"; data: string; mimeType: string; }
export interface PiPromptAck { requestId?: string; agentInvoked?: boolean; }
export interface PiTextContent { type: "text"; text: string; }
export interface PiThinkingContent { type: "thinking"; thinking: string; }
export interface PiToolCallContent { type: "toolCall"; id: string; name: string; arguments: unknown; }
export type PiAgentMessage =
  | { role: "user" | "custom"; content: string | Array<PiTextContent | PiImageContent> }
  | { role: "assistant"; content: Array<PiTextContent | PiThinkingContent | PiToolCallContent>; provider?: string; model?: string; responseId?: string; errorMessage?: string | null; stopReason?: string }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: unknown; isError?: boolean; details?: unknown }
  | { role: "bashExecution"; command: string; output?: string; exitCode?: number | null; cancelled?: boolean; timestamp: number };
export interface PiModel { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number; input?: string[]; }
export interface PiSessionState { model?: PiModel | null; thinkingLevel: PiThinkingLevel; isStreaming: boolean; isCompacting: boolean; autoCompactionEnabled?: boolean; sessionFile?: string; sessionId: string; sessionName?: string; messageCount: number; pendingMessageCount: number; contextUsage?: { tokens?: number | null; contextWindow?: number | null }; }
export interface PiSessionStats { tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; cost?: number; contextUsage?: { tokens?: number | null; contextWindow?: number | null }; }
export interface PiRpcSlashCommand { name: string; description?: string; source: "extension" | "prompt" | "skill"; sourceInfo?: Record<string, unknown>; }
export type PiAgentSessionEvent =
  | { type: "agent_start" | "turn_start" | "agent_settled" }
  | { type: "message_start"; message: PiAgentMessage }
  | { type: "message_end"; message: PiAgentMessage }
  | { type: "message_update"; message?: PiAgentMessage; assistantMessageEvent: { type: "text_delta" | "thinking_delta" | string; delta?: string } }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args?: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
  | { type: "compaction_start"; reason?: string }
  | { type: "compaction_end"; reason?: string }
  | { type: "agent_end"; messages?: PiAgentMessage[]; willRetry?: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string };
export type PiRuntimeEvent = PiAgentSessionEvent | { type: "extension_ui_request"; id: string; method: string; [key: string]: unknown } | { type: "command_output"; text?: string } | { type: "process_exit"; error: string } | { type: "prompt_result"; id?: string; agentInvoked?: boolean };
