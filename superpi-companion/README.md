# superpi-companion

Separate Pi extension package for the Superpi root companion. It runs inside the
root Pi process, not inside the Paseo plugin runtime, and owns the versioned
control/rewind envelope used by the Superpi provider transport.

Protocol, session-key enforcement, root/child handling, conflict detection, and
the `hello` / `get-state` / `configure` / `rewind` / `compact` operations are
implemented and tested. The companion also subscribes to the owned
`pi-subagents` bridge and forwards child records to the provider.

## Loading

The provider launches the root Pi with the companion as an explicit extension,
marks the root owner, and passes the integration session key:

```text
SUPERPI_SESSION_KEY=<opaque-session-key> pi --mode rpc \
   --extension <path>/superpi-companion/index.ts \
   --superpi-companion-root
```

- `--superpi-companion-root` (or `SUPERPI_COMPANION_ROLE=root`) selects root
  mode. Without it the companion reports `origin: "child"` and refuses controls,
  so a companion loaded inside an owned child session cannot answer root
  envelopes or inject root request settings.
- `SUPERPI_SESSION_KEY` is the expected key. Every request must echo it; a
  mismatch or a missing launch key refuses the request.

`package.json` declares the Pi extension entry (`pi.extensions`) and only uses
the runtime extension API types from `@earendil-works/pi-coding-agent` as a dev
dependency. It does not import the Pi SDK root or embed `AgentSession`.

## Owning subagent activity

The root companion subscribes to the `superpi:subagent:v1` extension bus
channel after `session_start`, when the extension context exists. Subscription
is gated on the dynamic `--superpi-companion-root` flag (or an explicit option),
not the role environment variable, because SDK child sessions inherit the
process environment. Only the root companion forwards.

Bridge records are validated against the exported pi-subagents record shape and
folded through a tracker that:

- requires a `created` record before `activity` or `terminal`;
- enforces per-run `sequence` ordering, dropping duplicate/replayed records;
- keeps terminal records sticky so a late result cannot reopen a finished
  child;
- reports `activeChildren` (runs without a terminal record), which is the rewind
  guard.

Accepted records are forwarded with `ctx.ui.notify` as
`superpi:child:v1:<json>`:

```ts
{
  version: 1,
  sessionKey: string,
  record: SuperpiSubagentBridgeRecord
}
```

The native message/tool activity comes from the bridge record; the companion
never reads the child transcript path. Subscriptions are disposed on
`session_shutdown`.

## Envelope protocol

Requests arrive through the public Pi command:

```text
/superpi-control <base64url(JSON request)>
```

Request:

```ts
{
  version: 1,
  sessionKey: string,
  requestId: string,
  operation: "hello" | "get-state" | "configure" | "rewind" | "compact",
  data?: unknown
}
```

Replies are emitted with `ctx.ui.notify` using the `superpi:v1:` prefix:

```ts
{
  version: 1,
  sessionKey: string,
  requestId: string,
  operation: string,
  ok: boolean,
  data?: unknown,
  error?: string
}
```

`ok: true` notifications use level `info`; failures use `warning`. Malformed
requests still produce a correlated reply when any correlation fields are
recoverable.

## State shape (`hello`, `get-state`, `configure` reply data)

Zod defines the exact shape (`src/protocol.ts`). Undeclared keys are rejected.

```ts
{
  capabilities: string[],                // implemented operations only
  settings: {
    tier: string,
    longContext: boolean
  },
  contextWindow?: number,                // current effective model window
  activeChildren?: number,               // owned bridge runs without a terminal record
  sessionId?: string,
  origin: "root" | "child",
  tiers: string[],                       // exact advertised choices for this model
  longContextAvailable?: boolean,        // distinct short/max budgets apply
  longContextTarget?: number,            // Plexus maximum context tokens
  shortContextBudgetTokens?: number,     // Plexus short-mode budget
  pricingThresholdInputTokens?: number,  // optional input pricing boundary
  contextPolicyError?: string,           // model application failed
  modelBaselineContextWindow?: number,   // original catalog budget
  tierApplicable: boolean,               // selected tier is advertised for this model
  conflicts: { owner: string, command: string, resolution: string }[],
  limitations: string[]
}
```

### `hello`

Returns the state above. If a known control owner has declared a competing
command, `hello` returns `ok: false` with an explanatory `error` that names the
owner and resolution while still including the state and `conflicts`.

Detected declared owners (command-based, not extension-identity-based):

- `plexus-pi`: `service-tier`
- `pi-microgpt`: `fast`, `flex`, `long-context`

An unrelated loaded Plexus factory that declares no competing command is not a
conflict.

### `rewind`

`data`:

```ts
{ targetEntryId: string }
```

Rewinds the active conversation through Pi's public tree navigation. The target
must be a user message on the active branch. The companion calls
`ctx.navigateTree(targetEntryId, { summarize: false })`; Pi itself moves the
leaf to the selected user entry's parent, so the companion never walks parents
and never summarizes the abandoned future.

Guards (rejected before navigation):

- the root agent must be idle;
- no compaction may be in progress (`session_before_compact` through
  `session_compact` / `session_compact_failed`);
- no owned child may be active (`activeChildren === 0`).

The provider owns the native cancel-then-`clear_queue` flow before asking for
navigation; the companion does not clear Pi's queue itself. On successful
navigation the companion appends a `superpi-rewind` custom entry (branch pin) so
Pi reopens at the rewound branch, then restores branch-local companion settings.
No files are rolled back.

Reply `data`:

```ts
{
  cancelled: boolean,
  targetEntryId: string,
  leafId?: string,          // omitted when navigation reset to the root
  settings: { tier, longContext },
  activeChildren: number
}
```

A cancelled navigation is reported as `ok: false` with `data.cancelled: true`
and no branch pin.

### `compact`

`data`:

```ts
{ customInstructions?: string }
```

Idle-only manual compaction. The companion calls the public `ctx.compact()` API
with `onComplete` / `onError` and also settles on
`session_compact` / `session_compact_failed`, so a reply is emitted only after a
documented completion signal, never prematurely. A busy agent or an
in-progress compaction is rejected.

### `configure`

`data`:

```ts
{ tier?: string, longContext?: boolean }
```

Returns the same state. Behavior:

- `tier` must be advertised for the selected Plexus model. The companion sends
  that exact name as `service_tier` in `before_provider_request`, including
  OpenAI Completions and Anthropic-compatible requests. Plexus owns translation
  to provider-native fields, values, and beta headers. Models without advertised
  tiers have no selector and receive no injected tier.
- `longContext` selects the Plexus maximum budget when on, or the published
  short budget when off. Policies are requested from `plexus-pi` over Pi's public
  event bus and updated from complete revisioned snapshots. Models without a
  policy, or with equal short/max budgets, retain Pi's declared budget and have
  no context-length selector. The UI shows rounded short/max token lengths,
  not On/Off. There is no fixed expansion fallback.
- Budgets are applied to session-local model clones. The shared model catalog
  and child defaults are untouched. Policy removal restores the catalog budget
  and clears the toggle. Application failures are reported, not treated as a
  successful toggle.
- Runtime changes are persisted as branch-local `superpi-controls` custom
  session entries and restored on `session_start`/`session_tree`/`model_select`.
  Nothing is written to global Pi settings.

## Context-policy lifecycle

The companion subscribes to `plexus:context-policy:snapshot:v1` and requests the
current snapshot on `plexus:context-policy:request:v1`, setting up correlation
before emitting because replies can be synchronous. An absent publisher times
out after one second without blocking the agent indefinitely. Unknown publisher
IDs require a correlated reply; stale revisions and invalid/oversized snapshots
are ignored. Listeners and pending timers are removed on shutdown.

The root re-evaluates budgets on startup, tree restoration, catalog policy
broadcasts, and model selection. It publishes live state via
`superpi:state:v1:{version:1,sessionKey,state}` notifications so Paseo can add,
update, or remove the control without starting a model turn. Child companions
never apply the root's context selection.
Saved On intent is retained while startup metadata is loading/unavailable and
applied when a qualifying policy arrives. A ready catalog without that model's
policy clears the intent. Before each turn, the companion repairs any budget
clone silently replaced by another extension's provider registration.

## Service-tier lifecycle

The companion requests `plexus:service-tiers:request:v1` and consumes complete
snapshots on `plexus:service-tiers:snapshot:v1`. The same bounded, correlated,
revision-aware lifecycle used for context policies applies. Both startup
requests run concurrently. Broadcasts and model changes update the selector
through the existing companion state notification.

Names are preserved as advertised (for example `auto`, `standard`, `flex`,
`priority`, `ultrafast`), not renamed to Fast/Default. Saved legacy `fast` maps to
`priority` when available. Legacy `default`, removed selections, and unsupported
selections after a model switch use `auto`, then `standard`; if neither is
advertised, no tier is injected until the user chooses one. A premium-only list
starts unselected, not at its first tier. Explicit new unsupported selections
fail instead of silently falling back. With no policy, internal `default` means
no tier injection; it is not a manufactured UI option. The chosen tier survives
metadata loss and switches to models that cannot offer it, and is reapplied when
supported again. Saved intent is retained while metadata loads.
Children never inherit or inject the root's tier selection.

## Current gaps

The provider's native `/compact` dispatch uses Pi's core RPC `compact` command.
The companion's `compact` envelope is implemented/tested but isn't the provider's
current dispatch path.

- Host history replacement after rewind is the provider's supported-adapter
  concern. The companion re-reads the active branch and appends a branch pin;
  it does not invent a reset/replacement event.
- The companion cannot clear Pi's pending queue; the provider must invoke the
  native `clear_queue` before navigation.
- `compact` completion depends on Pi's callback/event support; the companion
  never reports completion early.
- Active owned children are counted only from the `pi-subagents` bridge; an
  unbridged child is not visible to the guard.
- Plexus supplies context-policy limits; the state reports Pi's applied budget,
  not a separate backend probe. Backend acceptance of service-tier values is
  not verified.
- Conflict detection covers known/declared owners only, not arbitrary payload
  modifiers.
- Pi is validated against the pinned `@earendil-works/pi-coding-agent` types and
  a jiti-loaded no-model smoke test; device smoke tests are not run here.

## Development

```bash
bun install
bun run lint
bun run typecheck
bun run test
```

The load smoke test evaluates the real `index.ts` through Pi's jiti transform
with a no-model extension context.

Run the provider package checks too when changing shared envelope behavior; see
[the SuperPi development workflow](../superpi/README.md#developing-through-superpi).
Existing Pi processes don't hot-reload this extension. Sync the isolated copy
and open a fresh test conversation. Do not reload the provider hosting the
development session from that same session.
