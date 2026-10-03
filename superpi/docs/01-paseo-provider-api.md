# Paseo provider plugin API

Paseo exposes a direct provider protocol that is broad enough to represent a
subprocess-backed coding agent without changing Paseo core. The plugin owns the
native agent's lifecycle and translates its output into canonical Paseo events.
The host owns agent records, normal client transport, and timeline presentation.

The contract does not expose every capability available to Paseo's native
providers. In particular, native caller-scoped Paseo tools are not supplied as
direct tools, and the provider must implement the native side of persistence,
permissions, history, and child sessions itself.

## Scope and version boundary

Repository root: `~/workspace/paseo`.

Verified source: `5293ddac3f17f35ea090b292447ec0498edafafe`. The project baseline
remains Paseo and `@getpaseo/{client,plugin,protocol}` v0.10.0. A direct diff against
the v0.10.0 tag establishes these provider-contract changes:

| Contract | v0.10.0 | Verification snapshot |
| --- | --- | --- |
| `ProviderRegistration.command` | Absent | Optional default executable/arguments |
| `ProviderRegistration.status` | Absent | Optional availability callback |
| `ProviderConnectRequest.launch` | Absent | Optional resolved launch configuration |
| Catalog cache callback's `launch` | Absent | Optional resolved launch configuration |
| `ProviderLaunch` and `ProviderStatus` types/schemas | Absent | Present |
| `ProviderSessionConfig.providerOptions` | JSON-valued record | Unknown-valued record in local types/schema |
| `PluginServerContext.registerUsageSource` | Absent | Present |
| Provider protocol version | `1` | `1` |
| Capability list and session/timeline event definitions | Present | No change in the inspected provider-file diff |

The added launch/status contract comes from `b0c9de0c9` (#5707). The options
broadening comes from `29c198f95` (#5780). Code compiled against 0.10.0 cannot
assume these later helpers exist just because protocol version 1 is unchanged.
This report describes both the baseline and the newer host behavior, without
selecting a new minimum host version.

## Public interfaces and internal adapter

```text
Paseo client and agent manager
          |
          | host-owned agent operations
          v
daemon's plugin-provider adapter              internal to Paseo
          |
          | ProviderInput / ProviderEvent
          | validated plugin subprocess boundary
          v
plugin server: ProviderRegistration.connect   public plugin API
          |
          | native transport owned by the plugin
          v
external coding-agent process
```

Registration and the callback protocol are public. Classes such as
`ProviderRuntime`, `PluginAgentClient`, and `PluginAgentSession` are implementation
evidence, not APIs a plugin can import or subclass. The Pi-native extension host
is another internal implementation, not an extension point for provider plugins.
[See report 2](02-paseo-native-pi-omp.md).

### Registration

The stable part of `ProviderRegistration` includes:

```ts
interface ProviderRegistration {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  getCatalogCacheKey?(options: ProviderCatalogOptions): Promise<string | undefined>;
  connect(request: ProviderConnectRequest): Promise<ProviderConnection>;
}
```

`server.registerProvider(registration)` registers it from `index.server.ts`.
`icon` is a plugin-relative, self-contained SVG, not arbitrary app UI code.
Provider IDs cannot collide with built-in providers: the snapshot manager rejects
those registrations. The plugin ID, provider ID, provider session ID, and Paseo
agent ID are distinct identities.

The newer `command`/`status` path lets the daemon resolve executable overrides and
produce availability diagnostics before connecting. Its `ProviderLaunch` carries
`command`, `args`, and a complete daemon-owned environment with overrides and
parent-session variables stripped. This is separate from session-specific env
overlays. It is a post-v0.10.0 convenience, not a baseline requirement. [P1, P4]

### Connection

```ts
interface ProviderConnection {
  readonly version: number;
  readonly capabilities: readonly string[];
  send(input: ProviderInput): Promise<void>;
  onEvent(listener: (event: ProviderEvent) => void): () => void;
  close(): Promise<void>;
}
```

`connect` receives the host's offered protocol versions and capabilities. The
connection selects version 1 and a supported subset. `send` accepts work; its
return value is not the operation result. Completion travels through events.
Listeners must exist before fast asynchronous results can arrive.

A connection can contain multiple provider sessions. The host protocol does not
require one external process per connection or per session; that is native
transport ownership, not a decision made by this report. `close` must release all
sessions, child processes, listeners, timers, and pending work. [P1, P3]

## Capability negotiation and enforcement

`negotiateProviderCapabilities(offered, supported)` returns the known,
deduplicated intersection. `session.opened.capabilities` can narrow that set for
an individual session. A session cannot select a known capability absent from
the connection's negotiated set. Unknown advertised strings are filtered rather
than becoming new host features. [P1, P5]

| Capability | Meaning and admission gate |
| --- | --- |
| `prompt.message` | Message content prompts |
| `prompt.command` | Structured command name and arguments |
| `prompt.image` | Message prompt containing an image part |
| `prompt.output_schema` | Prompt carrying `outputSchema` |
| `prompt.steer` | Input added to the active turn |
| `session.configure` | Dynamic model/mode/thinking/settings changes |
| `session.list` | Native session discovery/import |
| `session.persistence` | Opening from an opaque persistence handle |
| `session.archive` | Native archive operation |
| `session.unarchive` | Native unarchive operation |
| `session.revert.conversation` | Conversation-only revert |
| `session.revert.files` | Files-only revert |
| `session.revert.both` | Combined revert |
| `session.subsession` | Provider-owned child sessions; required on the direct parent |
| `permission` | Permission request/response exchange |
| `permission.tool_policy` | Exact MCP preapproval grants in session config |
| `timeline.plugin` | Provider-owned custom timeline presentation |

Catalog, interrupt, and close requests do not require a separate capability.
Persistence is required when opening with a handle; `persist: true` alone is not
the same admission check. Multiple prompt features can require multiple flags.

The inspected host checks custom timeline ownership, but has no analogous
`timeline.plugin` capability gate on those emitted rows. A foreign `pluginId`
fails the provider connection. This distinction is observed implementation
behavior, not permission to ignore the advertised capability contract. [P5]

The adapter's `AgentCapabilityFlags` hard-code streaming, reasoning, tool
invocations, and MCP-server support to true, but native Paseo tool support to
false. These UI/runtime flags are not proof that a particular native transport
implements MCP or reasoning correctly. The provider still has to honor the
configuration it receives. [P4]

## Configuration and discovery seam

`catalog` requests carry `requestId` and optional `cwd`. Replies contain models,
modes, thinking choices, and defaults. The cache-key callback can distinguish
global and workspace discovery. Shared cache keys need to account for the actual
execution/configuration context; otherwise two configurations can share stale
model discovery.

`ProviderModel` exposes IDs, labels, aliases, selectability, context-window size,
thinking options, defaults, and JSON metadata. There is no dedicated model price
field. `ProviderUsage.totalCostUsd` is a separate usage report.

`session.open.config` contains:

| Field | Contract |
| --- | --- |
| `cwd`, `env` | Working directory and session environment overlay |
| `systemPrompt` | Host/user system instructions |
| `mcpServers` | Named stdio, HTTP, or SSE definitions |
| `toolPolicy` | Optional exact `preapproved` MCP server/tool grants |
| `model`, `mode`, `thinkingOption` | Requested catalog selections |
| `settings` | JSON values for session controls |
| `providerOptions` | Provider-specific launch options; baseline is JSON |
| `title`, `persist` | Display name and persistence preference |

`session.config` returns the committed state, available choices, and controls.
Controls are toggle or select values. They are not arbitrary forms or a generic
extension-settings introspection API. `session.configure` changes model, mode,
thinking, and settings; it has no field for replacing `cwd`, env, system prompt,
or MCP definitions in place. Host refresh closes and reopens a session with
current configuration and persistence. [P1, P3, P4]

## Input and completion contracts

| Input | Expected result path |
| --- | --- |
| `catalog` | `catalog` with matching `requestId` |
| `sessions` | `sessions` with matching `requestId` |
| `session.open` | `session.opened`, state/history, then matching `session.ready`; failure through `request.failed` |
| `session.prompt` | Exactly one `session.prompt_result` for `clientMessageId`; turn events if work starts |
| `session.interrupt` | Terminal turn outcome as appropriate and `request.completed` or `request.failed` |
| `session.permission` | Response delivery and `session.permission_resolved` |
| `session.configure` | Committed `session.config` before `request.completed`, or `request.failed` |
| `session.revert` | `request.completed` or `request.failed`; provider owns state/history consequences |
| `session.archive` / `session.unarchive` | `request.completed` or `request.failed` |
| `session.close` | `session.closed` and request completion |

`requestId`, `clientMessageId`, and `turnId` serve different purposes. A prompt
has no ordinary operation `requestId`. It reports one of:

```ts
type PromptResult =
  | { type: "turn"; turnId: string }
  | { type: "steer"; turnId: string }
  | { type: "completed" }
  | { type: "failed"; error: ProviderError };
```

Every `session.turn` with `state: "started"` needs one terminal `completed`,
`failed`, or `canceled` event. `completed` as a prompt result means a command or
other side effect finished without creating a new tracked turn; it does not
substitute for a started turn's terminal event.

User timeline rows carry `clientMessageId` so the host can replace the optimistic
message. A provider that sends text without that association can produce duplicate
or incorrectly correlated user rows. The host does not infer native request
identity from text. [P3, P4]

`send` rejection is an admission/transport failure. Accepted work must settle
through the expected events. The inspected adapter stores pending requests and
prompts; missing replies can leave those operations waiting. Runtime failure and
connection close reject outstanding work, but are not substitutes for normal
operation completion. [P4]

## Timeline seam

Providers publish complete item snapshots, reusing `item.id` for updates. Paseo
derives its live deltas from those snapshots. Sending an incremental text delta
as though it were the new full value would lose earlier text.

Canonical types are `user_message`, `assistant_message`, `reasoning`, `tool_call`,
`todo`, `error`, `notification`, `compaction`, and `plugin`. Tool details include
shell, read, edit, write, search, fetch, worktree setup, subagent, plan, plain text,
and unknown input/output.

The tool item's `id` identifies the timeline row; `callId` identifies the native
tool invocation. Success/running/canceled rows have `error: null`; failed rows
carry JSON error data. A `sub_agent` detail can include `childSessionId`, but that
link alone does not open or populate a child session.

Provider-specific payloads use:

```json
{
  "type": "timeline.item",
  "sessionId": "root-session",
  "item": {
    "type": "plugin",
    "id": "extension-status-1",
    "pluginId": "provider-plugin-id",
    "kind": "extension-status",
    "version": 1,
    "data": {"state": "ready"}
  }
}
```

A client entry registers a renderer with the corresponding kind/version and
schema. Renderers are independent contributions, not executable Pi TUI widgets.
Server-side timeline append through `paseo.agents.ref(agentId).timeline.append`
is another documented path for durable plugin rows; its 64 KiB payload limit
must not be confused with a claim that every provider snapshot uses that same
limit. Client renderers still have to meet React Native and Hermes restrictions.
[P1, P3, project `AGENTS.md`]

## Permissions and tool access seam

Permission requests contain stable IDs, kind (`tool`, `plan`, `question`, `mode`,
or `other`), optional title/description/input/detail, actions, suggestions, and
metadata. Responses allow or deny and may include selected actions, updated
input, updated grants, or an interrupt request.

The provider owns the blocking native operation and the meaning of an approval.
Rendering a permission card does not enforce a tool policy by itself. Pending
dialog lifetimes, late responses, timeout handling, and cancellation have to
remain consistent with the external agent.

MCP config is passed as data. The SDK neither gives Pi an automatic MCP RPC
command nor lets the provider call a native Paseo tool registry directly.
Caller-scoped Paseo tools can be reached through a properly scoped bridge, as the
OMP reference demonstrates. That is not equivalent to `supportsNativePaseoTools`.
`permission.tool_policy` only represents exact MCP preapproval grants, not a
general Pi tool allowlist or pi-control policy language. [P1, P4]

## Persistence, restore, and revert

`ProviderPersistence` is `{ version: number, data: JsonValue }`. The host stores
and returns it without understanding native paths or IDs. It does not validate
the provider's resource authorization. The provider must re-resolve and authorize
the handle on open, particularly when it points to filesystem-backed history.

- `history: "replay"` asks for existing snapshots before `session.ready`.
- `history: "skip"` suppresses replay; it does not inherently mean a fresh native
  session. Restrictions beyond this are provider-specific.
- `restoration: "core"` means the host can reopen the session from persistence.
- `restoration: "parent"` means the provider recreates it while restoring its
  parent; the adapter does not retain independent persistence for that child.

Timeline identities may carry opaque `revertToken` values. The host associates
them with message IDs and returns the token with a requested scope. It does not
perform native conversation or file rollback for the plugin. Different revert
flags must be implemented independently rather than advertising a broader flag
because conversation forking happens to exist. [P1, P3, P4]

## Child-session seam

A provider opens a child with the same event vocabulary used for root sessions:

```json
{
  "type": "session.opened",
  "sessionId": "child-1",
  "parentSessionId": "root-session",
  "toolCallId": "spawn-call-1",
  "capabilities": [],
  "restoration": "parent",
  "title": "Research worker",
  "cwd": "/workspace/project"
}
```

The direct parent must already have negotiated `session.subsession`. A child
that can itself open grandchildren needs that capability too. An empty capability
set is valid for a read-only child track.

The internal adapter maps child events into the shared subagent index, derives
`parentSubagentId` from direct provider-session ancestry, and retains child
timeline snapshots. Terminal child turn events update status. A child
`session.runtime_failed` or errored close marks failure; a clean close marks
completion. A canceled child turn followed by a clean close can therefore have
its displayed terminal status overwritten to completed in the inspected adapter.
This is host behavior worth distinguishing from native status intent. [P4]

For `restoration: "parent"`, host-side close removes the child bridge rather than
sending it an independent native close request. Parent teardown remains the
provider's responsibility. The host's ability to render a child session does not
make it a separately controllable native process or a resumable Pi subagent.

## Adjacent plugin APIs

Provider registration is only one plugin contribution. Supported seams also
include:

- `defineRpc` plus `server.handle` for Zod-validated plugin client/server RPC.
- `server.registerSettings` with `read`/`subscribe` for persisted host settings.
- Lifecycle observers and `before` hooks, including `agent.session_open` with
  `agentId`, `workspaceId`, reason, purpose, cwd, and env.
- Client panels, surfaces, commands, composer pills, timeline transformers, and
  timeline renderers.
- `PluginHandlerContext.paseo` and hook context `paseo` for documented host API
  calls. `ProviderConnectRequest` itself is not a full `PaseoApi` object.

There is no generic hook for replacing the native Pi provider's internal parser
registry. A separate provider and companion client contributions are different
contracts from modifying native Pi support. [P2, P3]

## ACP alternative and its limits

`runAcpProvider` adapts an actual ACP agent through either a command or a stream
connector. Transformers can adjust discovery, config changes, vendor
notifications, and tool snapshots. They are narrow protocol adapters, not a way
to expose arbitrary direct-provider events.

The inspected shim offers message/command/configure/permission capabilities,
plus image/list/persistence when the ACP peer supports them. It does not offer
steering, subsessions, archive/unarchive, or revert. Archive/unarchive/revert
inputs explicitly fail. Pi's inspected CLI RPC is not ACP. These contracts
cannot be substituted without an additional adapter. [P6]

## Limits and unresolved questions

1. Public provider protocol version 1 spans API additions after v0.10.0. Minimum
   host/API compatibility must be explicit, not inferred from the version number.
2. Fixed host capability flags can overstate a native transport's actual support.
3. Custom JSON metadata can preserve provider information, but a built-in renderer
   does not automatically interpret arbitrary Pi tool details or extension UI.
4. No public native Pi parser-registration seam was found.
5. Child rendering, child control, child persistence, and parent restoration are
   separate requirements. The protocol does not collapse them into one feature.
6. This inspection does not establish a provider's throughput, mobile behavior,
   or compatibility against every host patch release.

No choice of provider ID, version floor beyond the existing project baseline,
process topology, or feature set is made here.

## Evidence and source map

Line ranges refer to the verified Paseo snapshot; the v0.10.0 comparisons use git
objects from the tag without changing the checkout.

| Ref | Source | Relevant content |
| --- | --- | --- |
| P1 | `packages/plugin/src/server/provider.ts:4-139,244-419,423-674,888-1414` | Public types, capabilities, schemas, event unions, admission |
| P2 | `packages/plugin/src/server/contracts.ts:9-44`; `packages/plugin/src/server/lifecycle.ts:10-104` | Server registration, RPC/settings, lifecycle hooks |
| P3 | `public-docs/plugins/providers.md`; `plugin-examples/provider-direct/server/provider.ts` | Documented lifecycle and complete example |
| P4 | `packages/server/src/server/agent/plugin-provider.ts:315-455,615-810,1290-1385,1505-1648` | Internal completion, normalization, child mapping, capability/config adaptation |
| P5 | `packages/server/src/server/plugins/runtime.ts:1032-1110`; `packages/server/src/server/agent/provider-snapshot-manager.ts:399-426` | Ownership/capability enforcement and provider ID conflicts |
| P6 | `packages/plugin/src/server/acp.ts:13-140`; `packages/plugin/src/server/acp-internal/connection.ts:52-99,235-247` | ACP API and supported/unsupported operations |

The direct-provider example and native adapter sources were inspected. No new
provider was installed or tested, and no daemon was reloaded for this report.
