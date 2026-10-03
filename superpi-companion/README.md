# superpi-companion

Separate Pi extension package for the Superpi root companion. It runs inside the
root Pi process, not inside the Paseo plugin runtime, and owns the versioned
control/rewind envelope used by the Superpi provider transport.

This is the root companion for the Superpi provider. It runs inside the root
Pi process, not inside the Paseo plugin runtime, and owns the versioned
control/rewind envelope used by the Superpi provider transport.

Protocol, session-key enforcement, root/child handling, conflict detection, and
the `hello` / `get-state` / `configure` / `rewind` / `compact` operations are
implemented and tested. The companion also subscribes to the owned
`pi-subagents` bridge and forwards child records to the provider.

## Loading

The provider launches the root Pi with the companion as an explicit extension,
marks the root owner, and passes the integration session key:

```text
pi --extension <path>/superpi-companion/index.ts \
   --superpi-companion-root \
   SUPERPI_SESSION_KEY=<opaque-session-key>
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
    tier: "default" | "fast" | "flex" | "ultrafast",
    longContext: boolean
  },
  contextWindow?: number,                // current effective model window
  activeChildren?: number,               // owned bridge runs without a terminal record
  sessionId?: string,
  origin: "root" | "child",
  tiers: ("default" | "fast" | "flex" | "ultrafast")[],
  longContextTarget?: number,            // expanded budget advertised
  modelBaselineContextWindow?: number,   // pre-expansion model baseline
  tierApplicable: boolean,               // injectable for the current dialect
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
{ tier?: "default" | "fast" | "flex" | "ultrafast", longContext?: boolean }
```

Returns the same state. Behavior:

- `tier` is stored and injected into `before_provider_request` only for known
  API dialects: OpenAI Responses (`service_tier`; `fast` -> `"priority"`) and
  Anthropic Messages (`speed: "fast"` + beta). Unknown dialects leave the
  payload untouched and report `tierApplicable: false`.
- `longContext` expands the current model's context window to the known owned
  target `1_050_000` (from `pi-microgpt`) while recording the model baseline.
  Turning it off, changing models, or session shutdown restores the baseline.
  A missing model/context window returns an honest error and leaves the toggle
  off.
- Runtime changes are persisted as branch-local `superpi-controls` custom
  session entries and restored on `session_start`/`session_tree`/`model_select`.
  Nothing is written to global Pi settings.

## Known-owned values

- Expanded context target: `1_050_000` (`EXPANDED_CONTEXT_WINDOW`).
- Tier mapping: `default` (no payload), `fast` -> `priority`, `flex`, `ultrafast`.

## Current gaps

- Host history replacement after rewind is the provider's supported-adapter
  concern. The companion re-reads the active branch and appends a branch pin;
  it does not invent a reset/replacement event.
- The companion cannot clear Pi's pending queue; the provider must invoke the
  native `clear_queue` before navigation.
- `compact` completion depends on Pi's callback/event support; the companion
  never reports completion early.
- Active owned children are counted only from the `pi-subagents` bridge; an
  unbridged child is not visible to the guard.
- Backend acceptance of tier/context values is not verified; the state reports
  what the companion configured, not what the backend honored.
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
