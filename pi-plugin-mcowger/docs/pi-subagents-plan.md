# Pi subagents virtual-session plan

This is the implementation plan for representing foreground `pi-subagents`
work as Paseo child sessions in `pi-plugin-mcowger`.

The provider must recognize the public shape of the Pi RPC tool events, not
whether a particular extension package or command is installed. A compatible
extension can therefore participate, while an unrelated tool named
`subagent` cannot create child sessions unless it supplies the expected
delegation result contract.

`nico-subagents-rpc.md` records the real foreground frames used to derive
this plan.

## Goal and limits

For a foreground delegation such as:

```ts
subagent({ agent: "scout", async: false, task: "Inspect package.json" })
```

Paseo should show:

- the normal parent `subagent` tool call;
- one virtual Paseo child per result index, nested under the parent session;
- each child's running/completed/failed state;
- the best live assistant preview, active tool, recent tools, model,
  thinking level, duration, and token/cost data supplied by the extension;
- a terminal child turn even when the only usable frame is the parent
  `tool_execution_end` event.

This first slice is deliberately foreground-only. It does not read Nico's
private async status files, launch or control child sessions, replay child
transcripts, or attempt to reconstruct nested children from a transcript.
Those are useful follow-ups, but they need a separate file-access and
authorization design. The virtual children are display-only, so their
capabilities are empty.

## Paseo contract and ordering

Advertise `session.subsession` in `CAPABILITIES` in
[`server/provider.ts`](../server/provider.ts). It is a negotiated connection
capability, not a `ProviderInput` capability.

When a qualifying child first appears, emit these events in order:

1. `session.opened` with a stable child ID, the already-open parent session
   ID, `restoration: "parent"`, `capabilities: []`, the root session cwd, and
   child title/description when available.
2. `session.ready` for the child.
3. `session.turn` with `state: "started"` if the child is running.
4. Child-scoped timeline/config/usage events.

A child discovered already terminal still gets an opened and ready event,
followed by a short synthetic turn (`started`, then its terminal state) when
there is terminal content or status to present. Paseo derives its visible
status from `session.turn`, `session.closed`, or `session.runtime_failed`;
`session.ready` alone does not complete a session.

The root session must have emitted `session.opened` before any child event.
The current provider opens the root, initializes it, optionally replays
history, then emits root `session.ready`. Live delegation cannot start before
the host can prompt the root, but replay can discover historic data while
that open is pending. The implementation should either publish discovered
children after root ready or rely only on the provider runtime's documented
pending-open buffering. Publishing them after root ready is clearer and
avoids depending on that implementation detail.

No `session.open` or `session.close` request arrives for a
`restoration: "parent"` child. `PiProviderSession.close()` must therefore
terminalize its virtual children and release their state when the root or
connection closes.

## Recognition rule

Recognition is a two-stage check:

1. On a `tool_execution_start`, remember only an *unconfirmed candidate*
   when `toolName === "subagent"` and `args` is an object. Keep its parent
   Pi `toolCallId`, agent/task hints, and the Paseo parent tool call.
2. Treat it as a delegation only when a later
   `tool_execution_update.partialResult` or `tool_execution_end.result` has
   a valid `details` object with:
   - a non-empty `runId` string; and
   - at least one valid result or progress entry with a non-negative integer
     `index` and a non-empty `agent` string.

The final condition is important. The broad `subagent` name is only a cheap
candidate filter. The `runId` plus indexed child records are the exposed
delegation protocol fingerprint, and avoid a dependency on Nico's package
name, command descriptions, extension source path, or source-info metadata.

Use permissive, bounded Zod schemas for the known fields and discard unknown
fields. Do not require `mode`, `context`, `sessionFile`, or `transcriptPath`:
those are useful metadata but are not needed to identify a live foreground
child. Reject invalid entries individually instead of rejecting a valid
sibling in the same update.

Suggested bounds for this first implementation:

```ts
const MAX_SUBAGENT_CHILDREN_PER_TOOL = 128;
const MAX_SUBAGENT_CHILDREN_PER_SESSION = 1_024;
const MAX_SUBAGENT_TEXT_BYTES = 64 * 1024;
const MAX_SUBAGENT_TOOL_ARGS_BYTES = 16 * 1024;
const MAX_SUBAGENT_RECENT_OUTPUT_ITEMS = 32;
const MAX_SUBAGENT_RECENT_TOOLS = 128;
```

The values are untrusted extension output. Normalize numeric counters to
finite non-negative integers, truncate display strings by UTF-8 bytes, and
never expose transcript, artifact, or session paths as client-provided file
links in this slice.

## State model

Add a server-only `NicoSubagentProjector` (the name should describe the
protocol rather than establish package detection), constructed by each
`PiProviderSession`.

The projector owns the following state per root session:

```ts
type PendingDelegation = {
  parentToolCallId: string;
  parentToolName: string;
  candidate: boolean;
  children: Set<string>;
  terminal: boolean;
};

type ChildKey = `${string}:${number}`; // `${runId}:${index}`

type VirtualChild = {
  key: ChildKey;
  sessionId: string;
  parentToolCallId: string;
  turnId: string;
  status: "running" | "completed" | "failed" | "canceled";
  opened: boolean;
  ready: boolean;
  title: string;
  description?: string;
  model?: string;
  thinking?: string;
  activeTool?: ActiveTool;
  recentToolFingerprints: Set<string>;
  lastSnapshot?: ChildSnapshot;
};
```

The identity is `details.runId + ":" + result.index`, never the parent Pi
`toolCallId`, for ordinary single, parallel, and chain results. Workflow
children are different: every workflow child can return a nested result with
`index: 0`. When a result has `workflowKey`, use
`details.runId + ":workflow:" + workflowKey + ":" + result.index` instead.
`details.workflowChildren.children[].childId` is the same workflow identity
and is the fallback inventory when compact workflow results omit individual
child rows. Several child records may share one parent tool call, and the
same child key appears in every update and terminal result.

Provider session IDs should be deterministic and namespaced so different root
Pi sessions cannot collide. For example, hash the root Paseo session ID plus
the child key and prefix the result with `pi:subsession:`. Keep the source
key in memory for reconciliation; the opaque provider session ID is what
Paseo sees.

The child initially belongs to the root Paseo session. This phase has no
reliable root-RPC transport for a grandchild's own `subagent` frames, so it
must not invent a nested relationship. A future transcript-backed nested
projection would emit `session.subsession` for every virtual session that may
be a parent and assign the actual parent from the persisted child transcript.

## Event routing

`PiProviderSession.onEvent()` currently sends every Pi tool event through
`toolCalls` and `mapToolDetail`. Add the projector branch before generic tool
mapping, while retaining the generic parent tool timeline item.

| Pi event | Projector work | Existing parent timeline work |
| --- | --- | --- |
| `tool_execution_start` | Record an unconfirmed candidate. | Emit the running `subagent` tool call as today. |
| `tool_execution_update` | Parse and fold qualifying child records. Open children on first sight; update child rows only when mapped state changed. | Keep the parent tool running. |
| `tool_execution_end` | Fold final records, append terminal preview, and complete/fail outstanding children. If the parent event errors, fail still-running children. | Complete/fail the parent tool as today. |
| root `agent_end` / `agent_settled` | Do not end children prematurely when the delegating tool is still active. On root finalization, fail or complete only children with unambiguous terminal data; leave no running synthetic turn after the root ends. | Existing root completion behavior. |
| `process_exit` / provider close | Cancel active child turns; clear maps. | Existing root failure/cleanup behavior. |

When the first child is recognized, re-emit the existing parent tool call with
the same ID and `detail.type: "sub_agent"`. For a single child, set
`childSessionId`; for a multi-child dispatch, retain the parent row as the
aggregate and link the first child only if Paseo's UI treats that field as a
single navigation target. Do not create duplicate parent tool rows.

## Child projection fidelity

### Child title and config

- `progress.agent` or `result.agent` becomes the child title.
- `sessionName`, when present and different from the agent, becomes the
  description.
- `model` and `thinking` become a child `session.config` update. The model is
  display metadata, not a selectable model list, so use a compact config with
  its current model/think option and empty selectable lists if Paseo needs a
  config event. If the host does not render that compact config well, include
  both values in a child notification until the provider config shape gains a
  metadata field.
- A child has `capabilities: []`; it cannot be prompted, configured,
  interrupted, reverted, or persisted through the provider API.

### Assistant preview

For each child use one stable timeline ID, for example
`<child-session>:assistant-preview`. Update it in place with the latest
bounded text from `partialResult.content`, preferring text content blocks.
The terminal `result.content` replaces that preview with the final text when
present. Empty previews do not emit a row.

`recentOutput` is supplemental status text, not a child transcript. Do not
render it as fake assistant messages or notification cards. Use it only as a
fallback preview when `partialResult.content` is absent, and never append the
same preview repeatedly on heartbeat updates.

### Tool activity

The live protocol exposes `results[index].toolCalls` as the current child tool
list, but it does not expose tool-call IDs or results. Represent it honestly:

- Project each `toolCalls` entry as a stable synthetic child tool row. Parse
  `$ command` as a shell detail and `name {"path":"..."}` as a named tool
  with its JSON arguments. Mark the entry matching `currentTool` running.
- Reconcile `recentTools` against recorded entries to complete them. Only emit
  a summary row when no recorded entry matches, so the two fields do not
  produce duplicate tool rows.

- When `currentTool` has no recorded match, emit a fallback `tool_call` with
  a stable synthetic ID, `status: "running"`, and a compact mapped detail.
- When it disappears or changes, complete that synthetic tool call.
- Do not derive a shell cwd from `currentPath`; a discovered file path is not
  the process working directory.

Do not use `mapToolDetail()` for fallback summaries. It expects real Pi tool
args/results and would falsely imply details that Nico did not send.

### Usage

Use the most complete values available:

- live `inputTokens`, `outputTokens`, and `tokens` describe current progress;
- live `window` and `windowPeak` describe context use; map `window` to
  Paseo's `contextWindowUsedTokens`;
- terminal `usage` supplies `input`, `output`, `cacheRead`, `cacheWrite`,
  `cost`, and `turns`.

Map input/output/cache-read/cost to `ProviderUsage`. Paseo has no direct
cache-write or turn-count field, so preserve those values in the in-memory
snapshot and include them in a compact notification only if there is user
visible value. Do not overwrite a known terminal usage value with a poorer
heartbeat value.

`progressSummary` remains on a compact terminal result after the full live
progress record has gone away. Retain its tool count, tokens, and duration for
the projection state. Paseo has no child-session fields for those values, so
do not invent a timeline message just to display them.

### Terminal status

Map explicit child status as follows:

| Nico status/evidence | Paseo child turn |
| --- | --- |
| `running` | `started` |
| `completed` | `completed` |
| `failed`, non-zero `exitCode`, or child error | `failed` |
| `aborted`, `canceled`, `cancelled`, or parent/root cleanup | `canceled` |
| parent `tool_execution_end.isError` with an active child | `failed` |
| successful terminal parent event and an active child with no explicit child status | `completed` |

Finish an active synthetic tool before its child turn. A terminal transition
is idempotent. Repeated terminal updates must not append more rows or emit a
second terminal `session.turn`.

## Replay and recovery

Live frame recognition is the first implementation. The provider already
replays root Pi messages, but standard Pi history stores the final subagent
tool result rather than ephemeral `tool_execution_update` frames. During
root history replay, inspect a `toolResult` whose `toolName` is `subagent`
with the same qualifying final details and create terminal virtual children.

Do not read the reported `transcriptPath`, `sessionFile`, or `artifactPaths`
in this slice. They are useful future recovery sources, but reading them
requires canonicalization, parent-directory restrictions, file-size limits,
JSONL validation, and a decision about whether a restored virtual child is
durable enough to advertise persistence.

## Tests

Add focused unit tests beside the provider session tests.

1. **Recognition.** A generic `subagent` event with no qualifying details
   remains only a normal parent tool call. A valid `runId` and indexed child
   opens exactly one child.
2. **Package independence.** Valid frames whose tool metadata/source has an
   unrelated package name still work. Invalid `runId`, missing agent, or bad
   index do not.
3. **Stable identity and dedupe.** Repeated snapshots produce one
   `session.opened`, one ready event, and no duplicate preview/recent-tool
   rows. Two indices under one run create two distinct child sessions. A
   workflow with several `index: 0` results distinguished by `workflowKey`
   also creates one child per workflow key.
4. **Ordering.** Assert `session.opened`, `session.ready`, child `started`,
   and child timeline/usage events occur in valid order and after the root
   open.
5. **Live mapping.** Verify model/thinking, active-tool replacement,
   recent-tool folding, preview replacement, and usage mapping using the
   captured fixture shape from `nico-subagents-rpc.md`.
6. **Terminal mapping.** Cover completed, explicit failure, non-zero exit,
   canceled, parent-error, and terminal-only discovery.
7. **Cleanup.** Root close/process exit emits exactly one canceled child turn
   per active child and releases timers/maps.
8. **History.** A replayed terminal parent tool result creates completed
   virtual children without relying on live update frames.
9. **Capability negotiation.** A connection that offers
   `session.subsession` receives it in the root's opened capabilities; one
   that does not offer it must not publish virtual child events.
10. **Output fidelity.** Cover live usage plus result usage, terminal
    `progressSummary`, child-scoped synthetic tool IDs, compacted tool argument
    matching, and terminal parent aggregate text without a child final output.

Run from `pi-plugin-mcowger`:

```sh
npm run lint
npm run typecheck
npm test
```

Then install/reload through the Paseo plugin CLI, inspect the plugin logs,
and run a real foreground Nico delegation. Confirm that the root remains
healthy, the child appears below it, live activity changes without duplicate
rows, and the child reaches its expected terminal state.

## Implementation sequence

1. Add the schemas and pure parser/projector state machine with fixture tests.
2. Add `session.subsession` negotiation and wire the projector into
   `PiProviderSession` event handling, keeping generic parent tool mapping.
3. Implement live child opening, preview/tool/usage projection, terminal
   cleanup, and lifecycle tests.
4. Add terminal-result history projection.
5. Run the static checks and the real foreground delegation smoke test.
6. Only after that, decide whether transcript replay, nested descendants, or
   async artifact observation earns its additional security and lifecycle
   complexity.
