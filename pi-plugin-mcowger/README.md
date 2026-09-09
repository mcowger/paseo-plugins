# pi-plugin-mcowger

A [Paseo v0.8](https://paseo.sh/docs/plugins/v0.8/providers.md) provider plugin for the
[pi](https://github.com/earendil-works/pi) coding agent. It embeds pi through its
**in-process Node SDK** (`createAgentSession` from `@earendil-works/pi-coding-agent`,
bundled into the plugin) rather than shelling out to the `pi --mode rpc` binary.

Targets **Paseo ≥ 0.8.0-beta.1**; bundles **pi SDK 0.85.1** (the user's global pi binary
is not used; `~/.pi/agent` config, auth, models, extensions, and skills are shared).

## Features

- **Full session lifecycle** — create, resume (`SessionManager.open` on the saved session
  file as the persistence handle), history replay, refresh, and conversation rewind via
  `session.navigateTree()`.
- **Per-model thinking levels** — catalog maps each model's `reasoning` + `thinkingLevelMap`
  into Paseo's per-model `thinkingOptions`; requested levels are applied via
  `setThinkingLevel` and pi's effective clamped level is reported back.
- **Presets as a composer mode selector** — `~/.pi/agent/presets.json` merged with
  `<cwd>/.pi/presets.json` exposed as Paseo **modes**. Selecting a mode applies natively:
  `setModel` + `setThinkingLevel` + `setActiveToolsByName` + system-prompt instructions,
  and writes a `preset-state` custom entry (read back on resume). The `/preset` composer
  command also works. No preset extension required.
- **Native todos** — `@juicesharp/rpiv-todo` / pi-example `todo` tool snapshots → native
  `type: "todo"` timeline items, live and during replay.
- **Native subagent rendering** — `task`/`subagent` delegate calls →
  `tool_call { detail: { type: "sub_agent", … } }` (foreground).
- **Paseo MCP servers without mcp.json** — Paseo-injected MCP servers are connected
  in-process (`@modelcontextprotocol/sdk`) and exposed to pi as custom tools
  (`mcp_<server>_<tool>`), one client set per session.
- **Turn parity** — streaming text/reasoning snapshots, steer (`prompt.steer`),
  interrupt via `session.abort()`, pi extension dialogs (`ctx.ui.select/confirm/input`)
  bridged to Paseo permission questions, extension `notify` → notification timeline
  items, compaction items, image attachments with a text-only fallback hint, command
  interception for `/compact` and `/preset`, usage/cost emission from `getSessionStats()`.

## Architecture

```
index.server.ts            provider registration
server/
  provider.ts              connection dispatch, catalog, session.open wiring
  session.ts               PiProviderSession: AgentSession events → ProviderEvents,
                           turn machine, steering, dialogs, todos, presets, rewind
  pi-host.ts               shared ModelRuntime (with extension warmup so custom
                           providers like plexus register), catalog mapping
  pi-ui-context.ts         headless ExtensionUIContext (dialogs → permissions)
  mcp-bridge.ts            MCP servers → pi custom tools
  presets.ts               presets.json loading/merging, ProviderMode mapping,
                           preset-state parsing
  thinking.ts              per-model thinking level mapping/clamping
  tool-call-mapper.ts      pi tool events → ProviderToolCallDetail (+ sub_agent)
  todo.ts                  todo snapshots → native todo items
  history-mapper.ts        message history → timeline items (replay)
shared/
  rpc-types.ts             pi event/message types (SDK shapes)
  todo-schemas.ts          Zod schemas for todo snapshot shapes
smoke/                     in-process SDK smoke tests (no pi binary needed)
```

Key SDK mechanics used: `createAgentSession`, `DefaultResourceLoader` (user extensions
load as normal — plexus provider, rpiv-todo, pi-subagents), `session.bindExtensions({
uiContext })`, `entry_appended` events for user-message/revert-token tracking,
`SessionManager.appendCustomEntry`/`getEntries` for preset state, `getSessionStats()`
for usage, `setActiveToolsByName` for preset tool sets.

## Development

```bash
npm run sdk:install:local        # from repo root: link local 0.8.0-beta.1 SDK
cd pi-plugin-mcowger
npm install                      # patches vendor type declarations + builds the CJS vendor bundle
npm run typecheck
npm test                                        # unit tests (faked SDK session)
npx vitest run --config vitest.smoke.config.ts  # in-process SDK smoke (real auth)

paseo plugin reload pi-plugin-mcowger
paseo plugin logs pi-plugin-mcowger
```

`PI_SMOKE_MODEL` overrides the smoke-test model (default `plexus/gemini-3.5-flash-lite`).

### The vendor bundle

See [docs/packaging.md](./docs/packaging.md) for the full story (boundary-checker type
walks, broken vendor declaration probes, eval'd CJS without import.meta, and the eager
interop rewrite). Short version: `scripts/build-vendor.mjs` pre-bundles pi + the MCP SDK
as ESM with `import.meta.url` textually stripped, typed by the hand-written
`server/vendor/pi-sdk.d.mts`; `scripts/postinstall.mjs` patches unresolvable type probes
in dependency declarations. Both run on `npm install`; `npm run build:vendor` rebuilds
after dependency updates.

## Manual verification checklist

- [ ] Catalog shows pi models (incl. extension providers) with per-model thinking levels
- [ ] Create session, prompt, watch streaming text/reasoning
- [ ] Steer an active turn; interrupt a turn; `/compact`
- [ ] Plan preset flips model + thinking in the composer pickers
- [ ] rpiv-todo `todo` calls render as native todo items
- [ ] `task`/`subagent` calls render as native subagent items
- [ ] Close Paseo, reopen: session resumes with history replay
- [ ] Rewind a user message
- [ ] Reload/remove the plugin mid-session: session terminates cleanly
