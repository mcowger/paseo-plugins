# Native Paseo Pi and OMP integrations

Native Paseo Pi support translates a generic Pi RPC stream using a fixed set of
daemon-side extension parsers. Subagents are inferred from tool calls, custom
messages, and child files. Native OMP support consumes explicit subagent RPC
events, but its current subagent index still drops some ancestry and streaming
detail.

Neither implementation is the public provider-plugin API. They are useful
evidence of the host's behavior and existing workarounds, not modules a plugin
can depend on as supported SDK contracts.

## Scope and revisions

Root: `~/workspace/paseo`. Verification snapshot:
`5293ddac3f17f35ea090b292447ec0498edafafe`.

Initial research used `d070db15b`. The later snapshot includes grouped tintinweb
completion handling. The following relevant changes are established by local
git history:

| Commit | Change |
| --- | --- |
| `c081e0350` (#5309) | Per-extension Pi adapters; OMP handling split out of Pi |
| `e9e479c6b` (#5755) | Live Pi child transcript following, Nico polling/replay, gotgenes bridge |
| `4417d7c47` (#5762) | Pi built-in MCP receives the agent's MCP servers |
| `06213e49b` (#5826) | Every tintinweb child in grouped completion is settled |
| `264f6e1cc` (#5550) | OMP becomes a first-class native provider |
| `29c198f95` (#5780) | Configured provider options applied across providers |

Live child following, built-in MCP integration, grouped completion handling, and
the first-class OMP implementation are after the v0.10.0 tag. The report does not
claim those current-native behaviors are present in a frozen v0.10.0 host.

## Runtime and RPC seams

```text
Pi process: --mode rpc
  parent tool/message events + extension UI records
               |
               v
Pi runtime transport and PiAgentSession                daemon
  streaming fold, turn settlement, usage, permissions
               |
               v
PiExtensionHost                                       daemon
  first matching parser + child-file followers
               |
               v
AgentStreamEvent: timeline / provider_subagent
               |
               v
ProviderSubagentStore + agent manager
               |
               v
agent.provider_subagents.update / list / timeline      host-client protocol
               |
               v
Paseo app subagent UI
```

The native launch layer appends model, thinking, session/no-session, extension,
and optional MCP-adapter arguments. It still accepts a `protocolMode` union of
`rpc | rpc-ui`; the presence of `rpc-ui` in this internal launch type is not proof
that Pi 1.0.0 implements that OMP mode. [N1]

Native `PiAgentSession` handles streamed text/reasoning/tool calls, maps message
history, tracks submitted messages, and turns extension UI dialogs into host
permission requests. It consumes a narrower event subset than the current Pi
RPC union. Queue updates, arbitrary `entry_appended` state, and other events do
not automatically become rich UI state just because the Pi process emits them.
[N1, report 4](04-pi-rpc-contract.md)

### The injected Pi integration extension

The native provider creates a temporary `paseo-integration.mjs` extension. It:

- Registers supplied MCP servers through Pi's public `registerMcpServer` API.
- Appends host system instructions through `before_agent_start`.
- Captures stable user session-entry IDs and active-context/tree mappings.
- Correlates submitted user messages by object identity after Pi persists them.
- Exposes internal commands for entry capture and tree navigation.
- Records a custom rewind entry after navigation so reopening retains the rewind.
- Includes extension-specific runtime bridges, currently needed by gotgenes.

Results travel through prefixed JSON strings in `ctx.ui.notify`. The native
provider intercepts its own markers before rendering generic notifications.
This uses public Pi extension APIs but a private Paseo/Pi marker protocol.
Temporary files can contain MCP credentials, are written with mode `0600`, and
have teardown cleanup. [N1]

Core Pi RPC has `get_entries`, `get_tree`, and `fork`, but no direct
`navigate_tree` command. The injected navigation command demonstrates that an
extension bridge can expose a missing core RPC operation; it does not make that
marker a public Paseo plugin API.

## Pi extension adapter contract

`PiExtensionHost` creates one parser session per registered adapter. Relevant
internal interfaces are:

```ts
interface PiExtension {
  id: string;
  runtimeBridge?: string;
  createSession(): PiExtensionSession;
}

interface PiExtensionSession {
  mapToolCall?(call: PiExtensionToolCall): PiExtensionToolMapping | undefined;
  mapCustomMessage?(message: PiCustomMessage): PiExtensionCustomMapping | undefined;
  mapRuntimeNotification?(text: string): PiExtensionCustomMapping | undefined;
  poll?(): PiExtensionCustomMapping | undefined;
  // Additional hooks correlate tool starts/ends, dialogs, and permission replies.
}
```

A mapping may change a tool name/detail, add timeline items, upsert subagent
descriptors, and report `{ id, file }` child-session files. This is not a Pi core
subagent schema. It is an internal accommodation for several extension schemas.

The registry is static and ordered: question adapters, Nico subagents, tintinweb
subagents, gotgenes subagents, MCP naming, todo adapters, goal handling, and
another question adapter. Subagent parsers are always instantiated. There is no
installed-package negotiation for them. The first non-empty mapping wins; Zod
shape checks and per-parser state distinguish overlapping tool names. Exceptions
are caught and logged so one failing parser need not disable all others. [N2]

## Recognized Nico `pi-subagents` contract

The adapter matches `subagent` spawn calls only when args have nonempty `agent`
and `task` and no management `action`. `bg_wait` is its completion-collection
tool. Args and details accept extra fields.

```ts
type NicoArgs = { agent?: string; task?: string; async?: boolean; action?: unknown };
type NicoRow = {
  index?: number;
  agent: string;
  exitCode?: number;
  success?: boolean;
  sessionFile?: string;
};
type NicoDetails = {
  mode: string;
  runId?: string;
  asyncId?: string;
  asyncDir?: string;
  results: NicoRow[];
  completions?: Array<{ runId: string; results: NicoRow[] }>;
};
```

### Identity and foreground completion

The spawn tool call ID is the owner. A single result uses that ID; multiple rows
use `owner:index`, preferring the row's explicit index. A `runId -> owner` map
allows `bg_wait` completions to update the original spawn instead of making a
new child for the wait call.

Foreground result rows are completed only when `success === true` or, absent
that explicit success, `exitCode === 0`. Missing both fields is treated as failure.
The row's child transcript path is followed/read once per file identity.

### Async state and replay

An async spawn with no result rows stays running. `asyncDir` is associated with
the owning call. Every host poll reads `<asyncDir>/status.json` synchronously and
parses:

```ts
type NicoAsyncStatus = {
  state: string;
  steps: Array<{ agent: string; status?: string; sessionFile?: string }>;
};
```

Nonterminal run states keep children running. `complete`, `failed`, and `stopped`
settle steps, mapping stopped to canceled and failed/error to failed. With zero
steps, a terminal stopped run takes the implementation's fallback failed status,
not canceled. Polling stops after terminal run state.

Replay also parses `subagent-notify` text. It depends on exact copy such as:

```text
Background task completed: **...
Retention-managed async directory: <directory>
Session file: <file>
```

Grouped `Background tasks completed (N):` notices map every recognized run in
the notice to completed. The directory identifies the owner; the following
session-file line supplies its transcript. Changing notification text, result
indexes, or status-file layout can break correlation. These are private
extension/file contracts, not the generic Pi RPC contract. [N3]

## Recognized tintinweb-compatible contract

Spawn is `Agent`; follow-up tools are `get_subagent_result` and `steer_subagent`.
The parser does not check which extension package registered them.

```ts
type SpawnArgs = { subagent_type: string; prompt: string; description?: string };
type FollowupArgs = { agent_id: string };
type Details = {
  agentId: string;
  status: string;
  displayName?: string;
  description?: string;
};
type NotificationEntry = {
  id: string;
  status: string;
  description?: string;
  outputFile?: string;
};
type Notification = NotificationEntry & { others?: NotificationEntry[] };
```

While `Agent` is executing, the child ID is provisionally the spawn `callId`.
Its terminal tool result establishes `agentId -> callId`. A returned
`status: "background"` means the tool finished but the child remains running.
The child file is extracted from tool-result text using:

```regex
^Output file:\s*(\S+)$
```

The path must fit that whole-line pattern and cannot contain whitespace. The
structured spawn details do not supply the file to this parser. Completion or
update custom messages can supply `details.outputFile` instead.

Custom types `subagent-notification` and `subagent-update` use structured details,
not XML or human-readable result text. The latest parser handles a top-level
entry and `others[]`, skipping entries whose agent IDs were never correlated.
The older snapshot only handled the top-level entry. [N4]

### Status normalization

| Native string | Host status |
| --- | --- |
| `completed` | completed |
| `error` | failed |
| `aborted`, `stopped` | canceled |
| Any other value | running |

The personal extension uses this contract, but its terminal `steered` string
falls through to running. Its completion notification normalizes that status to
completed; follow-up tool details still contain `steered`. A later successful
`get_subagent_result` can therefore overwrite the completed card with running.
This mismatch follows directly from the two implementations; it was not
reproduced end to end in this research. [N4, report 5](05-personal-pi-plugins.md)

Notification correlation also depends on the spawn result having populated the
map. The parser has no buffer for an unknown completion ID. A notification that
precedes that correlation is skipped. Current fixtures do not establish that
this ordering occurs in normal personal-extension execution.

## Recognized gotgenes contract and runtime bridge

gotgenes resembles tintinweb but spawns through `subagent`. Its spawn args still
use `subagent_type` and `prompt`, allowing it to decline Nico's `agent/task` args.
Follow-up details may have `transcriptPath`. Custom notification status is
optional; absent status becomes running.

The live path is obtained through an injected bridge because the spawn result
can omit it. Inside Pi, the bridge captures the parent's
`globalThis[Symbol.for("@gotgenes/pi-subagents:service")]` at `session_start`,
listens for `subagents:child:session-created`, and searches `listAgents()` for an
`outputFile` containing the child session ID. It retries up to 240 times at
250 ms intervals, then reports:

```text
PASEO_GOTGENES_CHILD_SESSION {"agentId":"...","file":"..."}
```

The parser buffers these early file markers by agent ID until the spawn result
arrives. That buffer is specific to file discovery; it is not a generic buffer
for all early lifecycle messages.

The bridge depends on a package-specific global service, bus event, and path
naming convention. A renamed service or path that lacks the session ID defeats
it even if the extension's normal tools still work. It is not a core RPC
subagent subscription. [N5]

## Child transcript following and information loss

Live hosts tail child files; history hosts read them once. Both use
`PiChildSessionFollower` and `PiHistoryMapper`.

| Limit or behavior | Exact semantics |
| --- | --- |
| Poll cadence | One 250 ms timer for followers and adapter polling |
| Byte cap | First 2 MiB per child follower, cumulative offset |
| Item cap | 200 mapped timeline items per child follower, cumulative across polls |
| Partial final line | Buffered until LF; not emitted as an incomplete JSON record |
| Read order | Per-follower promise chain prevents final read overtaking an earlier tick |
| Terminal status | Schedules one final read, then removes follower from the map |
| Missing file/read/parse failure | Returns no child rows; malformed lines are skipped |
| History budget | 16 MiB total; charges up to 2 MiB per reported child before reading |
| Replay child count | At most eight full-budget file reads, even when files are tiny/missing |
| Shutdown | Timer stopped and callback cleared; pending reads cannot emit into closed host |

These are first-prefix/lifetime limits, not last-200-row retention or per-poll
budgets. Later content can disappear without a visible truncation row. Exhausted
followers can remain in the map until a terminal upsert or host close.

The child file mapper only accepts JSONL objects with a nested `message.role`.
It projects supported message roles into timeline rows and filters out other
stream-event kinds. It does not reconstruct an active session branch from
`parentId`, select a leaf, or apply all persisted entry types. Custom-message
entries stored in their separate `custom_message` entry form and arbitrary
custom state entries do not satisfy the nested-message check. Nested child
`provider_subagent` events are not retained by this timeline-only projection.
The result is a useful transcript view, not an exact Pi session replay. [N6]

A child that finishes before the next tick can still be captured by the initial
or final read. But a final unterminated line or a file flushed only after the
terminal notification can miss that one final read. The latter is a code-derived
ordering risk, not an observed regression in the inspected tests.

## Native OMP subagent events

OMP exposes a subscription level `off | progress | events`. Native Paseo asks for
events and falls back to progress if that request fails.

```ts
type Lifecycle = {
  id: string;
  agent: string;
  description?: string;
  status: "started" | "completed" | "failed" | "aborted";
  sessionFile?: string;
  parentToolCallId?: string;
  index: number;
  detached?: boolean;
};
type Progress = {
  index: number;
  agent: string;
  task: string;
  parentToolCallId?: string;
  assignment?: string;
  progress: {
    id: string;
    status: "pending" | "running" | "completed" | "failed" | "aborted";
    description?: string;
    resolvedModel?: string;
    currentTool?: unknown;
    recentTools?: unknown[];
    recentOutput?: unknown[];
  };
};
```

Frames wrap those payloads in `subagent_lifecycle` and `subagent_progress`.
`subagent_event` wraps `{ id, event }`, where event is an OMP session event.

Two consumers project the same activity differently:

1. `OmpSubagentIndex` keys state by parent runtime-session object and native child
   ID. Lifecycle/progress update descriptors; `subagent_event` contributes only
   `message_end` messages to child timeline history. Child streaming deltas are
   not projected by that index, even though the transport admits them.
2. `OmpSubagentCardTracker` keys cards by `parentToolCallId` and batch `index`.
   Lifecycle/progress build in-card tool logs, throttled at 500 ms with 200 lines
   and 240 characters per line. Missing parent-tool IDs prevent card updates.
   Multi-child cards show the first child's `childSessionId` as their direct link.

Started/pending/running map to running; aborted maps to canceled. Cleanup
terminalizes still-running indexed children as canceled. [N7]

Native OMP sets a descriptor's `toolCallId`, not `parentSubagentId`. Like native
Pi, it does not express nested child ancestry in the shared index. This is
different from omercnet's provider plugin, which opens nested public child
sessions. [Report 3](03-omercnet-omp-reference.md)

## Shared subagent sink versus the public plugin seam

The native provider sink has four statuses and sticky descriptor fields:

```ts
type SubagentEvent =
  | { type: "upsert"; id: string; status?: "running" | "completed" | "failed" | "canceled";
      title?: string | null; description?: string | null; toolCallId?: string | null;
      parentSubagentId?: string | null; cwd?: string | null; subtitle?: string | null }
  | { type: "timeline"; id: string; item: AgentTimelineItem; timestamp?: string }
  | { type: "remove"; id: string };
```

Omitted fields preserve previous values; explicit null clears them. Omitted
status preserves prior status, but explicit running can reopen a completed card.
Wire descriptors also carry `parentAgentId`, provider, and created/updated times.
`subtitle` is display text that clients must not parse for provider facts. [N8]

Native Pi/OMP emit this internal stream directly. A public provider plugin must
instead emit `session.opened`, child `timeline.item`, `session.turn`, and related
events. The host adapter translates those into this same index and derives
nested `parentSubagentId` from the provider-session graph.

Finding native parsers does not give a plugin a public import/reuse contract.
Conversely, not having first-class Pi child events does not make plugin children
impossible; it means their source must come from another established contract.
[Report 1](01-paseo-provider-api.md)

## Permission and MCP seams

Generic Pi `select`, `confirm`, `input`, and `editor` requests become question
permissions. Extension-specific adapters can correlate richer tool/dialog
requests or reply/defer before the generic mapper. Responses go back to the
native extension-UI request ID.

Important losses in the generic path:

- `editor` becomes a plain question with no forwarded `prefill` in this mapper.
- `setStatus`, `setWidget`, `setTitle`, and `set_editor_text` have no generic
  permission/timeline mapping here and are ignored when no adapter claims them.
- `notify` is first offered to runtime-marker adapters, then host markers, then
  rendered as a notification with info/warning/error level.
- Permission policy and question semantics are inferred from extension behavior;
  a generic dialog is not a typed native tool approval event.

Pending dialogs are tracked per session. Steering can deny/clear them. The Pi
RPC process itself reports `ctx.hasUI === true`; that supports parent-side
pi-control forwarding, but forwarding still needs actual UI response handling
and has not been tested end to end here. [N1, report 4]

MCP has two native Pi paths: Pi built-in registration through the injected
extension, and `pi-mcp-adapter` configuration through `--mcp-config`. Discovery
uses `/mcp` command `sourceInfo` to distinguish them, unlike always-active
subagent adapters. Built-in MCP rejects SSE in the inspected integration. Native
OMP instead uses its own MCP/host-tool bridge. These are integration-specific
choices, not a Pi core RPC `set_mcp_servers` command. [N1]

## Test coverage and evidence limits

Inspected tests cover foreground/background replay, live child rows before
completion, missing files, parser exception isolation, hydration budget, child
item caps, shutdown, grouped tintinweb completion, gotgenes bridge ordering, and
Nico/gotgenes tool-name disambiguation. OMP tests cover status and card tracking.

Tests and captured extension fixtures do not prove compatibility with arbitrary
future forks. Native docs also use `child_session` terminology that does not
match an actual wire event in these sources. The actual OMP event names are the
three `subagent_*` records above.

Open questions for later requirements work are the acceptable fidelity of child
history, nesting, extension coverage, child control versus observation, and how
to expose currently ignored UI state. No answers are selected here.

## Evidence and source map

All paths are relative to `~/workspace/paseo` at the verification snapshot.

| Ref | Source | Relevant content |
| --- | --- | --- |
| N1 | `packages/server/src/server/agent/providers/pi/runtime.ts:89-158`; `providers/pi/agent.ts:615-810,940-1087,1216-1219,1403-1407,1983-2171` under the same agent directory | Launch, injected extension, MCP detection, UI/event mapping |
| N2 | `packages/server/src/server/agent/providers/pi/extensions/contract.ts`; `extensions/registry.ts`; `extensions/host.ts:40-256` under that Pi directory | Internal adapter contract, ordered dispatch, polling, cleanup |
| N3 | `packages/server/src/server/agent/providers/pi/extensions/pi-subagents/index.ts:7-268` | Nico schemas, row identity, polling, notice parsing |
| N4 | `packages/server/src/server/agent/providers/pi/extensions/tintinweb-pi-subagents/index.ts:6-182` | Spawn/follow-up correlation and grouped notifications |
| N5 | `packages/server/src/server/agent/providers/pi/extensions/gotgenes-pi-subagents/index.ts`; `runtime-bridge.ts` in that adapter directory | gotgenes schemas, buffered paths, global-service bridge |
| N6 | `packages/server/src/server/agent/providers/pi/extensions/child-session.ts:8-99`; `providers/pi/history-mapper.ts:60-170` under the agent directory; `extensions/host.ts:176-218` | Prefix/lifetime caps and message-only child projection |
| N7 | `packages/server/src/server/agent/providers/omp/subagent-index.ts:21-154`; `subagent-card-tracker.ts` in that OMP directory; `rpc-types.ts:221-274,458-476`; `agent.ts:767-772,1596-1633` | Native OMP schemas, subscription, index/card projections |
| N8 | `packages/server/src/server/agent/provider-subagents/store.ts:8-140`; `packages/protocol/src/messages.ts:4652-4760`; `packages/server/src/server/agent/plugin-provider.ts:1313-1345,1520-1555` | Shared sink and distinct plugin-provider translation |

Tests: `providers/pi/extensions/index.test.ts` and each subagent adapter's
`index.test.ts`; `providers/omp/subagent-index.test.ts` and
`subagent-card-tracker.test.ts`, all under
`packages/server/src/server/agent/`. No external test suite or live native
Paseo session was run during this report's verification.
