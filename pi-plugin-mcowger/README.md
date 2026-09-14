# Pi provider (mcowger)

`pi-plugin-mcowger` is a Paseo provider for the
[pi coding agent](https://github.com/earendil-works/pi). It targets Paseo
`v0.8.0` and embeds pi through `@earendil-works/pi-coding-agent` instead of
running the `pi` CLI in RPC mode.

## Status

Version `0.1.1` is ready for use with Paseo `v0.8.0`. Paseo's provider API is stable for this release.

## Preview

![Pi provider preview](./images/pi-provider.svg)

## What it does

- Loads pi models, auth, settings, extensions, skills, and prompt templates from `~/.pi/agent`.
- Exposes pi models with per-model thinking levels in Paseo's composer.
- Provides a host-scoped Tool Policy screen and Command Center entry for narrowing Pi tools and
  independently filtering Paseo host tools. Manage it in Settings → Plugins → Pi Tool Policy.
- Provides strict profile-specific tool policies for saved Pi-provider profiles. A configured profile
  replaces, rather than layers on, the host policy fallback.
- Shows the exact active Pi profile in the composer when Paseo provides its profile identity, and
  explains when the host did not provide one in the pill popover.
- Provides a branch-aware `todo` tool when no loaded Pi extension already contributes one, and emits
  its results (along with `@juicesharp/rpiv-todo` results) as native Paseo todo items.
- Maps foreground pi subagent calls to native Paseo subagent tool rows.
- Bridges pi extension dialogs to Paseo permission questions.
- Bridges Paseo-provided MCP servers to pi custom tools in-process.
- Publishes Pi extension slash commands alongside built-in commands and prompt templates.
- Exposes native composer selectors for compact and retry.
- Emits startup diagnostics for failed resources, MCP connections, model fallbacks, and unsupported
  session configuration instead of hiding those problems in daemon logs.
- Persists sessions with pi's `SessionManager` and supports replay from the active branch, conversation
  rewind, steering, interruption, compaction, and usage reporting.

## Conversation rewind

Conversation rewind is supported through Paseo's standard provider rewind API. Pi rewinds to the
selected user message with `SessionManager` tree navigation, then persists the new active leaf and
replays the active branch on resume.

This only rewinds conversation history. File-only and combined conversation/file rewind are not
advertised because Pi does not provide an atomic workspace-file rewind operation.

## Runtime settings and diagnostics

Active Pi agents expose native composer selectors for `Compact` and `Retry`. Each selector shows
its current state and opens a small popup with explicit on/off choices.

The embedded SDK cannot safely apply per-session environment overrides or provider-native options
without mutating shared process state. It also does not expose MCP approval enforcement. The plugin
leaves those values unchanged and emits a visible startup diagnostic when `env`, `providerOptions`,
or `toolPolicy` is supplied.

Startup diagnostics also cover failed Pi extensions, skills, prompts, themes, MCP tool discovery,
unavailable requested models, and model fallbacks.

## Installation

Install from a checkout of this repository:

```bash
cd /absolute/path/to/pi-plugin-mcowger
npm install
npm run typecheck
paseo plugin install "$PWD"
paseo plugin reload pi-plugin-mcowger
```

`npm install` patches broken declaration probes in third-party dependencies and builds the vendored
pi/MCP SDK bundle required by Paseo's plugin compiler. See
[`docs/packaging.md`](./docs/packaging.md) for the details.

## Pi configuration

The plugin uses pi's normal configuration directory, including:

- `~/.pi/agent/settings.json`
- `~/.pi/agent/auth.json`
- `~/.pi/agent/extensions/`
- `~/.pi/agent/packages`

Tool Policy is managed by Paseo in the plugin's host-scoped settings document. It applies to new
or refreshed sessions and does not sandbox shell commands or extensions. Project-local `.pi` settings
and resources are loaded for the active workspace.

The fallback and profile editors share nine focused Paseo host-tool categories: Agent orchestration,
Workspaces and worktrees, Terminals and workspace scripts, Schedules and heartbeats, Browser
automation, Voice, Providers and profiles, Permissions, and Agent sessions. Each category is a UI
convenience; individual canonical tool IDs are the runtime controls. The UI shows canonical IDs once,
never `mcp_paseo_*` bridge aliases, and `wait_for_agent` is not listed.

## Profile-specific tool policies

The host policy remains the fallback. When a saved Paseo profile has a configured Pi tool policy,
that strict policy fully replaces the fallback for sessions using that profile. An empty profile
policy is intentional and allows no tools.

The profile editor selects:

- exact Pi built-in and extension tool names;
- canonical Paseo tool IDs, grouped into the same nine categories as the fallback editor, with
  individual overrides (for example `create_agent`, never `mcp_paseo_create_agent`); and
- advanced globs for external, non-Paseo MCP tools.

Fallback host-tool access remains default-allow: disabling a canonical ID removes it, while the
category controls only batch-edit those disabled IDs. Configured profiles remain strict/default-deny:
their allowed canonical IDs are the complete Paseo host-tool set for that profile. Categories are UI
conveniences; exact IDs determine runtime behavior.

All Pi-provider profiles receive a plugin-owned profile marker automatically. Paseo currently
passes materialized profile values to provider sessions, not the profile identity. Paseo can also
drop an unrecognized marker from draft feature state, so the plugin stores each configured
profile's model, mode, and thinking configuration and uses it only when it uniquely identifies one
policy. Ambiguous or mismatched launches use the fallback. This is not a security boundary: a
caller that can construct provider settings can spoof the marker, and a model with `bash` can still
use local commands.

Profile and known-tool discovery run through narrow config RPCs before a provider session opens.
Known Pi tools come from the global Pi environment, so project-local extensions may be absent. Saved
selections missing from discovery stay as stale selections instead of being removed. Settings sync
prunes policies for deleted profiles or profiles that no longer use this provider.

Policy is captured when a session opens. Changes take effect after an agent is opened, refreshed, or
reopened. `/reload` reloads Pi resources; it does not change an open session's MCP bridge or tool
catalog. See [`docs/tool-policy.md`](./docs/tool-policy.md) for the behavior and limits.

## Development

```bash
npm run build:vendor
npm run lint
npm run typecheck
npm test
npx vitest run --config vitest.smoke.config.ts
```

Set `PI_SMOKE_MODEL` to override the smoke-test model. The default is
`plexus/gemini-3.5-flash-lite`.
