# omercnet's OMP provider plugin

`paseo-omp` is a useful reference because it implements a large coding-agent
integration outside Paseo core. Its strongest examples are careful protocol
admission, prompt settlement, session ownership, permission handling, replay,
subsessions, and cleanup. Its complexity also shows the work hidden behind those
features.

It is not a Pi compatibility specification. OMP's richer RPC protocol supplies
several capabilities that the inspected Pi process does not expose directly.
This report separates reusable integration practices from OMP-only operations
and private workarounds. It does not recommend copying the implementation or
building against OMP.

## Scope and identity

Root: `~/workspace/omercnet/paseo-plugins`, revision
`5f38b18ebdfe541d450a327e4fda5e9ebcd38cda`.

The OMP provider is under `paseo-omp/`; source paths below are relative to that
directory. Other plugins in the repository mention OMP but are not alternative
OMP transport implementations.

The manifest ID is `paseo-omp`; the provider ID is `omp-plugin`. Profile
registrations add `omp-plugin-<profile>` identities. The bundled Paseo `omp`
provider is separate. Agents, settings, and persistence handles do not migrate
between them automatically.

The plugin's manifest supports `^0.9.2 || ^0.10.0`. Its support document names
Paseo 0.10.1 as verified and OMP 18.1.15 as the oldest supported release, with
canaries for 18.1.15 and 18.2.0. These are the reference project's claims, not
versions tested during this research. The hard native gate is `rpc-ui` protocol
v2, rather than executable version alone. [O1, O10]

Repository instructions treat the default daemon as production and require an
isolated home/host for testing. No plugin was installed, daemon restarted, or
native OMP session opened for this report.

## Component map and integration seams

```text
client panels / config / pills / timeline renderers
                         |
                    plugin RPC
                         v
server settings + handlers + lifecycle hook
                         |
             public Paseo provider registration
                         v
connection: admission, reservations, request routing
                         |
session: config, prompts, persistence, recovery, settlement
       |                 |                 |
timeline projector   permission bridge   subsession projector
       |                 |                 |
       +---------- OMP runtime interface --+
                         |
transport: JSONL, ready, IDs, chunks, limits, backpressure
                         |
                     OMP child
                    --mode rpc-ui
                         |
                  MCP host-tool bridge
```

The client does not own the OMP process. Mobile/desktop disconnects do not
transfer runtime ownership; daemon-side sessions continue under Paseo's own
reconnect rules. The plugin server owns process and transport cleanup. [O10]

## Public provider contract coverage

The registration and connection agree on these eleven capabilities:

```text
prompt.message
prompt.command
prompt.image
prompt.steer
session.configure
session.list
session.persistence
session.subsession
session.revert.conversation
permission
timeline.plugin
```

Absent capabilities are output schema, native archive/unarchive, file/combined
revert, and exact MCP tool-policy preapproval. Unsupported operations fail rather
than claiming approximate support. `prompt.steer` is implemented; it was not
missing from this reference. [O1]

### SDK compatibility caveat

The source defines local `Compat` types for `providerOptionsSchema`,
`checkAvailability`, cache options, and a context timeout. These are not all
members of the public `ProviderRegistration` inspected in the pinned Paseo
baseline. The later local Paseo source uses `status` and `launch`, not the
reference's `checkAvailability` shape.

Type widening lets this source compile against different SDK definitions; it
does not force a host to call an unknown property. The reference also has its
own diagnostics and settings paths. An apparent method on its registration must
not be copied into a new plugin and treated as guaranteed host behavior. [O1,
report 1](01-paseo-provider-api.md)

Catalog cache keys hash normalized discovery context and non-secret profile/store
identity. Explicit profile environment values disable sharing in one path to
avoid hashing credentials. These are examples of cache identity handling, not
evidence that all provider discovery must use this exact hash construction.

## Launch, handshake, and transport contract

The native command is `omp --mode rpc-ui`, with approval mode, model/thinking,
session persistence/resume, system instructions, and selected native settings.
Environment construction has explicit inherited runtime/auth variables and
blocked session-control variables. OMP's profile/config paths and launch flags
are OMP-specific. [O2]

### Ready and negotiation

The plugin validates an initial `ready` record whose active protocol is 1 and
whose supported versions include both 1 and 2. Legacy metadata-free or v1-only
ready frames are rejected. It then sends:

```json
{
  "id": "handshake-1",
  "type": "negotiate_protocol",
  "protocolVersion": 2,
  "clientCapabilities": {"typedToolApprovals": 1}
}
```

The typed-approval request is optional. The two-stage ready/v2 selection is not
the Paseo provider protocol version, which remains 1. Pi 1.0.0 does not implement
this ready/negotiation handshake. [O3]

### Frames and command policy

Commands and events share stdout with correlated responses. Chunked logical
records use:

```ts
type Chunk = {
  type: "rpc_chunk";
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string; // Base64 bytes
};
```

Chunk validation checks sequence, count, size, and completed byte count before
parsing the logical record. Parsing a valid physical frame is not sufficient;
semantic records have additional size/node/schema budgets.

`OMP_RPC_COMMAND_POLICIES` explicitly classifies known native commands as
implemented or unsupported. The plugin does not wrap every OMP command. For
example, its table rejects direct new/switch session, tree/entries, arbitrary
bash, export, login, native Fast mode, and several cycle/queue controls despite
the native protocol having related commands. Supported native operations include
prompts, steer/follow-up, abort, model/config, stats, compaction, host tools,
subagent queries/subscriptions, branch/history paging, and handoff. [O3]

### Numerical limits

| Limit | Value | Scope |
| --- | --- | --- |
| Ordinary request timeout | 60 seconds | Pending native request |
| Chunk staleness | 30 seconds | Incomplete logical frame |
| Physical frame bytes | 1 MiB | One JSONL record |
| Raw chunk bytes | 256 KiB | One decoded chunk |
| Reassembled frame | 64 MiB | Logical frame ceiling |
| Semantic frame | 12 MiB | Normalized/validated payload ceiling |
| Chunk count | 256 | One logical frame |
| Stream text | 4 MiB | Transport's stream-text length limit |
| Active tools | 64 | Tracked native tool calls |
| Pending requests / one-way writes | 256 each | Transport outstanding work |
| Pending write bytes | 8 MiB | Outbound queue |
| Line parts | 4,096 | Frame assembly |
| Protocol diagnostic coalescing | 10 seconds | Repeated violation reports |

Response validation is command-specific. Branch correlation uses a small history
budget; full replay permits up to 100,000 messages and 400,000 JSON nodes; model
catalogs permit up to 4,096 entries. These are deliberate rejection/truncation
boundaries, not assurances that all runtime data is complete. [O3]

Failure handling distinguishes request rejection (`session_busy`, `stale_cursor`,
`unsupported_command`), response limits, process exits, system/database failures,
and unexpected exceptions. Operational failures have bounded category/stage
diagnostics. This keeps errors useful without dumping arbitrary native payloads
or credentials into diagnostics. [O3, O4]

## Session ownership, persistence, and replay

The connection reserves native session identities before opening them. Ownership
and quarantine tracking prevent its own sessions from opening the same native
identity concurrently. Failed or uncertain cleanup keeps the reservation
quarantined. Session discovery waits for pending opens/quarantines rather than
presenting an unsafe native state. There is a 32-session connection limit. [O4]

Persistence is strictly versioned:

```json
{"version":1,"data":{"sessionId":"native-session-id"}}
```

The parser requires version 1 and exactly that data key. Restore re-resolves the
native ID using session discovery scoped to cwd, requires one exact ID/cwd match,
and rejects mismatches. It does not trust a client-supplied transcript path.

The reference imposes stricter rules than Paseo's general protocol:

- Resume requires `persist: true`.
- Persisted open requires replay rather than `history: "skip"`.
- Replay without a persisted identity is rejected.
- Replay requires the negotiated native v2 contract.
- Replay has a 20-second deadline and a 100,000-message ceiling.

These restrictions belong to this plugin, not to every Paseo provider. [O5]

`session-descriptors.ts` separately discovers and reads native JSONL files for
session list/import. Terminal-started sessions are discoverable but not
automatically registered through a terminal hook. File discovery and live RPC
session control are separate seams.

## Prompt acceptance and settlement

The adapter emits one `session.prompt_result` per Paseo client message and uses
Paseo `session.turn` terminal events. Paseo has no public `session.settled` event;
the native OMP `session_settled` record is translated rather than forwarded as a
new host event.

Native prompt IDs are authoritative when present. Some released OMP builds omit
the originating request ID from `agent_end`, so the plugin has an ordered
fallback. It requires fresh user-entry correlation, current-turn assistant
activity, idle/noncompacting state, and no remaining permission/tool/steer/child
work. A mismatch is discarded before changing state. If idle ambiguity remains,
it fails the Paseo turn while keeping the native process usable.

The support document explicitly accepts residual risk: a sufficiently delayed,
unkeyed same-agent event with indistinguishable ordered evidence can still be
misattributed. This is a compatibility compromise, not exact native correlation.

User watermark repair uses a complete pre-prompt branch snapshot, limited to
1,024 entries and 4 MiB. Duplicate IDs, surplus exact-text matches, missing
history, or exceeded bounds leave input uncorrelated rather than matching an
old row. Repeated text consumes branch occurrences in order. [O5, O10]

Pi's `prompt` disposition and `agent_settled` contract differ. The OMP fallback
must not be treated as necessary or correct for Pi without checking the Pi
event semantics. [Report 4](04-pi-rpc-contract.md)

## Timeline and child-session seams

`timeline-projector.ts` folds native messages, reasoning, tool start/update/end,
todos, notices, and compaction into full Paseo snapshots. It maintains stable
identities and publishes opaque user-row revert tokens. Provider-specific
images and auth interactions use plugin timeline rows with companion renderers.

The subsession projector consumes OMP lifecycle/progress/event records and task
dispatch correlation. It opens children through the public provider contract:

```json
{
  "type": "session.opened",
  "sessionId": "native-child",
  "parentSessionId": "direct-parent",
  "toolCallId": "spawning-task-call",
  "capabilities": ["session.subsession"],
  "restoration": "parent",
  "cwd": "/workspace/project"
}
```

Direct parent and spawning tool identities are retained. That allows the host's
plugin adapter to build nested child ancestry, unlike native Paseo OMP's flat
subagent index. The projector buffers out-of-order activity while resolving
child/dispatch state and supports child history queries. If native event
subscription fails, the session drops `session.subsession` instead of failing
unrelated message functionality. [O6]

Subsession bounds include 1,024 children, 4,096 task dispatches, 3,072 buffered
events, 4 MiB buffered bytes, and replay limits of 100,000 messages/64 MiB/
400,000 nodes/depth 16. Native first-class child events make this more direct
than Pi extension parsing; they do not remove ordering, teardown, or buffering
work.

## Permission seam

The plugin supports two paths:

1. Negotiated `typedToolApprovals: 1` maps native tool approvals to Paseo
   `kind: "tool"` requests with shell/edit/write details and allow/deny actions.
   Unnegotiated typed requests are protocol/runtime failures.
2. Generic `extension_ui_request` maps `select`, `confirm`, `input`, and `editor`
   to question permissions. Input/editor prefill is retained; select option
   descriptions are retained when present. Cancel remains an explicit path.

The OMP sentinel for custom response becomes `allowOther` with a bounded,
two-step freeform flow. That sentinel is OMP copy, not a portable Pi select
schema. Permission IDs are namespaced; changed/reused fingerprints fail rather
than accidentally approving different work.

Limits include 32 pending permissions, 2 MiB pending permission bytes, 1,024
resolved typed-approval IDs, and 64 KiB freeform responses. Over-cap typed
requests are canceled native-side; over-budget generic requests are rejected
with a warning. Native timeout fields arm permission timeouts. [O7]

## MCP and caller identity seam

OMP supports native `set_host_tools` and host-tool result records. The plugin
connects to configured MCP servers, exposes schemas to OMP, executes calls on
the server, and returns bounded results. Pi does not have this same core RPC
host-tool channel.

Internal Paseo MCP endpoints are recognized by `/mcp/agents`. They require
`PASEO_AGENT_ID` and `PASEO_WORKSPACE_ID`, and each endpoint's `callerAgentId`
must match the agent env identity. A public `before("agent.session_open")` hook
injects workspace identity for this provider. Paseo orchestration tools retain
native names; external tools are namespaced. [O8]

The bridge explicitly rejects any defined `toolPolicy` because native
`set_host_tools` cannot preserve exact MCP preapproval semantics. It fails
startup closed instead of broadening access. `disallowedTools` is a separate
native built-in allowlist conversion; unknown names fail, and it is not silent
MCP filtering.

Representative limits are 32 MCP servers, 256 host tools, 64 pending host calls,
8 MiB pending call bytes, 12 MiB tool results, 20-second initialization/browser
timeouts, and a five-minute default call lifetime.

## Revert, archive, and recovery

Conversation revert uses native `branch(entryId)` and opaque timeline tokens.
It rejects file/combined scopes, stale targets, active turns, config mutations,
and interrupts still settling. If a mutation may have committed before failure,
the session is closed as indeterminate rather than pretending the prior branch
is still authoritative. File rollback is not implemented. Native archive and
unarchive are not implemented; archiving a Paseo agent record is a different
operation. [O5]

Recovery is generation-fenced. It reopens the native process using committed
state, restores host tools/subscriptions, and rejects stale asynchronous work
from earlier runtime generations. Config refresh retries up to three times;
compaction waiting has its own five-minute maximum. [O5]

Process cleanup uses POSIX process groups with TERM then KILL, or Windows
`taskkill /T /F` with a fallback. Outcomes distinguish verified, uncertain, and
failed cleanup. Descendants that reparent out of the process group remain
outside containment. Unverified cleanup quarantines native sessions and is
retried. Connection close drains operations and aggregates cleanup failures
rather than returning success while work remains. [O4, O9]

## Client contributions and private workarounds

The client adds memory/workspace panels, commands to open them and config, a
config surface/sidebar item, image/auth timeline renderers, an image transformer,
and optional MCP/hub/memory/sessions/quota composer pills. The entry does not
register a settings screen, slash-command contribution, attachment source, or
theme. Server settings and plugin RPC support those UIs. [O11]

The hub reader is explicitly private and best-effort. It reads
`~/.omp/run/daemons/<projectHash>/...` metadata/output files with a 64 KiB log
bound. OMP can change/remove this layout without an API promise. Output
redaction's `configured-values` mode is literal, best-effort replacement, not a
guarantee against secret exposure. [O10]

Known limitations also include missing native Fast/first-class plan controls,
handoff prerequisites not reproducible in the deterministic canary, and a mock
that does not implement compaction summaries. A fixture covering compaction is
not the same evidence as a successful real compaction canary.

## What transfers to Pi, and what does not

| Reference seam | Portable observation | OMP dependency |
| --- | --- | --- |
| Transport | LF framing, IDs, bounds, backpressure, cleanup | Ready/v2/chunk records are not Pi RPC |
| Session ownership | Authorize persisted identity, fence stale runtime work | Native discovery/resume formats differ |
| Settlement | Acceptance is not completion; ambiguous identity must stay explicit | OMP unkeyed `agent_end` fallback is protocol-specific |
| Children | Public Paseo child sessions can express ancestry | Pi must source child data from another contract |
| Permissions | Blocking UI needs lifecycle and late-response rules | Typed approvals and custom-response sentinel are OMP-specific |
| MCP | Server-side caller identity and fail-closed policy matter | Pi has no native `set_host_tools` RPC command |
| Revert | Define conversation versus file effects precisely | OMP native `branch` is not Pi RPC `fork` |
| UI | Companion renderers can show richer provider data | Pi TUI components are not transferable renderers |

Pi already has persisted sessions and extension APIs. Missing native child or
host-tool RPC frames do not imply that persistence or subsessions are impossible;
they identify additional contracts that need requirements and verification.
No decisions about those contracts are made here.

## Evidence and source map

Paths are relative to `~/workspace/omercnet/paseo-plugins/paseo-omp` at `5f38b18`.

| Ref | Source | Relevant content |
| --- | --- | --- |
| O1 | `server/provider/registration.ts:18-181`; `connection.ts:44-67`; `paseo-plugin.json` | Registration, Compat types, negotiated capability set |
| O2 | `server/provider/omp-rpc-environment.ts:60-190,270-375` | CLI and env boundary |
| O3 | `server/provider/omp-rpc-protocol.ts:6-193,1205-1229`; `omp-rpc-transport.ts:63-127,660-745,860-935,1372-1401`; `omp-rpc.ts:640-661` in the same provider directory | Policies, frame schemas, budgets, handshake |
| O4 | `server/provider/connection.ts:424-698,783-807,1142-1197` | Error taxonomy, reservations, quarantine, close |
| O5 | `server/provider/session.ts:96-215,456-465,537-542,724-725,838-970,1965-2055,2374-2390,3198-3205`; `session-descriptors.ts` in that provider directory | Persistence, replay, revert, settlement, recovery |
| O6 | `server/provider/subsessions.ts:20-66,341-380,719-728`; `session.ts:629-636` | Child state, bounds, ancestry, subscription degradation |
| O7 | `server/provider/session-permissions.ts:26-50,301-357,605-673` | Typed and generic permissions |
| O8 | `server/provider/host-tools.ts:35-60,186-245,1020-1027`; `index.server.ts:100-103` | MCP identity, limits, exact policy rejection |
| O9 | `server/provider/omp-rpc-process.ts:6-105`; `omp-rpc-transport.ts:63-79` | Process-tree containment and retries |
| O10 | `SUPPORT.md`; `README.md`; `server/hub.ts:31-40` | Declared support, compromise behavior, private hub reader |
| O11 | `index.client.tsx:126-277`; `index.server.ts` | UI, settings, RPC, provider/profile contributions |

The source, support claims, and test strategy were inspected. The plugin's
Docker canaries, external test suites, and mobile UI were not executed here.
