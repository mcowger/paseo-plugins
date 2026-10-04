# Superpi technical design and implementation plan

Status: implemented architecture and original staged acceptance goals for the
[V1 requirements](requirements.md), updated through Plexus policy discovery.
Use the [provider README](../README.md) for the current feature/limit summary.
The companion envelopes below are implemented extension contracts, not core Pi
RPC commands. No Pi/Paseo core changes are authorized.

## Approach

Build a direct Paseo provider around one Pi RPC subprocess per root session.
Use a required Pi companion extension for integration controls and tree
navigation, and an explicit bridge from the owned subagent extension for child
activity. Keep the normal Paseo composer, timeline, and child views.

The implemented root lifecycle is:

```text
launch -> handshake -> prompt -> stream -> settle -> close -> reopen history
```

Composer controls, attachments/dialogs, child observation, and Pi branch rewind
are implemented. The host's visible-history replacement gap remains unresolved.
Do not build an exhaustive backend matrix. Expose advertised tier/context policy,
preserve saved intent where supported, and surface application/request errors.

## Runtime boundaries

```text
Paseo client
  native composer, timeline, permissions, child views
    | provider operations through the host
    | optional direct plugin RPC for integration actions/details
    v
Superpi plugin server
  provider connection + shared session registry
  command transport / timeline projection / durable metadata
    | stdin/stdout Pi JSONL RPC
    v
Pi root subprocess
  normal resources + Superpi companion
  owned pi-subagents extension -> child Pi sessions
    | public extension commands and versioned integration envelopes
    v
Superpi server translates state back into public provider events
```

The companion runs inside Pi, not inside the Paseo plugin runtime. Existing
in-process child execution in `pi-subagents` remains its own implementation.
Superpi must not use `createAgentSession` to execute the root agent.

### Code organization

| Location | Responsibility |
| --- | --- |
| `superpi/index.server.ts` | Register provider, optional plugin RPC handlers, and idempotent teardown. |
| `superpi/server/provider.ts` | Public provider requests/events and capability advertisement. |
| `superpi/server/session.ts` | Session ownership, admission, lifecycle coordination, native state. |
| `superpi/server/pi-rpc.ts` | Process launch, UTF-8 JSONL framing, correlation, backpressure, exit handling. |
| `superpi/server/timeline.ts` | Pure-event folding into full Paseo snapshots and stable identities. |
| `superpi/server/persistence.ts`, `child-journal.ts` | Versioned session metadata, child journal, authorized restore. |
| `superpi/server/subagents.ts` | Owned bridge events into read-only provider subsessions. |
| `superpi/shared/` | Serializable contracts, Zod schemas, presentation-independent types. |
| `superpi/client/`, `index.client.tsx` | Only necessary plugin UI/RPC contributions; no replacement tool renderer. |
| `superpi-companion/index.ts`, `src/` | Pi extension entry, controls, handshake, rewind, bridge serialization. |
| Companion `context-policy.ts`, `service-tiers.ts`, `policy-consumer.ts` | Correlated, revisioned Plexus policy snapshots on Pi's public bus. |
| Companion `context.ts`, `tier.ts` | Session-local model budgeting and exact advertised tier injection. |
| Owned `pi-subagents` package | Explicit event export, independent child defaults, durable run metadata. |

Keep Paseo code under its strict client/server/shared boundaries. The companion
is a separate Pi-loadable package, not a Paseo runtime entry or a second root
execution SDK integration.

## 1. Provider registration and discovery

- Register a distinct `superpi` provider. Do not patch the built-in Pi provider.
- Retain the 0.10.0 dependency baseline. Runtime checks used host 0.11.0-beta.3
  and Pi 1.0.0+local. Verify native feature
  discovery and required history behavior against the chosen installed host;
  explicitly rebaseline only if required available APIs demand it.
- Discover Pi's actual model catalog, thinking choices, and defaults using the
  same executable, cwd, environment, and resource rules as session launch.
- Publish model/thinking choices and policy-discovered tier/context selectors through
  public provider configuration. Do not simulate Pi modes.
- Catalog discovery currently opts out of host caching (`getCatalogCacheKey`
  returns `undefined`). Any future cache must include configuration/workspace identity.
- Temporary discovery sessions must never submit model work, change global
  defaults, spawn subagents, or leave processes/subscriptions alive. Normal
  extension startup can have effects; observe and report them rather than claim
  that arbitrary third-party factories are side-effect-free.
- Advertise capabilities only after their implementation is tested. No file
  revert, native fork, exact MCP preapproval, or arbitrary child control claims.

## 2. Root session and transport

### Identity and ownership

Maintain a registry of owned sessions with separate provider session ID, Pi
session ID, native transcript identity, and live process generation. Prompt
`clientMessageId`, turn ID, native request ID, and tool call ID remain distinct.

Use an opaque integration session key for internal/direct RPC lookup. Resolve
host-agent association through supported lifecycle context when necessary;
don't assume `session.open` includes a Paseo agent ID. A direct handler accepts
stable identity, verifies ownership and generation, and resolves native resources
server-side. It must not accept arbitrary executable paths or transcript paths
as authority to control a session.

### Lifecycle

```text
opening -> ready -> closing -> closed
                \-> failed
```

Track turn activity, retry/compaction, queues, children, and dialogs separately.
"No active parent turn" doesn't imply "no background child work."

1. Launch with normal Pi resources, daemon environment, explicit companion,
   requested configuration, and an integration-owned launch identity.
2. Attach stdout/stderr and process-exit handlers before issuing commands.
3. Establish responsiveness with correlated RPC, then require the companion
   protocol/capability handshake and detect known conflicting owners.
4. Restore history and state as requested; publish configuration and persistence
   before readiness. Honor `history: skip` without treating it as a fresh session.
5. Reject new work immediately once closing or failed. Cleanup doesn't depend
   solely on orderly `session.close` delivery.

### Transport rules

- Decode UTF-8 across chunks; split records on LF, accepting CRLF.
- Keep stdout protocol-only and drain stderr into a bounded diagnostic tail.
- Correlate responses by ID, not order. Classify events, native responses,
  extension UI records, and companion envelopes independently.
- Honor stdin backpressure; bound incomplete frames and pending operations with
  documented errors. A limit is not permission to silently drop transcript data.
- Reject pending operations on process exit/transport failure and discard stale
  responses from old generations.
- Separate command-response timeout from model execution lifetime. A timeout
  doesn't establish that a prompt was never admitted.

## 3. Prompt, turn, and timeline projection

Use one native event consumer per root and deterministic folding functions.
Don't let separate UI surfaces become competing consumers of Pi stdout.

| Pi record | Provider behavior |
| --- | --- |
| Prompt disposition `started` | Associate the accepted input with the observed turn; correlate events that may precede the response. |
| Disposition `queued` | Preserve queued admission and associate eventual delivery with the correct host message; test the adapter's accepted prompt-result semantics rather than inventing a new disposition. |
| Disposition `handled` | Complete an extension/control operation without inventing a model turn. |
| Text/thinking/tool argument deltas | Fold by content index/call identity and publish full updated snapshots, not raw deltas as replacement text. |
| `message_end` | Use authoritative final content and cumulative usage. |
| Tool execution events | Preserve arguments, partial/final output, error/detail data and call ancestry where available. |
| `agent_end` | Don't terminalize automatic retries/continuations prematurely. |
| `agent_settled` | Finish tracked parent work once automatic activity is settled. |

Every host prompt gets exactly one prompt result; every started host turn gets
one terminal outcome. Replay and live rows use the same stable identities, with
`clientMessageId` association to replace optimistic user messages.

Queued follow-ups, steering, and interleaved command replies need captured-trace
tests before enabling those paths. Do not settle commands by waiting blindly for
an `agent_settled` that a handled extension command may never emit.

Publish standard tool details and preserve useful native metadata within schema
and payload constraints. Unknown tool shapes retain honest unknown/plain data;
don't fabricate diffs or reuse native internal parsers as public imports.

## 4. Companion protocol and controls

Use public Pi extension APIs and commands. Invoke integration commands through
Pi RPC `prompt`, directly from the owned server transport, rather than routing
them as ordinary Paseo chat messages. Their native `handled` disposition is a
control completion, not a user turn.

Use Zod-validated, versioned request/result envelopes. Each control envelope
contains protocol version, integration session key, request ID, operation, and
operation-specific data. The exact schemas live in the companion's `protocol.ts`.
Implemented operations:

- `hello`: protocol capabilities, current configuration, defaults and known
  control-owner conflicts.
- `get-state` / `configure`: tier/context state and effective local configuration.
- `rewind`: target entry, navigation result, new leaf and branch-local settings.
- `compact`: idle-only compaction settled by documented callback/events. The
  provider's native `/compact` command currently uses core Pi RPC instead.
- Bridge events: child identities, ancestry, activity sequence, and outcomes.

Serialize replies/events through a recognizable structured `ctx.ui.notify`
payload, using Pi's RPC-visible UI channel. Validate and consume only exact
Superpi envelopes; do not swallow ordinary user notifications or treat arbitrary
JSON notification text as trusted control data. Pi's public event bus carries
Plexus policy and owned-child records inside Pi; those events still need the
companion's RPC-visible notifications to reach the provider subprocess boundary.

### Configuration application

- Use core session-only model/thinking RPC setters. The companion requests
  complete versioned context/service-tier snapshots from `plexus-pi`, with bounded
  timeouts, publisher correlation, revision checks, and shutdown cleanup.
- Advertised tier names are the selector options and the exact `service_tier`
  payload values. Plexus owns upstream translation. Missing policy means no
  selector/injection, not a manufactured Default option. Explicit unsupported
  selections fail. Legacy `fast` migrates to advertised `priority`.
- Retain tier intent across metadata loss/incompatible models. Use advertised
  `auto`, then `standard`, or inject nothing when the saved tier isn't offered.
  Premium-only lists stay unselected until the user chooses. Backend errors
  never trigger automatic retry with a different tier.
- Context Off uses the published short budget; On uses maximum. Show rounded
  lengths on the selector button/options only for distinct short/max budgets.
  Missing/equal policy retains Pi's declared limit. No hardcoded expansion.
- Apply budgets through session-local model clones, never catalog mutation.
  Reconcile on startup, tree restoration, model selection, policy broadcasts,
  and before each turn. Live `superpi:state:v1:` notifications update controls.
  Saved On intent survives metadata loading; a ready catalog without a
  qualifying policy clears it and restores the catalog budget.
- Capture a request configuration snapshot before dispatch, so an in-flight
  response can report its original model/settings after later changes.
- Read Pi-side defaults, then replay saved branch/session settings, then apply
  explicit open/configure values. Don't write runtime choices into Pi defaults.
- Leave session-only auto-retry/auto-compaction toggles deferred. Native
  `/autocompact` intentionally changes Pi's global preference, with project
  overrides still possible. No settings snapshot/restore or private setters.

The provider publishes `session.commands` for supported native commands and
dispatches `/compact`, `/autocompact`, `/model`, `/thinking`, `/name`, and `/session`
without model work. Extension commands keep precedence; terminal-only built-ins
fail explicitly. Slash commands are idle-use actions because the host may
interrupt before dispatch. Composer configuration is the live-control path.

Serialize conflicting state mutations with a short operation barrier, not one
long mutex held for the entire model run. Stream-safe configuration and permission
answers must remain deliverable while a turn runs. Rewind/close prevent new
admission; manual compaction checks idle state atomically with admission.

## 5. Durable state and recovery

Pi JSONL is the authority for the root conversation tree and model-visible
context. Superpi metadata records ownership, restore identities, settings
revision, child associations and delivery/projection state, not a second editable
copy of the root conversation.

- Use Pi custom entries for durable companion settings and the rewind marker;
  restore branch-sensitive state on `session_start`, tree navigation, and model
  selection. Root history prefers incremental reads of the owned transcript;
  ephemeral sessions use the lifetime RPC fallback.
- Use a versioned, validated Superpi manifest plus append-only child journal for
  child lifecycle/history not present in root JSONL. Store under a plugin-owned
  directory with restrictive permissions, serialized updates and atomic manifest
  replacement. Don't duplicate credentials or dump the environment.
- Journal authoritative child lifecycle and finalized activity before marking it
  durably committed. Live deltas can be coalesced for display; terminal/final
  data must be flushed. Preserve native child transcript references as additional
  recovery evidence, not the only replay index.
- Parse large histories incrementally. Keep only needed live snapshots/indexes
  in memory; no lifetime prefix cutoff. A single oversized payload is handled
  explicitly without dropping later records.
- Parent `ProviderPersistence` returns an opaque versioned handle. Validate and
  authorize it on reopen; reject traversal, malformed state, wrong ownership,
  missing transcript, and concurrent writers with actionable errors.
- Reconstruct active root history by tree ancestry, not by JSONL append order.
  Raw transcript, active visible history, and model context are different views.
- Recreate historical children through parent restoration, replaying stable rows
  and terminal outcomes. Historical children are read-only, not resumed runs.
- If a run lacks a confirmed terminal record after process loss, describe it as
  interrupted/lost; don't infer success from an output file or invent a host
  "unknown" status. Use supported failure/cancellation plus explanatory data.
- Restore automatically on subsequent use, but never resend the interrupted
  prompt or restart a child merely because saved task text exists.

## 6. Owned subagent bridge

Change `pi-subagents` to export a documented, versioned bridge through its public
extension event bus. The root companion subscribes and serializes it across RPC.
Owned changes are preferable to another tintinweb output-string parser.

Bridge data includes run ID, child Pi session identity, parent run/session,
spawning call ID, transcript/result reference, title, lifecycle outcome, and
ordered activity records. Modify the owned extension to forward child session
events to this bridge; the existing creation/completion events aren't sufficient
for live text/tool streaming.

- Capture creation and subscribe to child events before child prompt execution.
  A fast child must not finish before the parent association is registered.
- Preserve independent child definitions/defaults for model/thinking/tier/context.
  Fail unresolved configuration honestly; don't fall back to the parent's model.
- Child companions, if loaded by the extension, must not emit competing root
  envelopes or recursively duplicate bridge events. Carry explicit origin/run
  identity and let the root bridge own export.
- Publish `session.opened` with actual parent provider session and spawning tool
  identity. Negotiate `session.subsession` on parents that can create children;
  child tracks remain read-only otherwise.
- Reuse the root timeline folding rules for child events. Deduplicate by stable
  source identity and bridge sequence, including replay/live overlap.
- Map `completed`/soft-limit `steered` to completed, explicit abort/stop to
  canceled, and errors to failed, preserving the native reason in details.
- Test host close semantics: a clean child `session.closed` can overwrite a
  canceled state as completed in the inspected adapter. Don't emit contradictory
  terminal sequences. Keep terminal read-only tracks until parent teardown when
  needed, and verify their replay outcome through the chosen host version.
- Capture late metadata without reopening terminal state. Completion remains
  follow-up delivery with `triggerTurn: false`; result collection doesn't suppress
  reporting.

No steering UI, targeted child-stop API, run resume, or new concurrency queue is
part of this stage. Root shutdown still invokes existing owned-child cleanup.

## 7. Attachments, dialogs, and diagnostics

- Convert provider image input to native Pi image content after boundary checks.
  Preserve ordinary non-image attachment materialization/path hints and tool
  accessibility. Test file ownership/lifetime rather than assuming base64 display
  RPC is a model-input bridge.
- Make text-only model image limitations explicit. Existing rendering plugins
  remain responsible for displaying image/tool output.
- Map native select/confirm/input/editor dialogs into supported host permissions,
  retaining native dialog ID, choices, prefill and response semantics.
- If native permission presentation cannot express editor prefill or another
  required field, add the smallest supported plugin UI/RPC contribution for that
  dialog. Don't drop data silently or replace the entire permission experience.
- Expire supplied timeouts, ignore late generation/dialog responses, and settle
  dialogs on shutdown. Don't invent a timeout for editor and silently cancel it.
- Render ordinary notifications/errors; consume companion responses separately.
- Keep diagnostic tails bounded and redact secrets. Preserve token usage without
  summing cumulative streaming counters; mark costs as estimates when needed.
- No MCP policy translation is implicitly implemented by answering a dialog.
  Reject unsupported nonempty policy/config requests rather than silently broaden
  access or claim a bridge exists.

## 8. Conversation rewind

1. Receive `session.revert` with conversation scope and a versioned opaque token
   bound to the owned session and target Pi user-entry identity.
2. Enter the exclusive navigation barrier; reject new prompt admission. Refresh
   native state and reject if owned children are active or compaction is unsafe.
3. Respect the host's cancel-then-rewind flow. If parent cancellation happened
   before rejection, report that partial outcome accurately.
4. Validate the target against the owned active tree. Clear pending native and
   adapter inputs with explicit feedback; do not promise they remain untouched
   if a later navigation hook cancels the operation.
5. Invoke the companion command's `ctx.navigateTree(targetId, { summarize: false })`.
   A selected user entry moves the leaf to its parent; no session fork or file
   rollback occurs.
6. Check cancellation, append the branch-pinning custom entry after successful
   navigation, and restore branch-sensitive companion state.
7. Re-read the active tree/messages and project authoritative visible history.
8. Complete the host revert through its supported history-reload/replacement
   path; verify this path in the chosen public adapter before claiming rewind
   works. Provider protocol has no generic invented `timeline.reset` event, and
   re-emitting snapshots alone doesn't delete abandoned rows.
9. Release the barrier and publish confirmed configuration/history state. Reopen
   must reproduce the same branch without exposing abandoned future as active.

The host history-replacement contract is an early integration test, not an
excuse to edit native files or use daemon internals. If the available public
adapter cannot satisfy it, report a blocker and revisit the design explicitly.

Current result: steps 1–7 and Pi branch persistence are implemented using OMP's
navigation/configuration/replay sequence. Step 8 remains blocked on the tested
0.11 host; reload does not guarantee abandoned visible rows disappear. No reset
event is invented. See [the executable verification](rewind-011-verification.md).

## 9. Cleanup and failure handling

- Parent interrupt clears/settles parent work according to existing host behavior
  but does not dispose owned background children.
- Root close, connection teardown and plugin teardown converge on one
  idempotent shutdown function: mark closing, stop admissions, settle controls/
  dialogs, invoke orderly Pi shutdown, await owned child cleanup, flush durable
  history, then release handles.
- Provider `session.archive`/`session.unarchive` requests are explicitly
  unsupported. Host agent archiving and provider transcript operations aren't
  interchangeable capabilities.
- Drain output during shutdown. Use bounded waits and process termination
  escalation if orderly shutdown fails; report what was or wasn't confirmed.
- Do not assume killing the plugin process kills its Pi grandchildren. Track
  owned processes explicitly; test supported-platform process cleanup.
- Frontend disconnect only removes observation subscriptions, not live runtime.
- On process failure, reject pending requests once, mark unfinished work
  honestly, flush available evidence, and invalidate the live generation.
- Plugin reload can race `session.close`; contributed cleanup and connection
  close must be sufficient without that final message.

## Implementation stages

These are the original delivery stages and acceptance targets, not a list of
unstarted work. Their implementation is present, with the acceptance gaps below.
No worker delegation is implied.

| Stage | Current state |
| --- | --- |
| 0–1 | Packages, public-adapter gates, root transport, history, lifecycle implemented/tested. |
| 2 | Native model/thinking, policy-discovered selectors, persistence, conflicts, commands and idle compaction implemented/tested. |
| 3 | Attachments, blocking dialogs/editor prefill, notices and tool metadata implemented; desktop/web probes recorded. |
| 4 | Owned bridge, independent defaults, native child views and durable replay implemented; synthetic long-history display probe is bounded evidence. |
| 5 | Pi navigation, branch pin, queue clearing and guards implemented; full Paseo visible-history replacement blocked. |
| 6 | Linux cleanup, failure/reload regression coverage and automated bundle/Hermes checks pass; mobile smoke unverified, Windows descendant cleanup unsupported. |

### Stage 0. Contract fixtures and package scaffolding

Create the installable provider/companion packages, minimal scripts, and schemas.
Pin available SDK versions explicitly; retain current pins unless a verified
required API needs an authorized update. Record the tested Pi executable build.

Build deterministic fake-Pi traces and provider-event assertions for response
interleaving, settlement, stream folding, process loss, and replay identity.
Establish the public adapter tests for native feature discovery, child canceled
status, and history replacement now. These are contract gates, not backend
tier/context acceptance probes.

Exit: both packages typecheck/test; client/server boundaries hold; identified
public-adapter limitations are either supported or reported as blockers.

### Stage 1. Root vertical slice

Implement process transport, companion handshake, catalog, root prompt/events,
basic tools, usage, durable session handle, close, and reopen history. Keep UI
minimal and use ordinary Paseo surfaces. New conversations only.

Exit: a real desktop/web session launches, streams text/tool activity, settles
correctly, closes, and reopens with stable history. Missing companion, crash,
and malformed transport tests fail visibly without replaying admitted work.

### Stage 2. Composer controls and configuration durability

Add tier/context companion operations and native model/thinking/settings
publication, draft discovery, session persistence, known conflict detection,
and idle-only manual compaction. Preserve normal Pi defaults on omission.

Exit: choices apply to the first/next request without interrupting current work;
controls match current advertised policy; settings survive reopen/model changes
under the reconciliation rules above; defaults aren't rewritten. Explicit
unsupported selections produce errors, not a backend-error retry.

### Stage 3. Attachment and extension interaction parity

Implement images/files, blocking dialogs with prefill/timeouts/cancellation,
ordinary notifications/errors, and full supported tool metadata. Add custom
plugin UI only for verified gaps in required native interaction.

Exit: desktop/web attachment/dialog scenarios match requirements; late replies
can't affect replacement sessions; existing rendering plugins receive standard
data. No TUI/widget or bespoke MCP/todo scope expansion.

### Stage 4. Owned subagents and complete history

Add the versioned owned bridge, independent child defaults, ordered streaming,
native read-only subsessions, durable journal/replay and sticky terminal outcomes.
Exercise permitted nesting without introducing a new nested UI or control API.

Exit: live child views work, histories exceed 2 MiB/200 items without losing the
tail, terminal steered results don't reopen cards, completion doesn't wake the
parent, and history returns after process loss without claiming resumable runs.

### Stage 5. Conversation rewind

Implement target tokens, exclusive barrier, active-child guard, queue clearing,
companion navigation/branch marker, active history replacement and reopen.

Exit: native before-message rewind survives reopen, old future stays only on its
abandoned branch, files are unchanged, queues don't leak onto the new branch,
and canceled/rejected operations explain actual outcomes.

### Stage 6. Lifecycle hardening and release validation

Test root close, explicit unsupported archive requests, child-tab closure,
frontend reconnect, plugin reload, daemon stop, concurrent configuration,
permission timeout, and cleanup escalation.
Run the full acceptance matrix in [requirements](requirements.md#acceptance-criteria).

Exit: lint/typecheck/tests and applicable bundle/Hermes checks pass without
warnings; desktop/web smoke tests pass. Use plugin CLI help before install/reload/
list/log commands, then verify the installed provider loads and logs no errors.
No iOS/Android device test is required for this personal V1 release.

## Test strategy

- Unit tests: JSONL framing, schema validation, identity/correlation, event folding,
  state transitions, branch projection and settings precedence.
- Regression traces: events before responses, handled commands without turns,
  retry after `agent_end`, queued follow-ups, concurrent controls, duplicate/late
  child records, steered completion, oversized payload followed by normal data.
- Fake-process integration: stdin backpressure, slow startup, handshake refusal,
  timed-out admission, broken pipes, orderly/forced cleanup and crash restore.
- Real Pi integration: normal resource loading, no global-default writes,
  companion state, attachments/dialogs, independent child configuration, tree
  navigation and active-branch restoration.
- Real Paseo integration: native draft controls, optimistic message replacement,
  child status/history, rewind replacement, frontend reconnect and reload races.
- Durability tests: malformed/legacy metadata, interrupted writes, concurrent
  restore refusal, transcript mismatch, large child history and incomplete runs.
- Bundle checks: client size/class/Hermes checks and absence of Node/server code
  in client/shared reachability. Do not add heavy rendering libraries.

## Resolved choices and remaining limits

The companion lives in `superpi-companion/` and is loaded explicitly through
`SUPERPI_COMPANION_PATH` or the Pi agent-directory extension path. SDK pins stay
at 0.10.0; the isolated launcher pins host 0.11.0-beta.3 and copies Pi 1.0.0+local.
Transport limits/deadlines and cleanup grace periods are named constants in
`server/pi-rpc.ts`, with regression coverage. Plexus supplies context/tier policy;
Superpi does not choose a fixed expansion or provider-specific translation.
Minimal plugin UI consists of the Pi dialogs screen and resume-command action.

Remaining limits are host visible-history replacement, direct steering, arbitrary
TUI widgets, MCP/tool-policy translation, and Windows descendant cleanup. Mobile
device smoke remains unverified. Continue through
[the SuperPi development workflow](../README.md#developing-through-superpi), using
an isolated daemon instead of reloading the provider running the work session.

Unsupported public history/status behavior, inability to apply a control honestly,
or a requirement that needs core changes is a blocker to report, not a reason to
silently weaken the requirements.

## References

- [Requirements](requirements.md): authoritative product scope and acceptance.
- [Provider contracts](01-paseo-provider-api.md): configuration, full timeline
  snapshots, persistence, child sessions and revert constraints.
- [Native integrations](02-paseo-native-pi-omp.md): lifecycle/parser loss cases.
- [OMP reference](03-omercnet-omp-reference.md): comparative transport patterns;
  OMP-specific RPC features must not be assumed to exist in Pi.
- [Pi RPC](04-pi-rpc-contract.md): framing, admission, settlement, history and UI.
- [Owned extensions](05-personal-pi-plugins.md): subagent execution and private
  event/state seams requiring an explicit bridge.
- [Survey review](CurrentLimits-review.md): why source fixes aren't sufficient
  evidence of working user behavior or reusable public plugin contracts.
