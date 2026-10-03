# Personal Pi plugins and subagent contract

The personal Pi extensions expose more useful remote state than their terminal
renderers alone suggest, but their contracts use several different channels.
Tools, custom messages, custom entries, and UI notifications can cross Pi RPC.
Private extension events, process-global registries, and child transcript files
do not cross automatically.

The subagent extension deliberately resembles tintinweb for compatibility. That
is the existing contract, not a requirement to preserve it in a new integration.
The user has explicitly said emulation was convenient rather than inherently
the best interface.

## Scope and source snapshots

Root: `~/workspace/pi-stuff/pi-plugins`, revision
`05f22e92e928c0b754ac24e1df8b9b8268528d31`.

Packages inspected were `pi-subagents`, `pi-control`, `pi-microgpt`,
`pi-suppress-providers`, and `router-shadow`. The root README lists the first
four as published packages; router-shadow is a separate experiment in the same
packages directory.

The existing consumer was checked in `~/workspace/paseo` at `5293ddac3`. Historical
provider branches were inspected in `~/workspace/paseo-plugins`; their contents
are historical evidence, not an approved implementation baseline.

All five packages run as Pi extensions. The future Paseo provider must control
the root Pi process through subprocess RPC. The subagent extension's own use of
`createAgentSession` inside Pi is a separate execution layer and does not change
that boundary.

## Package integration map

| Package | Main behavior | Remote integration seam | State that stays private |
| --- | --- | --- | --- |
| `pi-subagents` | Background agents, policy/model locks, limits, result collection | Parent tool details, custom completion messages, child transcript paths | Child sessions, run registry, lineage, extension bus |
| `pi-control` | Tool/path policies, approvals, nudges, classifier decisions | RPC UI dialogs, notifications, persisted custom entries | Policy implementation, forwarding inbox/heartbeat, global serving-session state |
| `pi-microgpt` | Model-specific context/service tier and editing/search tools | Slash commands, correlated JSON notifications, ordinary tool events | Session toggle and tool-selection state |
| `pi-suppress-providers` | Restrict model discovery by temporarily suppressing auth environment | Pi's effective model catalog | Process environment mutation |
| `router-shadow` | Background routing experiments without changing actual model choice | Optional status/notifications | Async experiments, private child events, logs and HTTP calls |

## Subagent tool input contracts

The three tools are registered as `exposure: "model-only"`. They remain visible
in Pi's ordinary model tool stream, but are not automatically exposed as a
remote operator-control API or codemode-callable tool.

```ts
type AgentInput = {
  subagent_type: string;
  prompt: string;
  description: string;
  run_in_background?: boolean;
  model?: string;
  thinking?: string;
  included_tools?: string[];
  excluded_tools?: string[];
  extensions?: string[];
};

type GetResultInput = { agent_id: string; wait?: boolean };
type SteerInput = { agent_id: string; message: string };
```

Schemas reject additional properties. `run_in_background` is accepted for
compatibility but ignored: every child is background. `get_subagent_result`
does not accept tintinweb's `verbose`; `steer_subagent` has no `cancel` field.
There is no tool argument for restoring a prior run.

Spawn returns a run identity promptly; `wait: true` is the explicit blocking
collection operation. Steering interrupts neither a completed run nor the
current tool execution directly; it queues a steering message for the child.
This distinction matters when presenting a child as running after the parent
spawn tool has already completed. [S1]

## Tool results and identity

### Spawn text

The background result follows this layout:

```text
Agent started in background.
Agent ID: <12-hex-id>
Type: <display-name>
Description: <description>
Output file: <child-session-jsonl>

Paseo gets a completion notification when this agent finishes, but it won't wake you:
You MUST call get_subagent_result with wait: true for this agent before finishing.
Do not duplicate this agent's work.
```

The `Output file:` line intentionally supports Paseo's existing tintinweb parser.
That parser uses a whole-line non-whitespace regex; a path containing spaces
cannot be discovered through this text path. Completion details can provide
the structured file path separately.

The Pi tool invocation ID, extension's 12-hex run ID, Pi child session ID, child
file path, and any Paseo provider child-session ID are distinct identities.
The native consumer maps the run ID to the original spawning call ID rather
than using one identity for everything.

### Spawn details

```ts
type BackgroundDetails = {
  displayName: string;
  description: string;
  subagentType: string;
  modelName?: string;
  tags?: string[];
  toolUses: 0;
  tokens: "";
  durationMs: 0;
  status: "background";
  agentId: string;
};
```

Those zero metrics are initial presentation, not live totals. `turnCount` and
`maxTurns` are not fields in current background details. Consumers expecting
them at spawn time are reading a different result builder or an older contract.

Tags describe selected properties such as background operation, thinking, and
turn limit. They are human-readable display fields, not authoritative machine
policy or ancestry.

### Follow-up details

```ts
type OperationDetails = {
  agentId: string;
  operation: "wait" | "result" | "steer";
  subagentType: string;
  description: string;
  status: SubagentStatus;
};
```

Current get-result and steer implementations return this structured object.
Some invariant documentation describes tintinweb-style summary text with
`details: null`; the current source differs. Playback tests compare result text
for this path and do not pin null details. The current object is the reliable
source contract. [S1, S2]

## Background execution and admission rules

`spawnSubagent` creates an in-process child Pi session using a resource loader,
settings manager, and a separate session manager. It is not a subprocess per
child. Root subprocess isolation therefore does not isolate siblings from one
another's process globals or extension failures.

### No implemented concurrency queue

`queued` exists in the status union, and a result-text helper can print queue
position. The inspected spawn path has no `maxConcurrent` gate and never calls
that helper with queued options. Every admitted Agent call starts immediately.
Concurrency is not bounded by an operator queue in this implementation.

This is a verified distinction between type/presentation vocabulary and working
behavior. It does not recommend adding a queue or choose concurrency semantics.
[S2, S3]

### Model and thinking selection

Agent definitions may set model, thinking, max turns, context inheritance, and
other options. Caller overrides win unless the definition locks that field.
`locked: true` locks configured fields; a list names specific locked fields.

An unresolvable caller model refuses admission. An unresolvable model from a
definition can fall back to the parent. An unsupported caller thinking level
refuses; a definition's unsupported thinking selection is dropped. These are
different error/fallback contracts and should not be presented as one universal
model resolution policy. [S4]

### Context, tools, and extensions

- `inherit_context: true` is not supported in v1 and refuses admission.
- Omitted included-tools means all available tools; `included_tools: []` means
  none. Excluded tools always win.
- MCP tool selectors canonicalize hyphens to underscores.
- Tool policy is enforced when declarations/active tools are prepared and again
  during tool execution, including nested calls.
- Caller extension references must resolve through the operator's approved map.
  Exclusions win. Mandatory codemode/tool-search/MCP factories are included.
- The extension loads its own entry in children so the child execution gate
  exists. Failure to resolve that self-extension path fails closed.

Tool declaration, enabled tool availability, and actual tool execution gating
are separate checks. Merely hiding a tool from the model is not the policy's
only enforcement mechanism. None of this policy state is a built-in Paseo
`permission.tool_policy` payload. [S4]

### Depth and lineage

Root depth is zero; children increment it. Operator `maxDepth` defaults to one.
Per-agent ceilings can narrow, not expand, the inherited ceiling. At the
ceiling, spawner tools are hidden and blocked by the execution gate.

Lineage uses a process-global registry keyed through `globalThis`/`Symbol.for`
because jiti can isolate module instances between sessions. That registry is
not a serialized RPC state object. A root Pi restart loses it. [S4]

## State machine, metrics, and termination

Status vocabulary is:

```text
queued | running | background | completed | steered | aborted | stopped | error
```

Terminal statuses are completed, steered, aborted, stopped, and error.
`SubagentRun.transition` refuses changes after terminal state. The registry's
settled promise is a local wait primitive, not a core Pi RPC response.

Metrics come from child session events:

| Metric | Source |
| --- | --- |
| Tool uses | `tool_execution_end` count |
| Turn count | `turn_end` count |
| Lifetime usage | Assistant `message_end` usage |
| Reported total tokens | Input + output + cache-write counters in this implementation |
| Context percentage | Best-effort child `getContextUsage()` |
| Duration | Start/end times |

These counters are the extension's accounting, not a guarantee that they match
Pi full-session statistics or every provider's cache accounting.

### Turn limit

`max_turns` is definition-driven. Reaching it sends a wrap-up steering message
and records soft-limit state. Five grace turns later, the extension aborts if
work continues. A soft-limit finish is terminal `steered`; a hard-limit abort is
`aborted` with a max-turns error.

### Timeout and abort

A definition's `timeout_minutes` triggers aborted termination. No operator-wide
default timeout was found. Termination intent aborts a controller wired to the
child session's abort operation. Aborting a blocking get-result wait also
terminates its child; it is not merely canceling observation.

Explicit stopped/aborted intent wins over provider error. Otherwise provider
error maps to error, hard turn-limit abort to aborted, soft wrap-up to steered,
and normal completion to completed. A model returning `stopReason: "error"`
must not be mistaken for successful child completion. [S3]

## Completion notification contract

The current implementation sends terminal notification once per run:

```ts
{
  customType: "subagent-notification",
  display: true,
  content: "...code-fenced completion summary...",
  details: {
    id: "run-id",
    description: "...",
    status: "completed",
    toolUses: 12,
    turnCount: 4,
    maxTurns: 20,
    totalTokens: 10000,
    durationMs: 1500,
    outputFile: "/.../child.jsonl",
    resultPreview: "..."
  }
}
```

`maxTurns`, `outputFile`, and `error` are optional. `steered` is normalized to
completed in notification details, but not in follow-up tool operation details.
The preview is bounded to 500 characters in the current terminal send path.

Delivery is always `{ deliverAs: "followUp", triggerTurn: false }`. The
notification updates the transcript/remote observer without waking the parent
into another model turn. Waiting for the result does not suppress notification.

Human-facing content is currently a fenced plain-text block naming the result
and transcript files. It is not the older tintinweb XML `<task-notification>`
body. Structured metadata is the more stable completion seam.

Relevant history explains why this separation matters:

- `4bd36ba` introduced result claiming that could suppress notifications.
- `ce64495` restored terminal reporting while suppressing only wake-up turns;
  otherwise Paseo lost its completion signal.
- `5b6a4d2` removed result claiming and made no-wake delivery unconditional.
- `54a9cf7` normalized terminal steered notification status to completed.

This history supports always reporting completion even when the model waits.
It does not establish that early nonterminal notifications are a current bug;
the inspected terminal callback has no such path. [S1, S2]

## Persistence and cleanup limits

Child transcripts are Pi JSONL under `<agentDir>/subagents/<runId>/`. A terminal
result is written as `result.md` beside the transcript. If result writing fails,
the notification falls back to pointing at result collection rather than
claiming a durable result file.

The run registry is process-global memory. There is no serialized run/lineage
registry or run-resume path. The existence of transcript and result files does
not make `get_subagent_result` usable after a restart.

On parent `session_shutdown`, owned nonterminal runs are aborted, children
disposed, registry entries removed, and lineage cleaned up. A resumed parent
does not reconstruct those Agent handles. Historical metadata may still be
renderable, but active control and result lookup have been lost. [S3]

## RPC-visible data versus private channels

| Data | Channel | Crosses root Pi RPC? |
| --- | --- | --- |
| Spawn args/result/details | Parent tool execution and tool-result messages | Yes |
| Get-result/steer status | Parent follow-up tool details | Yes |
| Completion summary/details | Custom message `subagent-notification` | Yes, through message/history channels |
| Child transcript path | Spawn text or completion details | Yes, path only |
| Child live messages | Child session events / JSONL | Not automatically; file or another bridge needed |
| `subagents:created/started/completed/failed/steered` | `pi.events` | No |
| `subagents:child:session-created/disposed` | `pi.events` | No |
| Registry, lineage, approved refs | In-process state | No |
| TUI Agent/message renderer | Function/component inside Pi | No |

A private bus event can coordinate extensions inside Pi while remaining invisible
to the external provider. Reading the child file is an out-of-band filesystem
contract even when the file path arrived through RPC. Parent completion metadata
is not the same as a full child event stream.

## Existing native Paseo consumption and losses

Paseo's daemon-side tintinweb adapter recognizes these tool/custom-type shapes
without checking the package identity. It maps extension run IDs to spawning
tool IDs, parses `Output file:`, and follows JSONL every 250 ms. It emits internal
`provider_subagent` events, not public provider-plugin `session.opened` events.

The current native consumer covers useful parts of the contract, but that does
not prove complete support:

- Child view stops at a cumulative 2 MiB/200 timeline-item prefix.
- Replay charges a 16 MiB budget, allowing at most eight full-budget child reads.
- Child ancestry and richer metrics do not automatically become first-class
  subagent descriptors.
- No native terminal `steered` mapping exists. A completed notification followed
  by get-result `status: "steered"` can set the host card running again.
- Notifications for unknown run IDs are skipped rather than generically buffered.
- Transcript following does not restore extension handles or enable child control.

These are source-derived seams and limits, not evidence that the user's broader
native-provider problems are already solved. [Report 2](02-paseo-native-pi-omp.md)

## pi-control approval forwarding

pi-control intercepts tool execution for policy actions: allow, nudge, log, ask,
deny, and classifier-backed auto decisions. Its native policy language is richer
than Paseo's exact MCP-preapproval record and remains Pi-side enforcement.

Child asks can be forwarded through disk-backed request/response inboxes,
heartbeats, and process-global serving-session state. That forwarding transport
is not root Pi RPC. The serving parent renders a normal `ctx.ui.select`; that
dialog does cross root RPC as `extension_ui_request`.

Only a session with `ctx.hasUI` serves an inbox. Pi RPC provides a real proxy UI
context with `hasUI === true`, so the root meets that code-level condition. The
end-to-end path still depends on the remote host answering the select request,
forwarding liveness, and child policy behavior. It was not smoke-tested here.

Notifications expose decisions to remote UIs; custom entries preserve some
decision history without adding it to model context. Custom entry renderers
remain TUI-only. A generic native Paseo notification is not equivalent to a
rich decision card, and suppressing a notification can remove useful remote
observability. [S5]

## pi-microgpt commands and structured notifications

The extension controls long context, priority Fast mode, Flex mode, optional
Codex web search, and `apply_patch`. Mode applicability depends on model/API
identity; Fast and Flex are mutually exclusive. State is session-local and
resets on relevant lifecycle boundaries.

Commands intentionally avoid a custom TUI. They emit JSON strings through
`ctx.ui.notify`:

```json
{
  "type": "pi-microgpt.response",
  "command": "fast",
  "success": true,
  "requestId": "fast-1",
  "enabled": true,
  "serviceTier": "priority",
  "supported": true,
  "provider": "provider-id",
  "model": "model-id",
  "api": "openai-codex-responses"
}
```

The extension-defined `requestId` is separate from the outer Pi RPC command ID.
JSON command arguments support actions toggle/on/off/status and request ID:

```text
/fast {"action":"status","requestId":"fast-1"}
```

This gives a remote adapter a machine-readable command-result seam. Native
Paseo has no parser for `pi-microgpt.response` in the inspected source and renders
it as generic notification text.

`apply_patch` is an ordinary model tool using an `input: string` patch schema.
Web search registration requires its startup flag, and later session enablement
is separate. Both tools' outputs/details cross the normal tool stream, but a
generic tool renderer does not necessarily interpret a multi-file patch or rich
search payload accurately. [S6]

## pi-suppress-providers and model discovery

This extension reads enabled provider settings and removes nonenabled providers'
credential environment variables during loading. Ambient Bedrock/Vertex
credentials receive explicit handling. Shared credential variables cannot
necessarily distinguish provider identities.

Current source restores suppressed variables on `before_agent_start` and deletes
them again on `agent_end`. Its README instead describes restoration at
`session_start`. The source is authoritative for this snapshot.

The effective model catalog is therefore influenced by extension loading and
process environment, not just an adapter's configured model list. Separate
catalog/session processes or resource configurations can observe different
availability. That is an integration seam to document, not a reason to rewrite
user credentials or persist suppression state externally. [S7]

## router-shadow asynchronous behavior

router-shadow snapshots real turns and runs background routing candidates
without changing the selected model. Work depends on external HTTP calls,
bounded context/logging, and a maximum of two in-flight experiments. Shutdown
aborts outstanding controllers.

It listens to private `subagents:child:session-created/disposed` events to tag
child work, with a parent-session-header fallback. Those events stay inside Pi.
Status/notification output uses `ctx.ui`; custom footer behavior is best-effort
and unavailable in RPC's TUI-less context. Background routing/log state is not
an automatic custom-message or child-timeline stream. [S8]

## Historical standalone provider appendix

Prior `pi-plugin-mcowger` branches include both subprocess-RPC and in-process SDK
attempts. Inspected branch tips include:

| Branch | Tip | Evidence |
| --- | --- | --- |
| `add-subagent-parsing-support` | `6171ccc` | Subagent sources wire wj/super-agent parsers |
| `rebuild-pi-plugin-mcowger-from-in-tree-json-rpc-provider` | `cabcdb0` | RPC-based rebuild attempt |
| `evaluate-live-pi-subagents-lite-injection-options` | `edb6239` | Later SDK/injection plan |
| `implement/pi-plugin-mcowger-docs-ng` | `0d28078` | Public provider registration and child-session events |

These parsers did not cover the current mcowger/tintinweb background contract.
Historical notes scoped detached background runs out and recorded startup delays,
process-lifecycle crash loops, and marker fragility in the earlier RPC approach.
Those are historical findings, not current measured defects in Pi 1.0.0.

The SDK pivot does not reopen the present subprocess-RPC decision. Reuse scope,
if any, remains undecided, and the old SDK baseline differs from the current
Paseo project baseline.

## Tests, discrepancies, and open questions

Playback fixtures compare recorded tintinweb and personal traces. They establish
specific compatibility assertions, not all fields/ordering. Older success
fixtures still contain XML notification content while current source emits
fenced text; those text bodies are not fully pinned by the playback comparison.

Source verification corrected several misleading assumptions:

1. Follow-up details are structured, not null.
2. Queued vocabulary does not imply a functioning concurrency queue.
3. Spawn details do not carry terminal/live metrics.
4. Files survive independently of the in-memory run registry.
5. UI `hasUI` in Pi RPC does not imply TUI component availability.
6. Terminal reporting and parent wake-up are separate controls.
7. Private bus events are not generic RPC subagent records.

Later requirements need to distinguish observation, child control, result lookup,
resume, nesting, richer metrics, extension command controls, and policy approval
UX. The research does not require retaining tintinweb emulation or choose a new
event schema.

## Evidence and source map

Paths below are relative to `~/workspace/pi-stuff/pi-plugins` at `05f22e92`.

| Ref | Source | Relevant content |
| --- | --- | --- |
| S1 | `packages/pi-subagents/src/tools.ts:155-225,262-296,353-436`; `packages/pi-subagents/index.ts:28-78,147-177` | Schemas, tools, policy, notifications, shutdown |
| S2 | `packages/pi-subagents/src/transcript.ts:155-215,249-283,322-341,383-392,466-490`; `tests/playback.test.ts` under that package | Result/notification metadata, delivery, files, compatibility assertions |
| S3 | `packages/pi-subagents/src/runtime.ts:93-121,165-345,409-491`; `src/run.ts:27-29,108-114,156-196`; `src/status.ts` under that package | SDK children, metrics, limits, terminal state, registry |
| S4 | `packages/pi-subagents/src/invocation.ts:44-120`; `src/model.ts:115-156`; `src/selectors.ts:10-27`; `src/gate.ts:18-59`; `src/extensions.ts:15-41`; `src/lineage.ts:29-74` | Model/thinking/tool/extension locks and depth |
| S5 | `packages/pi-control/src/index.ts:44-78`; `src/utils/forwarding.ts:145-230,289-360`; `src/utils/subagent.ts` under that package | Policy output, file forwarding, serving-session state |
| S6 | `packages/pi-microgpt/src/index.ts:84-90,155-159,331-349`; `packages/pi-microgpt/API.md` | Correlated notifications, commands, patch/search tools |
| S7 | `packages/pi-suppress-providers/index.ts:5-23`; `src/provider-env.ts:3-54`; `src/settings.ts` under that package | Discovery-time credential suppression and restoration hooks |
| S8 | `packages/router-shadow/src/index.ts:138-208,466-560`; `packages/router-shadow/README.md` | Private child events, status, async limits and teardown |

Design/invariant references: `packages/pi-subagents/DESIGN.md` and `AGENTS.md`.
Current code takes precedence where the documented invariant and implementation
disagree. External test suites and end-to-end Paseo extension combinations were
not run during this documentation work.
