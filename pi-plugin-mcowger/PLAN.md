# pi-plugin-mcowger — Plan & State

A Paseo provider plugin for the [pi](https://github.com/earendil-works/pi) coding agent.

**Current architecture (pivot):** embeds pi **in-process** via
`@earendil-works/pi-coding-agent` SDK (`createAgentSession`, bundled into the plugin
server bundle), replacing the initial `pi --mode rpc` subprocess transport. The RPC
approach was abandoned after hitting: pi CLI flag slow path (~30s session opens),
process-lifecycle crash loops, and marker-protocol fragility. The SDK path eliminates
all three and additionally gives: direct `navigateTree` rewind, in-process
`ExtensionUIContext` → Paseo permission bridging, `getSessionStats()` usage, and
extension-warm model catalogs.

## Decisions (final)

| Topic | Decision |
|---|---|
| pi source | **Bundle `@earendil-works/pi-coding-agent` 0.85.1** as a plugin dependency; global pi binary, `PI_COMMAND`, and version probe deleted |
| Host target | Paseo **≥ 0.8.0** (manifest requirement; repo SDK pins at 0.8.0) |
| Tool policy | **Paseo-owned**: host-scoped settings edited in a plugin Settings screen, synchronized to the provider through a revisioned RPC, filtering Paseo host tools before MCP registration and narrowing Pi's final active tool set. |
| User extensions | Load normally via `DefaultResourceLoader` (plexus provider, rpiv-todo, pi-subagents, etc.) — verified they register into the shared ModelRuntime after a one-time warmup session |
| MCP | Paseo-injected MCP servers are connected **in-process** via `@modelcontextprotocol/sdk` and exposed as pi custom tools `mcp_<server>_<tool>`; no mcp.json temp files, no pi-mcp-adapter dependency |
| Todos | rpiv-todo `details.tasks` (+ pi-example `details.todos`) → native `type:"todo"` timeline items, live + replay |
| Subagents | Foreground `task`/`subagent` calls → native `sub_agent` tool detail |
| Permissions | Headless `ExtensionUIContext` (bound via `session.bindExtensions`, mode `"rpc"`): select/confirm/input/editor → Paseo permission questions; notify → notification items; `custom()` rejects (no TUI) |
| Rewind | Conversation rewind is advertised through Paseo's provider capability and uses Pi tree navigation with active-branch replay and persistence refresh. File and combined rewind remain unsupported. |
| Persistence | `SessionManager.open(sessionFile)` resume; `history:"replay"` streams mapped message history before `session.ready` |
| Catalog | `ModelRuntime.create()` (cached catalogs, no network by default) + extension warmup; per-model `thinkingOptions` from `reasoning` + `thinkingLevelMap` (PR #4413 semantics) |
| Commands published | `compact`, Pi extension commands, plus prompt templates discovered by the loader |
| Testing | Unit tests cover policy resolution, fake SDK sessions, and an in-process smoke suite (catalog, live prompt with streaming, persistence/resume) |

## Known limitations

- `ask_user`'s combined select+comment flow is simplified to sequential dialogs.
- Foreground-only subagent rendering; detached pi-subagents background runs are out of scope.
- Project-local extensions that register providers (rare) only appear after that cwd's
  session loads them.
- Tool Policy settings synchronize to the provider when the Tool Policy settings screen saves or reloads
  the document.
- File and combined rewind are unsupported because Pi tree navigation only changes conversation
  history and does not provide an atomic workspace-file rewind contract.
- Fork visibility is host-gated by Paseo's global `agentForkContext` feature; the provider plugin
  has no provider-level fork capability to advertise or withdraw.

## Planned: profile-specific tool policies

### Goal

Let a saved Paseo agent profile select a complete, restrictive Pi tool catalog. This
makes profiles such as Explore, Build, and Coordinator useful without exposing the
same write, shell, or host-management tools to every Pi agent.

The existing host-scoped Tool Policy stays in place as the fallback for an agent
without a configured profile policy. A configured profile replaces that fallback; it
does not layer on top of it.

This is still catalog control, not a security boundary. An agent with `bash` can
invoke local commands, and a caller able to construct provider settings can spoof a
profile marker. The feature controls what Pi presents to the model, not what a local
process is capable of doing.

### Why this needs a marker

Paseo v0.8 applies an agent profile by materializing its provider, model, mode,
thinking option, and feature values into `session.open`. It deliberately does not
pass the profile ID or name to a plugin provider. Matching profiles back from those
materialized values is ambiguous: profiles can share the same values, and a user can
manually select the same controls.

Use a plugin-owned feature value, with a named shared constant such as
`PI_TOOL_POLICY_PROFILE_ID_SETTING`, whose value is the saved profile's stable ID.
The plugin must automatically maintain that value for every profile whose provider
is `pi-plugin-mcowger`:

- A profile policy first applies when the marker exactly matches one configured policy
  record.
- Paseo can drop an unrecognized marker from draft feature state. In that case, one unique
  saved model/mode/thinking signature applies its policy; matching signatures shared by multiple
  policies deliberately use the fallback.
- A marked Pi profile with no configured policy, or a malformed or unmatched marker, uses the
  host fallback and produces a bounded startup diagnostic where useful.
- The provider strips this marker before constructing Pi runtime settings and before
  reporting unsupported Pi setting IDs. It must not reach Pi as a composer setting.
- The marker is plugin-owned. Marker sync corrects a value that points at a different
  profile ID, while preserving every other feature value and every non-Pi profile.

The marker is a plugin-only workaround for the missing Paseo profile identity launch
contract. If Paseo later sends an authenticated profile ID through `session.open`,
replace marker matching with that contract and retain the same policy resolution
model.

### Settings document and migration

Bump the `pi-tool-policy` host settings document to version 2 while preserving the
current global fields as the fallback:

```ts
interface PiToolPolicySettings {
  piTools: PiToolPolicy; // existing fallback policy
  paseoTools: PaseoHostToolPolicy; // existing fallback policy
  profilePolicies: ProfileToolPolicy[];
}

interface ProfileToolPolicy {
  profileId: string;
  allowedPiToolNames: string[];
  allowedPaseoToolNames: string[];
  allowedExternalMcpPatterns: string[];
}
```

`profilePolicies` defaults to an empty list so existing installations retain current
behavior. Normalize IDs, exact Pi tool names, canonical Paseo names, and external
patterns by trimming, dropping blanks, and deduplicating. Reject duplicate profile
records. An empty profile rule is valid and intentionally exposes no tools.

Do not persist a profile name as an identity. The UI receives names from Paseo only
for display. Keep a selected Pi tool that is absent from the current discovery result;
show it as stale rather than deleting it, because it may belong to another workspace
or a temporarily unavailable extension.

Profile records must be pruned when the settings screen synchronizes profiles and a
record's ID no longer exists or no longer uses this provider. This is client-mediated:
Paseo does not expose a supported server-side plugin-settings read/write API. Do not
try to mutate plugin settings from a daemon-config event handler.

### Profile discovery and marker maintenance

Do not call `paseo_list_profiles` through the MCP bridge for the settings page. The
bridge and its capability token only exist during provider `session.open`.

Add narrow server RPCs that use the handler's `context.paseo.config.get()` and return
a sanitized list of Pi-provider profiles only:

```ts
interface PiProfileSummary {
  id: string;
  name: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  notes?: string;
}
```

The RPC must not return the raw daemon config, provider credentials, or unrelated
profiles. A marker-sync RPC reads the latest daemon config, updates only the reserved
feature-value key on every Pi profile, and patches the complete `agentProfiles` list.
It must serialize its own writes, re-read immediately before merge/patch, preserve
unknown profile fields, and retry a lost update conservatively because daemon config
patches have no revision/CAS contract.

The settings screen runs profile fetch/marker sync on load and on explicit retry or
save. It then prunes deleted/non-Pi policy records through `useSettings` and the
existing revisioned policy-store sync. If profile access or marker sync fails (for
example, missing `daemon.manage` authority), keep the fallback editor available,
show the profile section as unavailable with retry, and never discard saved profile
rules. Profile writes require only the narrow marker operation, not a general daemon
config mutation API.

### Known Pi-tool discovery

Add a server RPC that probes the global Pi environment without opening a Paseo agent:

1. Create `DefaultResourceLoader` for Pi's global/home cwd and agent directory.
2. Reload it, create an in-memory `SessionManager`, and create an in-memory Pi
   `AgentSession`.
3. Read `getAllTools()` and the baseline active tool names.
4. Include the plugin fallback `todo` tool when no global extension provides it.
5. Dispose the temporary session in `finally`.

Return only bounded presentation data needed by the picker, such as name, description,
source metadata, and whether the tool is baseline-active. This probes global Pi
resources; project-local extensions remain unavailable until a future workspace-aware
feature exists. If the probe fails, retain saved/stale tool selections, allow Paseo
and external-MCP edits, and show a retryable error. Never replace the result with a
hard-coded built-in list that can drift from Pi.

### Settings UI

Keep the existing global sections but label them as the fallback policy. Add a
"Profile policies" section containing every saved profile whose provider is
`pi-plugin-mcowger`.

Each profile card needs:

- a switch or explicit action to create/remove its strict policy record;
- a searchable checkbox picker of global Pi built-ins and extension tools, including
  `todo` when available;
- a clear stale-selected state for saved names absent from the current probe;
- canonical Paseo host tools, displayed once under their real names, with group
  toggles and individual tool checkboxes for exceptions;
- an advanced newline-separated external MCP allow-pattern editor using the existing
  case-sensitive `minimatch` behavior;
- an explicit warning that an enabled-but-empty rule creates a chat-only, no-tool
  agent; and
- copy explaining that changes apply after an agent is opened or refreshed.

Do not show bridge names such as `mcp_paseo_create_agent` in the UI. Paseo tool
selection uses only canonical IDs such as `create_agent`. The bridge maps them to Pi
names internally. External MCP patterns apply only to tools identified by the bridge
as non-Paseo tools, even if a Paseo MCP server uses an alias other than `paseo`; they
cannot expose a Paseo tool through a second route.

Keep the current external-MCP pattern syntax rather than adding an alias-specific
picker. MCP servers are session-specific, and a profile page cannot reliably discover
them before a session opens.

### Runtime resolution

At `session.open`, snapshot the policy store once, read and strip the profile marker
from `config.settings`, and select one of two immutable policies:

1. a matching configured profile's complete strict policy; or
2. the existing global fallback policy.

For the fallback path, retain the existing behavior unchanged:

- remove disabled canonical Paseo tools before bridge registration;
- start from Pi's baseline active set;
- apply fallback allow/block rules without enabling baseline-inactive tools.

For a configured profile:

1. Filter Paseo `/mcp/agents` tools by the profile's exact canonical allow set before
   bridge registration.
2. Register non-Paseo MCP tools normally, then consider them only if their generated
   Pi name matches an external-MCP allow pattern.
3. Create the Pi session normally and obtain its baseline active and known tools.
4. Preserve baseline order while keeping only:
   - exact selected Pi built-in/extension/fallback-todo names;
   - bridge names that map to selected canonical Paseo tools; and
   - bridge names identified as non-Paseo MCP tools that match an external pattern.
5. Call `setActiveToolsByName()` with that final list.

Extend MCP bridge metadata to retain the relation between each generated Pi name, its
canonical MCP name, and whether it came from the recognized Paseo endpoint. Do not
infer this from a generated name prefix, because a host MCP server can be injected
under any alias.

If Pi cannot report its active baseline for a configured strict profile, disable all
tool calls and emit a diagnostic. It is safer than letting an unresolved strict policy
silently expose Pi's default catalog. Emit bounded diagnostics for profile-policy
selection and changed catalog counts only; never list credentials, arbitrary schemas,
or unbounded tool lists in the timeline.

`/reload` remains a Pi resource reload only. It does not rebuild the bridge or alter
an existing session's catalog. Policy changes take effect after a new session open or
Paseo refresh/reopen.

### Files and responsibilities

| Area | Planned change |
| --- | --- |
| `shared/tool-policy.ts` | Version-2 profile-policy schema, marker constant, normalized profile records, profile/profile-discovery RPC contracts, and sanitized view models. |
| `server/tool-policy.ts` | Complete-profile resolver, strict active-tool resolver, canonical Paseo allow filtering, external-MCP pattern resolver, and diagnostics. |
| `server/mcp-bridge.ts` | Preserve generated-name-to-canonical/source metadata while filtering only recognized Paseo tools before registration. |
| `server/provider.ts` | Strip/read marker, choose fallback vs profile snapshot, probe known Pi tools through an RPC handler, and enforce selected policy at session open. |
| `index.server.ts` | Register narrow profile discovery/marker-sync handlers plus existing settings-store RPCs; serialize marker patches. |
| `client/tool-policy-settings.tsx` | Load/sync sanitized profiles and known Pi tools, maintain markers, prune invalid records during settings sync, and render fallback/profile editors with unavailable/error states. |
| `index.client.tsx` | Keep the existing Settings and Command Center discovery path; no agent-specific surface is needed. |
| `README.md` and `docs/tool-policy.md` | Describe fallback vs profile behavior, global discovery limits, marker workaround, non-sandbox caveat, and refresh boundary. |

### Verification plan

Add deterministic tests for:

- v1-to-v2/default schema compatibility, normalization, duplicate profile rejection,
  stale selections, and an intentional empty policy;
- selection of fallback versus exact marker-matched profile policies;
- stripped marker behavior and absence of an unsupported-setting diagnostic;
- profile strict resolution preserving baseline order and never enabling inactive Pi
  tools;
- exact Pi selection, canonical Paseo selection, external-pattern matching, and the
  rule that external patterns cannot admit Paseo-origin bridge tools;
- canonical mapping when the Paseo MCP server has a non-`paseo` alias;
- disabled/empty Paseo profile catalog and a configured profile that exposes only
  `create_agent`;
- global Pi discovery success, fallback todo inclusion, error cleanup, and a failed
  probe preserving saved selections;
- profile discovery serialization/redaction, marker patch merge behavior, marker
  correction, profile deletion/provider-change pruning on settings sync, and retry
  behavior for concurrent daemon-config changes;
- settings UI loading, unavailable, stale, save-conflict, and empty-policy warning
  states; and
- provider/session integration for fallback sessions, read-only Explore-style
  profiles, coordinator delegation profiles, external MCP patterns, and policy
  changes taking effect only after reopen/refresh.

Run from `pi-plugin-mcowger/`:

```sh
npm run lint
npm run typecheck
npm test
npx vitest run --config vitest.smoke.config.ts
```

Then reload the plugin and manually verify on desktop and mobile that profile marker
sync, profile selection, fallback behavior, stale-tool messaging, canonical Paseo
selection, and refresh boundaries all behave as described.
