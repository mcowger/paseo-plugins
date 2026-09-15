# Nico subagents RPC integration

`nicobailon/pi-subagents` is the selected Pi subagent package for this provider.

It emits child progress as ordinary parent Pi RPC `tool_execution_update` frames
for foreground `subagent` calls. The captured frames came from a real run using
`subagent({ agent: "scout", async: false, task: "..." })`.

## Frame correlation

All delegation frames use the parent Pi tool-call ID:

```json
{
  "type": "tool_execution_update",
  "toolCallId": "call_...",
  "toolName": "subagent",
  "args": { "agent": "scout", "async": false, "task": "..." },
  "partialResult": { "content": [], "details": {} }
}
```

Do not use `toolCallId` as the child-session ID. It identifies the parent tool
invocation. Once present, use this stable provider child key:

```text
${details.runId}:${result.index}
```

For a normal one-child call this is `runId:0`. Keep the parent `toolCallId` as
the correlation key until the first update supplies `runId`.

### Workflow result identity

Workflow results are different. Each workflow step may return its own nested
foreground result at `index: 0`, so `runId:index` is not unique across the
top-level `details.results` array. The terminal result for a three-step
workflow observed this exact shape:

```json
{
  "mode": "workflow",
  "runId": "workflow-run",
  "results": [
    { "index": 0, "workflowKey": "num-agent-1", "agent": "delegate" },
    { "index": 0, "workflowKey": "num-agent-2", "agent": "delegate" },
    { "index": 0, "workflowKey": "num-agent-3", "agent": "delegate" }
  ]
}
```

When `workflowKey` exists, use it with the workflow run ID as the child key.
It is the stable identity of the workflow-owned child. `workflowChildren` is
also an authoritative inventory of workflow children and supplies their
state, agent, session name, model, thinking level, and live activity when
individual result rows are absent or compacted.

## Live update shape

`partialResult.details` has this relevant shape. `results[index]` and
`progress[index]` describe the same child; prefer `progress` for live state and
`results` for durable metadata.

```ts
interface NicoSubagentUpdateDetails {
  mode: "single" | string;
  runId: string;
  context: "fresh" | "fork" | "profile" | string;
  results: NicoChildResult[];
  progress: NicoChildProgress[];
}

interface NicoChildResult {
  index: number;
  agent: string;
  sessionName?: string;
  model?: string;       // e.g. "plexus/muse-spark-1.3:low"
  thinking?: string;    // e.g. "low"
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
  };
  transcriptPath?: string;
  sessionFile?: string;
  artifactPaths?: {
    jsonlPath?: string;
    transcriptPath?: string;
    metadataPath?: string;
    inputPath?: string;
    outputPath?: string;
  };
  progress?: NicoChildProgress;
  progressSummary?: {
    toolCount?: number;
    tokens?: number;
    durationMs?: number;
  };
}

interface NicoChildProgress {
  index: number;
  agent: string;
  sessionName?: string;
  status: "running" | "completed" | "failed" | string;
  model?: string;
  thinking?: string;
  toolCount: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
  durationMs: number;
  lastActivityAt?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  recentTools: Array<{ tool: string; args?: string; endMs?: number }>;
  recentOutput: string[];
}
```

`partialResult.content` contains the latest child text preview. It changed in
the captured run from `"Working directory and top-level listing — pulling that
now."` to the final child output. It is child-scoped even though it is carried
by the parent tool update, and is the right source for one stable live
assistant-preview row.

### Live child tool snapshot

`results[index].toolCalls` is also present in live updates. This is the
authoritative current tool list, not terminal-only data. The real foreground
capture reported this before the parent `tool_execution_end` event:

```json
{
  "toolCalls": [
    { "expandedText": "$ pwd" },
    { "expandedText": "ls {\"path\":\"/home/matt.cowger/workspace/paseo-plugins\"}" }
  ],
  "progress": {
    "currentTool": "ls",
    "currentToolArgs": "/home/matt.cowger/workspace/paseo-plugins",
    "recentTools": [{ "tool": "bash", "args": "pwd", "endMs": 1789486958853 }]
  }
}
```

Project every `toolCalls` entry with a stable ID derived from its child and
its position/text. Parse `$ command` as `bash`; parse entries such as
`ls {"path":"..."}` as their named tool and JSON arguments. Match the live
`currentTool` to that list and mark only the matching recorded item running.
Use `recentTools` to mark matching recorded items complete. It is a fallback
for tools omitted from `toolCalls`, not a second timeline source.

`currentPath` must not become a shell `cwd`: it is a path reported by the
child, not evidence of the working directory for its command.

### Observed live transitions

The captured run demonstrated this sequence:

1. `status: "running"`, first assistant preview, `toolCount: 1`, and
   `currentTool: "read"` with `currentToolArgs` and `currentPath`.
2. The completed read moved to `recentTools` with an `endMs` timestamp.
3. Usage advanced from one to three turns while `inputTokens`, `outputTokens`,
   `tokens`, and `durationMs` changed.
4. The next active call appeared as `currentTool: "write"`.
5. The terminal update reported `status: "completed"`, no active tool, a
   `progressSummary`, and final aggregate usage.

Updates may repeat unchanged state, including heartbeat updates. Fold updates
by child key and emit a Paseo update only when the mapped state changes.

## Terminal result

The parent `tool_execution_end` for `toolName: "subagent"` contains the final
output in `result.content` and the final version of the same details object:

```ts
interface NicoSubagentTerminalDetails extends NicoSubagentUpdateDetails {
  timeoutMs?: number;
  totalChildUsage?: NicoChildResult["usage"];
  totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
}
```

Treat a nonzero child `exitCode`, explicit failure status, or parent
`tool_execution_end.isError` as a failed child turn. Otherwise close the child
turn as completed and append `results[index].finalOutput` as the final
assistant row. Do not use the parent `result.content` aggregate (for example,
`"Run fan-out: 1/64 used"`) as a child response.

The captured terminal record also retains `progressSummary` after the live
`progress` object has been compacted away. It has `toolCount`, `tokens`, and
`durationMs`; preserve it in the projector's internal snapshot for terminal
accounting even though Paseo's child-session protocol has no fields for those
three counters. `usage` remains the source for visible input, output,
cache-read, and cost accounting. When both live progress and result usage are
present, use the live input/output/window values and retain result-level
cache-read and cost values.

Only copy the parent envelope text into a child preview while it is a live
preview or a child result has its own `finalOutput`. A terminal aggregate with
no child final output is parent-only status text, not a fabricated child
response.

## Reproducing the capture

Run Pi's normal extension discovery. Do not pass `--no-extensions`; that
turns off the installed `pi-subagents` extension and does not match the
provider runtime. Start Pi in RPC mode with the same working directory and
prompt a foreground `subagent` call. Keep reading JSONL until `agent_end`;
the `prompt` acknowledgement only confirms that Pi accepted the request.

Save the raw frames, then filter `tool_execution_update` and
`tool_execution_end` events whose `toolName` is `subagent`. Inspect
`partialResult.details.results[index]`, its nested `progress`, and the
terminal `result.details.results[index]`. This captures the public transport
contract without reading private Nico status or transcript files.

## Paseo mapping

When the first child update includes `runId` and `result.index`:

- Open a virtual child provider session with ID `${runId}:${index}` and the
  parent Pi session as `parentSessionId`.
- Use `agent` and `sessionName` for title/description.
- Update model and thinking from `model` and `thinking`.
- Report usage from `usage` while preserving cache-read/write values where the
  provider protocol supports them. Project live `window` as Paseo's
  `contextWindowUsedTokens` when available.
- Emit the stable assistant preview from `partialResult.content`. Project
  `results[index].toolCalls` first, reconciling its entries with `currentTool`
  and `recentTools`; use summaries only as a fallback. Do not render
  `recentOutput` as fake assistant messages.
- Complete or fail the child on the terminal parent tool event.

Nico's foreground child records `launchResolvedExtensions.disableAmbientExtensions:
true`. Agent definitions must explicitly declare allowed tool names and the
extension providers that register non-builtin tools (for example through
`subagentOnlyExtensions`). The tool list is a strict allowlist; it does not
implicitly load extension code.
