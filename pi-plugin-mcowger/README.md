# Pi provider (mcowger)

`pi-plugin-mcowger` is a Paseo provider for the
[pi coding agent](https://github.com/earendil-works/pi). It targets Paseo
`v0.8.0` and embeds pi through `@earendil-works/pi-coding-agent` instead of
running the `pi` CLI in RPC mode.

## Status

The plugin is ready for use with Paseo `v0.8.0`. Paseo's provider API is stable for this release.

## Preview

![Pi provider preview](./images/pi-provider.svg)

## What it does

- Loads pi models, auth, settings, extensions, skills, and prompt templates from `~/.pi/agent`.
- Exposes pi models with per-model thinking levels in Paseo's composer.
- Provides a host-scoped Tool Policy screen and Command Center entry for narrowing Pi tools and
  independently filtering Paseo host tools. Manage it in Settings → Plugins → Pi Tool Policy.
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
