# Pi tool policy

## Status

The host-wide policy remains the fallback policy model. Profile-specific policies are implemented for saved Pi-provider profiles.

This document describes the profile-policy behavior, including the profile UI, discovery RPCs, marker sync, and strict runtime enforcement.

## Scope

`pi-plugin-mcowger` embeds Pi as a Paseo provider. A Pi session can receive:

- Pi built-ins such as `read`, `bash`, `edit`, and `write`;
- tools from Pi extensions;
- tools from external MCP servers in the Paseo session configuration; and
- Paseo agent, workspace, terminal, and schedule tools from Paseo's MCP endpoint.

Tool policy controls the catalog shown to the model. It is not a sandbox or security boundary. An agent with `bash` can still run local commands, including `paseo` or `git worktree`, regardless of hidden MCP tools. Extensions can also retain Node, process, timer, socket, and lifecycle capabilities after their tools are hidden.

## Host fallback policy

The existing host-scoped `pi-tool-policy` settings remain the fallback for every Pi session that does not select a configured profile policy.

The fallback has two parts:

- **Pi tool policy.** Starts from Pi's baseline active tools, optionally allowlists Pi tool-name globs, then removes blocked globs. It never enables a tool Pi left inactive.
- **Paseo host-tool policy.** Is default-allow and removes disabled canonical Paseo tool IDs before the plugin registers the Paseo MCP bridge. It does not affect Pi built-ins, extensions, or external MCP servers.

The fallback editor organizes Paseo host tools into nine focused categories, with individual canonical
ID overrides in each category:

- Agent orchestration
- Agent sessions
- Workspaces and worktrees
- Terminals and workspace scripts
- Schedules and heartbeats
- Providers and profiles
- Permissions
- Browser automation
- Voice

Categories are UI conveniences. The disabled canonical IDs are what the runtime uses, so an individual
override can differ from its category toggle.

For this path, host tools are filtered first and Pi rules narrow the resulting active catalog. The session snapshots the policy at open, so saving settings affects only agents opened or refreshed afterwards.

## Profile policies

A configured policy for a saved Paseo profile fully replaces the host fallback. It does not merge with, add to, or inherit the fallback policy.

A profile policy contains:

```ts
interface ProfileToolPolicy {
  profileId: string;
  allowedPiToolNames: string[];
  allowedPaseoToolNames: string[];
  allowedExternalMcpPatterns: string[];
}
```

Each list is normalized by trimming entries, dropping blanks, and removing duplicates. Profile IDs are stable identities; profile names are display-only. Duplicate profile records are invalid.

An empty profile policy is valid. It intentionally gives the model no tools.

For a matching configured profile, the final catalog preserves Pi's baseline order and includes only:

- selected Pi built-in, extension, and plugin fallback-tool names;
- Paseo tools selected by their exact canonical Paseo IDs; and
- non-Paseo external MCP tools whose generated Pi name matches an allowed external-MCP glob.

A profile policy cannot activate a baseline-inactive Pi tool. If Pi cannot report that baseline for a strict profile, the safe result is no tool calls rather than Pi's unrestricted defaults.

### Canonical Paseo tools

The settings UI shows Paseo tools once, by their canonical IDs such as `create_agent`. It does not show generated bridge names such as `mcp_paseo_create_agent`. `wait_for_agent` is not a listed tool. The Providers and profiles category contains `list_profiles`.

The bridge maps canonical Paseo tools to Pi names internally. It also tracks whether a bridged tool came from the recognized Paseo endpoint, rather than inferring that from the MCP server alias. This prevents an external pattern from admitting a Paseo tool through an alias.

### External MCP patterns

External-MCP patterns are advanced, newline-separated globs using the existing case-sensitive `minimatch` behavior. They apply only to non-Paseo tools bridged from session-specific MCP servers.

There is no pre-session external-MCP picker. Those servers are session-specific, so a profile editor cannot reliably discover them in advance.

## Profile marker and selection

Paseo v0.8 materializes profile values into `session.open`, but does not provide plugin providers with the selected profile's identity. The implementation uses a plugin-owned feature-value marker whose value is the saved profile ID.

Marker synchronization automatically adds or corrects that reserved marker on every saved profile using `pi-plugin-mcowger`, while preserving its other feature values. It does not change non-Pi profiles.

The composer profile indicator stores the exact marker in the provider's persisted session payload at `session.open`. Paseo keeps that payload across reloads and resume, so the indicator does not infer a profile from model, mode, or thinking settings. If the marker is absent, the indicator reports that the profile was not identified.

At session open, the provider reads and strips the marker before passing runtime settings to Pi:

- an exact marker match to a configured policy selects that profile's strict policy;
- when Paseo drops the marker from its draft feature state, one uniquely matching saved model, mode, and thinking configuration selects that profile's strict policy;
- a marked Pi profile with no configured policy uses the host fallback; and
- a missing marker with no unique saved launch configuration, or a malformed or unmatched marker, uses the host fallback.

The settings screen backfills each configured profile policy's launch configuration automatically. It is a compatibility fallback, not authentication: profiles sharing the same materialized launch configuration remain deliberately ambiguous and use the host fallback. A caller that can construct provider settings can also spoof the marker. If Paseo later supplies an authenticated profile ID at launch, that should replace both matching paths without changing the fallback-versus-profile resolution model.

## Discovery, stale selections, and cleanup

The settings page uses narrow config RPCs before a provider session opens to discover sanitized summaries of Pi-provider profiles and to synchronize their markers. It does not use the session MCP bridge or expose raw daemon configuration, credentials, or unrelated profiles.

Known Pi-tool discovery probes the global Pi environment through a temporary session. It can list global built-ins, globally loaded extensions, and the plugin's fallback `todo` tool when appropriate. It cannot reliably see project-local extensions until a workspace-aware design exists.

Because discovery is incomplete and can fail, saved Pi selections that are absent from the current result stay saved and appear as stale. The editor does not delete them merely because a global probe cannot see their workspace or extension.

On settings synchronization, saved profile-policy records whose IDs no longer exist, or whose profiles no longer use `pi-plugin-mcowger`, are pruned. If profile discovery or marker sync is unavailable, the host fallback editor remains usable and saved profile rules are retained rather than discarded.

## Lifecycle boundary

Policy is captured once at `session.open`.

Changes apply when an agent opens, refreshes, or reopens. `/reload` reloads Pi resources only; it does not rebuild an existing MCP bridge or change an already-open session's tool catalog.

## Profile policy UI

The Tool Policy screen keeps the host-wide sections but labels them as the fallback policy. Its Profile policies section provides one strict-policy editor per Pi-provider profile. The fallback and profile editors use the same nine focused Paseo host-tool categories and individual canonical-ID overrides:

- selected Pi tools, with searchable global discovery and stale selections called out;
- canonical Paseo tools, grouped for convenience but selected individually by real ID;
- advanced external-MCP glob patterns; and
- a clear warning that an enabled empty profile rule creates a chat-only, no-tool agent.

Profile editors are strict/default-deny. Their allowed canonical IDs are the complete Paseo host-tool
allow set for that profile; category toggles only batch-edit those IDs. The fallback remains
default-allow and uses disabled IDs instead. No `mcp_paseo_*` aliases are shown, and `wait_for_agent`
is not listed.

The screen states the reopen/refresh boundary and the non-sandbox limitation near the controls. The existing Settings screen and Command Center entry remain the discovery path.

## Diagnostics

At session open, policy diagnostics stay bounded: they identify whether fallback or profile resolution was used and report catalog-count changes where useful. They do not include credentials, arbitrary MCP schemas, prompt content, or unbounded tool lists.
