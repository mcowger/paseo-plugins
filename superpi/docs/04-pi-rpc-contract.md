# Pi subprocess RPC contract

Pi's RPC mode is a long-lived, out-of-process control interface. It exposes
commands, correlated responses, session events, and supported extension UI
interactions over stdin/stdout. It retains normal Pi resource loading and
extension behavior without embedding Pi into the Paseo plugin process.

This is the required integration boundary for Superpi. The in-process SDK is
not an alternative being considered in this report.

## Source and version

Source root: `~/workspace/pi`, repository `earendil-works/pi`, revision
`86dfceec402ad77e563bf4feab5f26c42d5f5db6`, described as
`v1.0.0-1-g86dfceec4`. Package versions are 1.0.0.

The active bundled executable under
`~/.local/share/path-overrides/pi-local` reports `1.0.0+local`. Initial research
included limited live probes against that executable. Observed RPC behavior
matched the inspected source, but the bundle was not exhaustively compared to
the checkout. This is not a claim about every future Pi release.

The checkout was 24 commits behind its local `origin/main` reference during the
initial research. No fetch was performed. A supported Pi version range remains
a requirements decision.

## Process and framing seam

```text
Paseo provider plugin server
    | stdin: commands and extension UI responses
    v
Pi process: pi --mode rpc
    | stdout: responses, session events, extension UI requests
    | stderr: diagnostics
    v
provider's native event consumer
```

Normal startup options determine cwd, model, thinking, tools, resources, and
session behavior independently of RPC mode. Relevant choices include:

| Option | Meaning |
| --- | --- |
| `--mode rpc` | Bidirectional JSONL until shutdown |
| `--no-session` | In-memory session; no durable session file |
| `--session <path|id>` | Open an existing session by path/identity |
| `--session-id <id>` | Open an exact project identity or create it |
| `--session-dir <dir>` | Override session storage and lookup |
| `--model`, `--thinking` | Initial model and reasoning selection |
| `--extension <path>` | Explicit extension loading; repeatable |
| `--no-extensions` | Disable automatic/configured extensions; explicit ones still load |
| `--tools`, `--exclude-tools` | Initial tool selection |
| `--system-prompt`, `--append-system-prompt` | Replace or append system instructions |

RPC rejects `@file` prompt arguments. Prompts must arrive through the command
channel. Pi's `--resume` opens a selector; it is not OMP's `--resume <identity>`
launch contract. Installed-version help remains authoritative for CLI flags.

Records are JSON objects terminated by LF. Split only on LF, accepting an
optional preceding CR. Unicode U+2028/U+2029 inside strings are not record
separators. Pi's own JSONL helper deliberately avoids a generic line reader and
uses UTF-8 stream decoding.

Stdout is protocol-only. Logging and diagnostics go to stderr. A client must
consume stdout continuously and honor stdin backpressure. Otherwise a full pipe
can stall agent execution. The core line reader does not impose the extensive
frame/chunk budgets found in the OMP reference. There is no Pi core chunked-frame
protocol in the inspected RPC contract. [R1, R2]

## Startup and readiness

There is no `ready` event or protocol-version negotiation command. Pi initializes
resources and extensions before entering the input loop. Extensions can emit
UI records during startup, so the first stdout record is not necessarily a
response to a client command.

`get_state` can establish that the input loop is responding and identify the
active session. That is a command response, not an advertised readiness
handshake. `pi --version` is an out-of-band executable check.

The exported subprocess `RpcClient` is useful implementation evidence, distinct
from embedding an `AgentSession`. Its inspected startup waits 100 ms and checks
for an immediate process exit; that delay is not a readiness guarantee. It also
defaults to running `node dist/cli.js`, so its executable assumptions differ from
invoking the installed bundled Pi binary directly. This report does not choose
whether to use that client or implement transport handling. [R2, R3]

## Command and response correlation

```json
{"id":"request-1","type":"get_state"}
```

Success and failure responses have these shapes:

```json
{"id":"request-1","type":"response","command":"get_state","success":true,"data":{"sessionId":"example"}}
{"id":"request-2","type":"response","command":"set_model","success":false,"error":"Model not found: provider/model"}
```

Examples omit unrelated state fields. `id` is optional and echoed when supplied.
Commands can be handled asynchronously, so response order is not command
identity. Session events generally have no originating command ID.

Malformed JSON produces an ID-less `command: "parse"` error. Unknown command
types produce `success: false`. The implementation casts parsed input to its
command union rather than applying a full runtime schema to every command; the
TypeScript union is a contract reference, not a security validator.

The input callback starts each command handler without globally awaiting the
previous handler. Commands can overlap. Native session methods may restrict
operations, but the wire has no universal transaction/serialization guarantee.

`extension_ui_response` is handled separately. It uses a dialog's ID and emits
no normal command response. An unknown or expired dialog ID is ignored. [R1, R2]

## Complete command inventory

All commands accept optional `id`. The table lists fields in addition to `type`
and the success response's `data`; failures use the common error response.

| Command | Input fields | Success data |
| --- | --- | --- |
| `prompt` | `message`, `images?`, `streamingBehavior?` | `{ disposition: started | queued | handled }` |
| `steer` | `message`, `images?` | `{ disposition: queued | handled }` |
| `follow_up` | `message`, `images?` | `{ disposition: queued | handled }` |
| `abort` | None | No data; waits for idle |
| `clear_queue` | None | `{ steering: string[], followUp: string[] }` |
| `new_session` | `parentSession?` | `{ cancelled: boolean }` |
| `get_state` | None | Current session state |
| `set_model` | `provider`, `modelId` | Full selected model |
| `cycle_model` | None | `{ model, thinkingLevel, isScoped }` or null |
| `get_available_models` | None | `{ models }` |
| `set_thinking_level` | `level` | No data |
| `cycle_thinking_level` | None | `{ level }` or null |
| `get_available_thinking_levels` | None | `{ levels }` |
| `set_steering_mode` | `mode: all | one-at-a-time` | No data |
| `set_follow_up_mode` | `mode: all | one-at-a-time` | No data |
| `compact` | `customInstructions?` | Compaction result |
| `set_auto_compaction` | `enabled` | No data |
| `set_auto_retry` | `enabled` | No data |
| `abort_retry` | None | No data |
| `bash` | `command`, `excludeFromContext?` | Bash result |
| `abort_bash` | None | No data |
| `get_session_stats` | None | Usage/cost/context statistics |
| `export_html` | `outputPath?` | `{ path }` |
| `switch_session` | `sessionPath` | `{ cancelled: boolean }` |
| `fork` | `entryId` | `{ text, cancelled }`; canceled text can be absent on serialization |
| `clone` | None | `{ cancelled: boolean }` |
| `get_fork_messages` | None | `{ messages: [{ entryId, text }] }` |
| `get_entries` | `since?` | `{ entries, leafId }` |
| `get_tree` | None | `{ tree, leafId }` |
| `get_last_assistant_text` | None | `{ text: string | null }` |
| `set_session_name` | `name` | No data |
| `get_messages` | None | `{ messages }` |
| `get_commands` | None | `{ commands }` |

There is no core session listing/search, arbitrary tree-navigation, native
archive, file rollback, login, MCP-management, tool-registration, or subagent
subscription command in this union. Extensions can expose additional behavior
through their own commands and metadata, but that is a separate contract.
[R1, R2]

## Prompt admission, queues, and settlement

The `prompt` response is emitted after preflight establishes disposition. It may
be interleaved with session events; consumers cannot assume response-before-
events. Post-acceptance failures are events/messages, not a second response.

| Disposition | Meaning |
| --- | --- |
| `started` | Prompt accepted to start a run |
| `queued` | Prompt queued during active work |
| `handled` | Extension command or input handler consumed the submitted prompt |

`handled` does not mean an ordinary model run will start for that request.
Extensions may independently initiate other activity, so it also does not mean
the entire process is permanently idle. A client cannot blindly wait for a
future settlement event for every handled command.

During streaming, ordinary `prompt` requires `streamingBehavior: "steer"` or
`"followUp"`. Steering is delivered after the current assistant tool batch and
before the next model call. Follow-up waits until normal current work finishes.
Queue modes control all-at-once versus one-at-a-time delivery.

Extension slash commands can execute through `prompt` even during streaming.
`steer` and `follow_up` expand skills/templates but do not accept extension
commands. Their `queued` response describes admission, not a guarantee the
message remains in the queue forever.

The important lifecycle distinction is:

```text
agent_start
  turn_start
    user/system/assistant message events
    assistant content deltas
    tool execution events
  turn_end
agent_end                  one low-level agent run ended
  retry/compaction/queued continuation may follow
agent_settled              no automatic session-level work remains
```

`agent_end.willRetry` helps describe one boundary but does not replace
`agent_settled`. Subscribe before sending input so a fast completion is not
missed. `RpcClient.promptAndWait` follows that pattern. Calling an event-only
idle waiter after an already completed run can wait for an unrelated later
event. [R2, R3, R4]

## Session event inventory

| Event family | Important fields and meaning |
| --- | --- |
| `agent_start`, `agent_end`, `agent_settled` | Run start; generated messages/`willRetry`; final automatic settlement |
| `turn_start`, `turn_end` | One assistant response plus its resulting tools; final message and tool results |
| `message_start`, `message_end` | Initial and authoritative final message |
| `message_update` | Cumulative usage plus one assistant content-block update |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` |
| `tool_execution_update` | Same correlation plus tool-specific `partialResult` |
| `tool_execution_end` | `toolCallId`, `toolName`, `result`, `isError` |
| `queue_update` | Complete current steering and follow-up text arrays |
| `entry_appended` | Persisted session entry, including custom extension state |
| `session_info_changed` | Changed/cleared name |
| `thinking_level_changed` | Effective reasoning level |
| `compaction_start`, `compaction_end` | Reason, result, abort/error, whether recovery retries |
| `auto_retry_start`, `auto_retry_end` | Attempt/delay/error and final success/failure |
| `summarization_retry_*` | Scheduling, compaction/branch-summary attempt, finished state |
| `bash_execution_update` | Direct RPC bash output delta; repeats command ID if present |
| `extension_error` | RPC-added extension path/event/error diagnostic |

Nested tools invoked through `ctx.executeTool()` can carry `parentToolCallId`.
This is tool ancestry, not a first-class child-agent stream. A custom extension
event bus emission is not automatically an `AgentSessionEvent` or stdout record.
[R4, R5]

## Streaming reconstruction contract

RPC transforms SDK streaming events. It removes the growing cumulative message
and every `assistantMessageEvent.partial`. A consumer written for SDK snapshots
will not receive them over the wire.

```json
{
  "type": "message_update",
  "usage": {"input":100,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":101,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},
  "assistantMessageEvent": {"type":"text_delta","contentIndex":0,"delta":"Hello "}
}
```

| Nested event | Reconstruction |
| --- | --- |
| `text_start`, `thinking_start` | Open block at `contentIndex` |
| `text_delta`, `thinking_delta` | Append block text |
| `text_end`, `thinking_end` | Replace block with authoritative completed content |
| `toolcall_start` | Supplies `contentIndex`, stable `id`, and `toolName` |
| `toolcall_delta` | Partial serialized arguments; not necessarily valid JSON yet |
| `toolcall_end` | Replace with complete `toolCall` |

The normal agent loop generally turns provider start/done/error into session
message start/end events. The exported transformation admits those nested
variants, but a client must not require them to occur on every ordinary run.

`message_end.message` is the authoritative final replacement. Top-level update
usage is cumulative for that response and must not be summed across deltas.
Tool `partialResult` interpretation is tool-specific; there is no generic rule
that all updates are append-only text. [R4]

## Messages, content, and usage

Message roles include system, user, assistant, toolResult, bashExecution, custom,
branchSummary, and compactionSummary. Extension typing can add roles. Content
blocks include text, image, thinking, and tool calls.

Assistant and tool-result content are arrays. User, system, and custom messages
can legally contain string content or arrays according to the source/documented
types. Initial live probes observed array-form user content, but that is not an
always-array wire guarantee. The earlier research summary overstated it.

Tool results have optional arbitrary `details`, optional nested-model `usage`,
and an error flag. Custom messages have `customType`, display intent, content,
and details. Details are useful to an adapter but are not sent as model-visible
custom-message content.

Thinking/text/tool signatures are opaque replay metadata, not display content.
Assistant fields can include physical response model, response ID, requested and
provider thinking levels, diagnostics, and raw stop reason. Several of these
are already documented in the current message reference; they must not all be
labeled undocumented based on the first research summary.

Usage contains input/output, cache read/write, optional one-hour cache-write and
reasoning subsets, total tokens, and cost components. Reasoning is already
included in output. Session statistics also include tool-reported nested usage,
compaction/branch summaries, and other recorded usage, so they are not just a
sum of currently visible assistant rows. Context usage can have null token/
percentage values immediately after compaction. [R6]

## State, models, and command discovery

`get_state` returns model, thinking level, streaming/compacting flags, queue
modes/count, session identity/file/name, auto-compaction setting, and message
count. Optional fields are omitted when unavailable. It is not complete
settings or active-tool introspection.

Model discovery returns full Pi model definitions. Their provider/model IDs,
context size, modalities, reasoning support, and costs differ from Paseo's
catalog shape. Initial probes also observed `thinkingLevelMap`, illustrating
why extra model fields must not be mistaken for malformed responses.

Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
The selected model controls availability. Non-reasoning models return `["off"]`.
Requested choices and effective clamped state should not be conflated.

`get_commands` returns extension commands, templates, and skills. Entries include
name, optional description, source category, and `sourceInfo` path/source/scope/
origin/base directory. Built-in TUI commands such as `/settings` are not
discoverable RPC commands. Source metadata identifies command resources, not a
complete registry of every loaded extension. [R1, R2]

## Session history and persistence seams

One RPC process has one active session. `new_session`, `switch_session`, `fork`,
and `clone` replace that session; they do not add multiplexed sessions.

An extension can cancel switching/forking. `success: true` with
`cancelled: true` is a successful command execution without the requested
replacement. New identity/configuration must be read from the resulting active
state rather than inferred from the requested target.

| Query | History meaning |
| --- | --- |
| `get_messages` | Current session message state, not all raw append history |
| `get_entries` | All entries in append order, including abandoned branches and pre-compaction history |
| `get_entries { since }` | Entries after a stable entry ID; unknown cursor fails |
| `get_tree` | Entry tree/forest and active leaf ID |
| `get_fork_messages` | User entry identities eligible for forking |

Session JSONL version 3 has a header with ID/cwd and entries with stable
`id`/`parentId` and ISO timestamps. Nested message timestamps are numeric
milliseconds. Files can contain multiple branches; append order is not active
conversation order.

Entry types include messages, model/thinking changes, usage, compaction,
context edits, branch summaries, custom state/messages, labels, and session info.
Custom state does not enter model context. Custom messages do. Context edits
change future projected model input without rewriting original history or
billing. Compaction stores a prompt/tool checkpoint and a retained boundary.
Raw history, visible history, and model context are therefore different views.

There is no session listing RPC. Enumeration requires another contract, such as
documented session files or adapter-owned identities. There is also no direct
conversation navigation/file rollback command. `fork` creates a new session;
it is not automatically equivalent to in-place rewind. [R2, R7]

## Extension UI subprotocol

RPC extensions receive `ctx.mode === "rpc"` and `ctx.hasUI === true`. The UI
context is a proxy, not a real TUI. Checking only `hasUI` is insufficient for
custom terminal components. This is established by `rpc-mode.ts` binding its UI
context and the extension runner's `hasUI` implementation.

### Blocking dialogs

| Method | Request fields | Response |
| --- | --- | --- |
| `select` | Title, string options, optional timeout | Selected string or canceled |
| `confirm` | Title/message, optional timeout | Boolean or canceled |
| `input` | Title/placeholder, optional timeout | String or canceled |
| `editor` | Title/prefill | String or canceled |

```json
{"type":"extension_ui_request","id":"dialog-1","method":"select","title":"Allow this call?","options":["Allow","Block"],"timeout":10000}
{"type":"extension_ui_response","id":"dialog-1","value":"Allow"}
```

Timeout/signal handling resolves defaults inside Pi. Cancel resolves undefined
for select/input/editor and false for confirm. Editor has no timeout field in
this contract. A client that never answers can leave it pending indefinitely.
The UI subprotocol has no general dialog-expired notification for the host.

### Fire-and-forget records

- `notify`: message and optional info/warning/error level.
- `setStatus`: keyed status text; omitted text clears it.
- `setWidget`: keyed string lines and above/below-editor placement; omitted lines
  clear it. Component factories do not serialize.
- `setTitle`: display/window title.
- `set_editor_text`: requested editor content.

These use the request record shape but expect no response. They may arrive
outside active model turns. Ignoring them is different from supporting their
intended presentation.

### Degraded TUI operations

`custom()` returns undefined. Terminal input subscription is a no-op. Custom
header/footer/editor, working indicators, autocomplete contributions, and tool
expansion controls are unavailable. Editor readback returns empty/undefined;
theme listing/selection is unavailable. `pasteToEditor` becomes editor-text
setting rather than terminal paste handling.

Pi's tool/message/entry TUI renderer functions are not wire payloads. A remote
UI must render available data independently. The public Paseo plugin timeline
contract can express custom data, but does not execute Pi TUI components.
[R1, R2, R8]

## Extension activation and private event seams

Extensions load in RPC mode from configured/discovered resources and explicit
paths. Async factories are awaited. Provider/tool registrations, lifecycle
handlers, MCP registration, and session state work inside the Pi process.

Binding establishes `session_start`; replacement/reload/shutdown trigger
appropriate lifecycle events. `session_before_switch` and
`session_before_fork` can cancel operations. The RPC context also supplies
command-context actions such as navigation and reload to extension handlers,
even when core RPC has no matching standalone command.

`pi.events` is an in-process extension bus. Emitting `subagents:completed` does
not automatically stream a child transcript or create a new core RPC event.
To cross the boundary, an extension needs a serializable channel such as tool
details, custom messages, custom entries, or supported UI notifications.
[Report 5](05-personal-pi-plugins.md)

Pi has built-in MCP and public extension registration APIs, but no arbitrary MCP
configuration/login RPC command in this command union. CLI/file/extension
configuration must not be mislabeled as native RPC management.

## Cancellation, compaction, errors, and shutdown

`abort` waits for idle before replying. It does not itself clear queued input;
the documented Esc-like sequence is `clear_queue` then `abort`. Bash and retry
have separate abort commands. Tool cancellation and extension background-child
termination depend on their implementations and cannot be inferred from a
generic parent abort alone.

Compaction reports manual/threshold/overflow reasons. A completed overflow
compaction can set `willRetry` before another run. Summarization retries have
their own event family. Model errors after prompt admission appear through final
assistant/error/retry events; they do not require the process to exit.

Closing stdin requests orderly runtime disposal. Pi handles SIGTERM and, on
non-Windows systems, SIGHUP, with tracked-child cleanup and disposal. Extensions
can request shutdown, which is checked after commands or settlement. There is
no core `shutdown` command in the union.

Unexpected child exit, spawn failure, broken stdin, and unresponsive cleanup
remain transport errors for the client. Stderr is diagnostic evidence, not a
structured response. Pi's tracked-child cleanup does not prove containment of
every process an arbitrary extension launches. [R2, R3]

## Integration limits and open questions

1. Version compatibility is not negotiated on the wire. A supported version
   policy and behavioral probes remain undecided.
2. Accepted prompt identity and active turn identity need explicit adaptation to
   Paseo's `clientMessageId` and `turnId` contracts.
3. Core RPC has no session multiplexing, listing, first-class child-agent stream,
   exact tool-policy API, or arbitrary extension-state introspection.
4. Normal Pi extensions still run inside the child; their private event buses,
   files, custom UIs, and async lifetimes are not automatically exposed.
5. History APIs return different projections. Fidelity requirements must state
   whether they mean model context, raw transcript, or rendered history.
6. A missing core RPC command can sometimes be bridged with a public Pi
   extension. Whether and how to do that is a later design decision.

## Evidence and source map

Paths are relative to `~/workspace/pi` at `86dfceec4` unless stated otherwise.

| Ref | Source | Relevant content |
| --- | --- | --- |
| R1 | `packages/coding-agent/src/modes/rpc/rpc-types.ts:18-303` | Commands, responses, state, command discovery, UI unions |
| R2 | `packages/coding-agent/src/modes/rpc/rpc-mode.ts:51-145,315-445,447-709,724-821`; `modes/rpc/jsonl.ts:1-58` under the same coding-agent source directory | UI binding, async handling, command semantics, framing, shutdown |
| R3 | `packages/coding-agent/src/modes/rpc/rpc-client.ts:66-188,469-617` | Subprocess reference client, readiness delay, event waiting |
| R4 | `packages/coding-agent/src/modes/json-event.ts:1-61`; `core/agent-session.ts:182-240` under coding-agent source | Delta-only transformation and session event union |
| R5 | `packages/agent/src/types.ts:514-533` | Base agent/tool event union |
| R6 | `packages/ai/src/types.ts`; `packages/coding-agent/src/core/messages.ts`; active docs `message-types.md` and `rpc-commands.md` | Message/usage types and stats semantics |
| R7 | `packages/coding-agent/src/core/session-manager.ts`; active docs `session-format.md`, `cli.md` | Persisted tree, entry types, startup identity |
| R8 | `packages/coding-agent/src/core/extensions/runner.ts:564-622,877-884`; active docs `rpc-extension-ui.md` | `hasUI`, RPC mode, supported/degraded UI |

Active documentation root:
`~/.local/share/path-overrides/pi-local/docs`. Research read the RPC, command,
event, UI, message, session, extension, CLI, and related references. Live probes
were limited to response correlation/errors, basic lifecycle, queue/state/model
behavior. They did not establish exhaustive extension or mobile compatibility.
