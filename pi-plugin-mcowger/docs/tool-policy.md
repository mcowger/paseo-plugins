# Pi tool policy

## Status

Proposed design. This document replaces the current Pi Presets feature. It is the implementation contract for a host-scoped tool policy UI in `pi-plugin-mcowger`.

## Why this exists

`pi-plugin-mcowger` embeds Pi as a Paseo provider. A Pi session can receive tools from several places:

- Pi built-ins such as `read`, `bash`, `edit`, and `write`.
- User and project Pi extensions.
- External MCP servers supplied in the Paseo session configuration.
- Paseo's own agent/workspace/worktree/terminal/schedule tools, supplied through Paseo's `/mcp/agents` server.

Today the plugin exposes most of this catalog as-is. That works, but it makes the model's tool set noisy and gives a Pi agent host-management capabilities it may not need. In particular, an agent that can create a Paseo child can also receive workspace, worktree, terminal, schedule, and host-administration tools.

The desired model is straightforward:

> A Pi session should see only the tools its role needs. Paseo host tools are an optional subset of that policy, not an all-or-nothing side effect of MCP injection.

This is also the right base for native Paseo subagents. A Pi coordinator can use Paseo's `create_agent` tool to create real Paseo children, while a worker can receive no Paseo orchestration tools at all. Paseo then owns child-agent lifecycle, workspaces, worktrees, status, permissions, and archival. The plugin does not need to vendor or operate another Pi subagent runtime.

## Goals

1. Let users control which tools are exposed to Pi models hosted by this plugin.
2. Let users separately control which Paseo host tools are bridged into Pi.
3. Keep the policy easy to find. It must have a dedicated plugin Settings screen and a global Command Center entry that opens that screen.
4. Apply Paseo host-tool filtering before those tools are registered in Pi.
5. Apply the general Pi tool policy to the final registered Pi tool set, including Pi built-ins, extensions, and bridged MCP tools.
6. Respect Pi's own configured/default tool selection. This plugin policy narrows access; it does not silently enable a tool the user disabled in Pi.
7. Persist one host-scoped policy shared by all Paseo clients connected to that host.
8. Make all matching and policy resolution deterministic, testable, and visible in startup diagnostics.
9. Keep existing third-party Pi subagent extensions supported as user-installed extensions. They are not part of this feature's implementation or dependency graph.

## Non-goals

- This is not a sandbox or a security boundary. An agent that has `bash` can still invoke local commands such as `git worktree` or `paseo`, regardless of which MCP tools are hidden.
- This does not vendor, install, configure, or auto-detect a Pi subagent package.
- This does not implement a new Pi subagent manager.
- This does not recreate Paseo worktree management in the plugin. Native Paseo tools own managed workspaces and worktrees.
- This does not introduce Pi model/thinking/system-prompt presets. Paseo's normal model and thinking controls remain the source of truth for those choices.
- This does not guarantee a per-child policy yet. A child-specific policy needs a host/provider launch contract that can carry and enforce it. The initial policy applies to every session using this provider.

## Replacing Pi Presets

Pi Presets overlap with the proposed policy feature: both are host-owned settings that modify a Pi session's active tool set. Presets also bundle model, thinking level, and appended system-prompt content, which makes it unclear which layer owns a session's behavior.

The replacement has one responsibility: tool availability.

The implementation must remove:

- the `pi-presets` host settings schema and revision-sync RPC;
- the Pi Presets Settings screen;
- provider catalog modes created from presets;
- the `preset` command and `preset-state` custom session entries;
- preset application, modified-state tracking, and preset-specific system-prompt changes.

Do not silently convert existing preset tool patterns into the new policy. A preset may have been selected for its model, thinking level, or system prompt rather than its tools. Applying its tool restrictions globally would be surprising.

On upgrade, retain the old settings document only as unused host data if the host does not provide a safe deletion API. The first Tool Policy screen should state that Pi Presets were removed and that model/thinking choices now use Paseo's ordinary composer controls. The old document must not influence new sessions.

## Policy model

The settings document contains two independent policies.

### Pi tool policy

The Pi tool policy applies to the final Pi tool names available to the model. It covers:

- Pi built-in tools;
- tools registered by loaded Pi extensions;
- tools bridged from non-Paseo MCP servers;
- bridged Paseo MCP tools after their names are converted to Pi names.

The policy is restrictive only. It never activates a tool that Pi did not already make active for the session.

```ts
interface PiToolPolicy {
  mode: "inherit" | "allowlist";
  allowedPatterns: string[];
  blockedPatterns: string[];
}
```

- `inherit` keeps Pi's normal active-tool selection, then removes anything matching `blockedPatterns`.
- `allowlist` starts from Pi's normal active-tool selection, keeps only names matching `allowedPatterns`, then removes names matching `blockedPatterns`.
- A block always wins over an allow match.
- Empty or whitespace-only patterns are discarded during normalization.
- Patterns use the existing `minimatch` behavior from `server/tool-patterns.ts`; they are case-sensitive Pi tool-name patterns and must use `nonegate: true`.

Examples:

```json
{
  "mode": "inherit",
  "allowedPatterns": [],
  "blockedPatterns": ["bash", "mcp_linear_*"]
}
```

```json
{
  "mode": "allowlist",
  "allowedPatterns": ["read", "find", "grep", "ls", "mcp_paseo_get_agent_*"],
  "blockedPatterns": []
}
```

### Paseo host-tool policy

The Paseo host-tool policy applies only to tools supplied by Paseo's `/mcp/agents` server. It uses Paseo's canonical tool names before the bridge sanitizes them into names such as `mcp_paseo_create_agent`.

```ts
interface PaseoHostToolPolicy {
  enabled: boolean;
  disabledTools: string[];
}
```

- `enabled: false` registers no tools from Paseo's `/mcp/agents` server.
- When enabled, `disabledTools` removes exact canonical Paseo tool IDs.
- This policy does not affect user-configured non-Paseo MCP servers.
- This policy does not affect local Pi built-ins or Pi extension tools.

Examples:

```json
{
  "enabled": true,
  "disabledTools": [
    "create_workspace",
    "list_workspaces",
    "archive_workspace",
    "create_terminal",
    "send_terminal_keys",
    "kill_terminal",
    "create_schedule"
  ]
}
```

```json
{
  "enabled": false,
  "disabledTools": []
}
```

### Full document

The initial host-scoped settings document should be named `pi-tool-policy`, versioned at `1`, and validate with Zod in `shared/`.

```ts
interface PiToolPolicySettings {
  piTools: PiToolPolicy;
  paseoTools: PaseoHostToolPolicy;
}
```

Recommended defaults:

```json
{
  "piTools": {
    "mode": "inherit",
    "allowedPatterns": [],
    "blockedPatterns": []
  },
  "paseoTools": {
    "enabled": true,
    "disabledTools": []
  }
}
```

These defaults preserve current behavior: Pi keeps its normal active tools and Paseo's injected host catalog remains available when Paseo injects it.

## Settings UI

The settings screen is the main UI for this feature. It must be registered with `client.addSettingsScreen` and use only Paseo React Native components and theme colors.

The screen must also be discoverable without navigating through the Settings hierarchy. Register a global `client.addCommandCenterItem` entry, for example:

```text
Configure Pi tool policy
```

Its action opens this plugin's Tool Policy settings screen through the documented client navigation API. Do not add a hidden slash command as the primary discovery path.

### Screen layout

Use three sections.

#### Pi tool access

Show an explanation that these rules apply to the tools the Pi model can call.

Controls:

- `Inherit Pi defaults` / `Allow only matching tools` selector.
- editable allow-pattern list, visible only for allowlist mode;
- editable blocked-pattern list;
- a compact explanation of glob matching;
- a warning when an allowlist resolves to no known tools in the active-session preview, if a preview is available.

The first version may use newline-separated pattern editors. A future version can offer source-aware tool pickers, but it must retain the text pattern form for tools supplied only after a session opens.

#### Paseo host tools

Show grouped toggles backed by canonical Paseo tool IDs. A group toggle only edits `disabledTools`; it does not affect Pi built-ins or other MCP servers.

Recommended groups:

| Group | Representative tools |
| --- | --- |
| Agent delegation | `create_agent`, `send_agent_prompt`, `wait_for_agent`, `get_agent_status`, `get_agent_activity`, `cancel_agent`, `archive_agent`, `kill_agent`, `update_agent`, `set_agent_mode` |
| Workspaces and worktrees | `create_workspace`, `list_workspaces`, `rename_workspace`, `archive_workspace` |
| Terminals and workspace scripts | terminal and workspace-script tools |
| Schedules and heartbeats | schedule and heartbeat tools |
| Browser and voice | browser automation and `speak`, when present |
| Other host administration | remaining Paseo management tools |

A master `Expose Paseo host tools` toggle controls `paseoTools.enabled`.

The UI must say clearly that this is a model-facing catalog policy, not filesystem or shell sandboxing. In particular, hiding `create_workspace` does not stop a model with `bash` from running `git worktree` or the Paseo CLI.

#### Effective behavior

Show a short, static explanation:

```text
Paseo tools are removed before Pi registers them.
Pi tool rules then narrow the active tools for every new Pi session.
Changes apply after the affected agent is refreshed or reopened.
```

Do not promise live addition/removal of host tools in an already-open session. A new MCP bridge is created at session open, so reopening is the predictable boundary.

### Persistence and synchronization

Follow the existing host-settings pattern:

1. Define the settings schema in `shared/`.
2. Register it from `index.server.ts`.
3. Use `useSettings` in the client screen.
4. Synchronize revisioned validated settings to a server-side policy store through a `defineRpc` contract.
5. Use the store snapshot when creating each provider session.
6. Refresh the provider catalog only if a future catalog needs to expose policy-derived choices. The first version has no provider modes and should not refresh just to change settings UI.

The policy store must be immutable from a session's perspective. A session captures its policy at open. Saving changes affects sessions opened or refreshed afterwards.

## Runtime application

### 1. Capture the host-policy snapshot

At `session.open`, read the current policy-store snapshot and pass it through the session creation path. Do not read the settings document directly from arbitrary server code or from the client.

### 2. Filter Paseo MCP tools before registration

`createMcpBridge()` already recognizes Paseo's `/mcp/agents` endpoint and calls `client.listTools()`.

Replace the current file-based `readPiPaseoToolPolicy()` behavior with the captured host policy. For a Paseo MCP server:

1. If `paseoTools.enabled` is false, do not register any of its tools.
2. Otherwise remove entries whose canonical `mcpTool.name` is in `disabledTools`.
3. Convert only the remaining tools into Pi custom tools.

Apply the policy to `mcpTool.name`, not to the generated `mcp_<server>_<tool>` name. The canonical name is stable across MCP server aliases and sanitization details.

The Paseo daemon may already return a caller-scoped filtered catalog. Treat that as an upstream constraint and this plugin policy as a second narrowing layer. Never add a tool that the server did not return.

### 3. Build the Pi session normally

Load normal Pi resources and extensions through `DefaultResourceLoader`, then create the Pi `AgentSession` with the selected custom tools.

Do not mutate user Pi configuration files, package configuration, or global process environment.

### 4. Narrow the final active Pi tools

After the session exists, gather:

- `session.getAllTools()` for all known tool definitions;
- `session.getActiveToolNames()` for Pi's baseline active set.

Resolve the final set as an ordered intersection:

```text
baseline active Pi tools
  ∩ known registered tools
  ∩ allowlist, when mode = allowlist
  − blocked patterns
```

Then call:

```ts
session.setActiveToolsByName(finalToolNames)
```

Preserve the baseline order. Do not sort names, and do not enable a known-but-inactive tool merely because it matched the policy.

When a tool is removed at either stage, it must be absent from the model's system prompt and unavailable to tool calling.

### Diagnostics

At session open, add one bounded startup diagnostic when policy changes the visible catalog. It should report counts and categories, not the full unbounded tool list:

```text
Pi tool policy: active tools 14 -> 8; blocked 2 Pi tools and 4 Paseo host tools.
```

A detailed list is appropriate only in the settings screen or a future explicit diagnostic command. Do not leak prompt content, MCP credentials, or arbitrary tool schemas.

## Relationship to native Paseo subagents

The preferred subagent path is native Paseo delegation:

```text
Pi model
  -> Paseo create_agent tool
  -> Paseo-owned child agent
  -> optional Paseo-managed workspace/worktree
```

This gives the child a durable Paseo agent ID, lifecycle, status, permissions, archive behavior, and workspace ownership. It works naturally in the Paseo app and in a terminal client such as `paseo-tui`.

The policy feature should make a coordinator-style tool set practical. For example, enable only agent delegation/status tools and hide workspace, terminal, schedule, and browser tools when they are not needed.

The initial implementation cannot make a different policy apply automatically to a Pi child using the same plugin provider ID. That needs a child-scoped launch policy or first-class plugin-provider profiles in Paseo. Until then, document the policy as provider-wide and avoid claiming it stops recursive delegation for only children.

## Compatibility with Pi extensions

User-installed Pi extensions continue to load normally.

- The general Pi tool policy can hide an extension's registered tools from the model.
- Hiding a tool does not stop the extension's lifecycle handlers from running.
- An extension may still use `bash`, Node APIs, timers, sockets, or its own background work. Tool policy is not extension sandboxing.
- Existing `task` / `subagent` timeline mapping remains compatibility behavior for users who independently install a subagent extension.

Do not inspect an extension name or tool name to decide whether to install another subagent package. The policy feature deliberately avoids that ownership problem.

## Migration plan

1. Add the new host-scoped settings schema, policy store, sync RPC, settings screen, and Command Center item.
2. Implement the policy against new/refreshed sessions while leaving existing sessions unchanged until refresh.
3. Remove Pi Presets from the provider catalog, composer modes, commands, settings UI, and session state.
4. Remove preset tests and add policy tests before deleting the preset implementation completely.
5. Update the plugin README to describe the Tool Policy screen and native Paseo delegation.

Keep the change as one behavior migration. Do not leave a hidden preset parser or inactive composer mode behind.

## Verification

Add deterministic unit tests for:

- settings-schema defaults, validation, and duplicate/blank normalization;
- allowlist/blocklist intersection and stable ordering;
- glob behavior for Pi tool names;
- exact canonical filtering of Paseo MCP tool names before sanitization;
- disabled Paseo catalog behavior;
- the rule that policy never enables a baseline-inactive Pi tool;
- policy-store revision synchronization and stale-write rejection;
- no preset modes, `preset` command, or preset-state entries after migration.

Add provider/session tests for:

- a session with unrestricted defaults;
- a read-only Pi policy;
- a blocked `bash` tool;
- a blocked Paseo `create_workspace` tool;
- a session with the entire Paseo catalog disabled;
- policy changes taking effect only after a fresh session open or refresh;
- a user extension tool hidden from Pi while the extension itself still loads;
- a known external MCP server unaffected by the Paseo-only policy.

Run from `pi-plugin-mcowger/`:

```sh
npm run lint
npm run typecheck
npm test
npx vitest run --config vitest.smoke.config.ts
```

Then reload the plugin and verify on a Paseo desktop/mobile client:

```sh
paseo plugin reload pi-plugin-mcowger
```

Manual checks:

- the Command Center finds and opens `Configure Pi tool policy`;
- the settings screen works on desktop and mobile;
- the settings screen uses host theme colors and has loading/error/saving states;
- a newly opened Pi agent has the expected tool list;
- a refreshed agent reopens with the updated policy;
- native Paseo `create_agent` remains available when its canonical tool is enabled;
- blocked host tools do not appear in Pi's model-visible tools.

## Future work

This design intentionally leaves several larger changes out of the first release:

- first-class provider profiles for plugin providers, including different parent/worker Paseo host-tool policies;
- per-child policy passed by native `create_agent` and enforced at child session open;
- a source-aware picker for dynamically discovered Pi extension tools;
- a read-only inspection panel showing the effective tool set of a live Pi session;
- richer native Paseo timeline rendering for third-party Pi subagent packages.

Those features should build on the policy store and runtime resolution described here rather than add another independent configuration mechanism.
