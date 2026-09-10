# Pi provider (mcowger)

`pi-plugin-mcowger` is a Paseo provider for the
[pi coding agent](https://github.com/earendil-works/pi). It targets Paseo
`v0.8.0` and embeds pi through `@earendil-works/pi-coding-agent` instead of
running the `pi` CLI in RPC mode.

## Status

The plugin targets Paseo `v0.8.0`. Paseo's provider API is stable for this release.

## Preview

![Pi provider preview](./images/pi-provider.svg)

## What it does

- Loads pi models, auth, settings, extensions, skills, and prompt templates from `~/.pi/agent`.
- Exposes pi models with per-model thinking levels in Paseo's composer.
- Stores Pi presets in Paseo host settings and exposes them as composer modes. Manage presets in
  Settings → Plugins → Pi Presets. Selecting one applies its model, thinking level, tool patterns,
  and appended system prompt.
- Provides a branch-aware `todo` tool when no loaded Pi extension already contributes one, and emits
  its results (along with `@juicesharp/rpiv-todo` results) as native Paseo todo items.
- Maps foreground pi subagent calls to native Paseo subagent tool rows.
- Bridges pi extension dialogs to Paseo permission questions.
- Bridges Paseo-provided MCP servers to pi custom tools in-process.
- Publishes Pi extension slash commands alongside built-in commands and prompt templates.
- Persists sessions with pi's `SessionManager` and supports replay from the active branch, steering,
  interruption, compaction, and usage reporting.

## Preset behavior

Preset modes apply their model and thinking level when selected on an existing live session. In a
new-agent draft composer, Paseo `v0.8.0` provider modes cannot declare model or thinking defaults,
so selecting a preset updates the mode pill but leaves the draft's model and thinking pills unchanged.
The preset is still applied when the session is created. Updating the draft pills immediately will
require a future Paseo host/API change. When no presets are configured, the provider publishes no
modes and Paseo hides the mode pill.

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

Presets are managed by Paseo in the plugin's host-scoped settings document. The plugin no longer
reads pi `presets.json` files. Project-local `.pi` settings and resources are loaded for the active
workspace.

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
