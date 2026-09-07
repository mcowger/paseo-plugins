# pi-plugin-mcowger

A [Paseo v0.8](https://paseo.sh/docs/plugins/v0.8/providers.md) provider plugin for the
[pi](https://github.com/earendil-works/pi) coding agent. It talks to `pi --mode rpc`
(JSONL-RPC over stdin/stdout) and replaces the in-server pi provider with something
iterable outside Paseo core.

Requires **pi ≥ 0.85.1** (probed via `pi --version`; set `PI_COMMAND` to override the binary)
and **Paseo ≥ 0.8.0**.

## Features

- **Full session lifecycle** — create, resume (pi session JSONL as the persistence handle),
  history replay, refresh, and conversation rewind (`session.revert.conversation`) via the
  injected `paseo-integration.mjs` extension.
- **Per-model thinking levels** — the catalog maps each pi model's `reasoning` +
  `thinkingLevelMap` into Paseo's per-model `thinkingOptions` (levels mapped to `null` are
  hidden; `xhigh`/`max` only when explicitly mapped). `--thinking` is omitted unless the user
  picks a level, so pi chooses its own model default; the effective (pi-clamped) level is
  re-read from `get_state` after every change. Same semantics as
  [paseo#4413](https://github.com/getpaseo/paseo/pull/4413).
- **Presets as a composer mode selector** — presets from `~/.pi/agent/presets.json` merged
  with `<cwd>/.pi/presets.json` (same semantics as pi's `preset.ts` example extension) are
  exposed as Paseo **modes** — the same selector opencode uses for its agents. Modes only
  appear when pi actually has the `preset` command installed (probed via `get_commands`).
  Selecting a mode forwards `/preset <name>` to pi and re-emits config (a preset can switch
  model + thinking level). On resume, the active preset is read back from pi's `preset-state`
  session entries via `get_entries`. The `/preset` slash command also remains available.
- **Native todos** — `@juicesharp/rpiv-todo` `todo` tool snapshots (`details.tasks`) and the
  pi example shape (`details.todos`) are emitted as native `type: "todo"` timeline items
  (stable id, full-snapshot updates), live and during replay.
- **Native subagent rendering** — `task`/`subagent` delegate calls map to
  `tool_call { detail: { type: "sub_agent", … } }` with the streamed log. Foreground runs only;
  detached background runners are out of scope.
- **Turn parity** — streaming text/reasoning snapshots, steer (`prompt.steer`) with
  interrupt-and-replace for slash commands, interrupt via `clear_queue` + `abort`, pi
  extension-UI questions routed to Paseo permission requests, MCP server injection via a
  merged temp `mcp.json` (when the pi MCP adapter is detected), usage polling
  (`get_session_stats`), image attachments with a text-only fallback, compaction and
  notification timeline items.

## Layout

```
index.server.ts          provider registration
server/
  provider.ts            ProviderRegistration + connection dispatch, catalog probe,
                         version floor, session open/close
  session.ts             per-session turn machine → ProviderEvents
  runtime.ts             pi process launcher + RPC session wrapper, version probe
  jsonl-rpc.ts           JSONL frame decoder (incl. v2 chunks) + process bridge
  thinking.ts            per-model thinking level mapping/clamping
  tool-call-mapper.ts    pi tool events → ProviderToolCallDetail (+ sub_agent)
  todo.ts                rpiv-todo snapshots → native todo items
  presets.ts             presets.json loading/merging → ProviderMode[], preset-state parsing
  history-mapper.ts      replay of persisted pi history → timeline items
  usage-poller.ts        token/cost polling
  mcp-config.ts          merged MCP config temp file
  extension.ts           paseo-integration.mjs generator (system prompt, entry capture,
                         paseo_tree rewind bridge)
shared/
  rpc-types.ts           pi RPC protocol types
  todo-schemas.ts        Zod schemas for todo snapshot shapes
smoke/                   real-pi smoke tests (spawns the actual binary)
```

## Development

```bash
# from the repo root: build + link the local 0.8 SDK from ~/workspace/paseo
npm run sdk:install:local

cd pi-plugin-mcowger
npm run typecheck
npm test                                        # unit tests
npx vitest run --config vitest.smoke.config.ts  # real-pi smoke (needs pi auth)

paseo plugin reload pi-plugin-mcowger
paseo plugin logs pi-plugin-mcowger
```

`PI_SMOKE_MODEL` overrides the model used by the smoke prompt (default
`plexus/gemini-3.5-flash-lite`).

## Manual verification checklist

- [ ] Catalog shows pi models with per-model thinking levels
- [ ] Create session, send a prompt, watch streaming text/reasoning
- [ ] Steer an active turn; interrupt a turn
- [ ] `/preset <name>` switches model when the preset extension is installed; absent otherwise
- [ ] rpiv-todo `todo` calls render as native todo items
- [ ] `task`/`subagent` calls render as native subagent items
- [ ] Close Paseo, reopen: session resumes with history replay
- [ ] Rewind a user message
- [ ] Reload/remove the plugin mid-session: session terminates
