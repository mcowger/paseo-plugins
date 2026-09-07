# pi-plugin-mcowger — Implementation Plan

A Paseo v0.8 provider plugin for the [pi](https://github.com/earendil-works/pi) coding agent,
replacing the unmaintained in-server provider at
`paseo/packages/server/src/server/agent/providers/pi/`.

## Locked decisions

| Topic | Decision |
|---|---|
| Reuse of paseo internals | None — port everything into plugin `server/` |
| SDK | Pin `@getpaseo/plugin` `0.8.0` via repo `sdk:install:local` flow (unreleased) |
| pi floor | **pi ≥ 0.85.1**, probed via `pi --version` at provider start; catalog fails with a clear upgrade error below floor; all COMPAT fallback code from the old provider is dropped |
| Binary resolution | `process.env.PI_COMMAND ?? "pi"` on PATH |
| Presets | **Exposed as Paseo modes** (composer selector, like opencode modes): read `~/.pi/agent/presets.json` + `<cwd>/.pi/presets.json` ourselves (project wins, same merge as preset.ts), emit as `ProviderMode[]` in catalog + `session.config`. Only when `get_commands` shows `preset` installed — otherwise silently omit. Selecting a mode forwards `/preset <name>`; active preset re-synced from `preset-state` entries via `get_entries` |
| Subagents | **Foreground only**: map `subagent` tool stream → native `tool_call { detail: { type: "sub_agent", … } }` with accumulated `log`/`actions`; no detached-runner child sessions in v1 |
| Provider id | `pi-plugin-mcowger` (avoids collision with core `pi` provider) |
| Catalog | No caching — fresh probe process per catalog request (no `getCatalogCacheKey`) |
| Restoration v1 | Resume + history replay **+ rewind** (`session.revert.conversation` via ported `paseo_tree` extension command). No session-import picker |
| Parity v1 | Steer + interrupt (incl. interrupt-and-replace for slash commands), permission UI routing, MCP config temp file, usage polling, internal/temp agents (`--no-session`), system-prompt injection, image attachments w/ text-only fallback |
| Composer settings v1 | None — catalog model/thinking pickers only; structure `session.config` emission so toggle/select settings drop in later |
| Sibling plugins | `pi-tasks-timeline` / `subagent-activity` stay untouched and unrelated — inspiration only, no guards or cross-requirements |
| Testing | Vitest units (thinking, todo, mapper, presets, history) + scripted real-pi 0.85.1 smoke |
| Location | `pi-plugin-mcowger/` at repo root, added to `.paseo-sdk.json` |
| Icon | TBD — user has a pixel-art PNG (`pi-mcowger.png`); needs vectorization to self-contained SVG ≤ 64 KiB (no external/data hrefs). Defer to later |

## Architecture

```
pi-plugin-mcowger/
  paseo-plugin.json            { "id": "pi-plugin-mcowger", "requirements": { "paseo": ">=0.8.0" } }
  index.server.ts              server.registerProvider(createPiProvider()); cleanup
  icon.svg                     (TBD)
  server/
    provider.ts                ProviderRegistration + connection: send()/onEvent()/close(),
                               catalog/session/turn wiring to ProviderEvents
    jsonl-rpc.ts               JSONL-RPC process bridge (port of in-server JsonlRpcProcess)
    cli-runtime.ts             buildPiLaunch(): --mode rpc, --model, --thinking (optional),
                               --session / --no-session, --mcp-config, --extension
    session.ts                 per-session state: turns, steering, interrupts, permissions,
                               usage polling, compaction, notifications
    tool-call-mapper.ts        pi tool events → ProviderToolCallDetail; + todo/subagent cases
    history-mapper.ts          captured entries → ProviderTimelineItem snapshots (replay)
    usage-poller.ts            get_session_stats → usage_updated
    thinking.ts                per-model thinking: thinkingLevelMap → ProviderModel.thinkingOptions,
                               default resolution (upward-then-downward clamp), effective-level sync
    presets.ts                 get_commands probe → session.commands → forward + config refresh
    subagents.ts               pi-subagents foreground stream → sub_agent detail (log/actions)
    todo.ts                    rpiv-todo result snapshots → native type:"todo" items
    session-descriptor.ts      (only if import picker is added later — NOT v1)
    extensions/
      paseo-integration.mjs    system-prompt injection (before_agent_start), entry capture,
                               paseo_tree (rewind), ported from old provider
  shared/
    rpc-types.ts               pi RPC types (port, extended: thinkingLevelMap, preset/todo/subagent)
    todo-schemas.ts            Zod schemas for rpiv-todo snapshot shapes (from pi-tasks-timeline)
  *.test.ts, vitest.config.ts, tsconfig.json (no DOM lib), package.json
```

## Feature details

### 1. Per-model thinking levels (PR getpaseo/paseo#4413 semantics)

- pi RPC `get_available_models` returns `Model<any>[]` including `reasoning: boolean` and
  `thinkingLevelMap: { off|minimal|low|medium|high|xhigh|max: string | null }`.
- Map to `ProviderModel.thinkingOptions` / `defaultThinkingOptionId`:
  - levels mapped to `null` are excluded;
  - `xhigh`/`max` only surfaced when explicitly mapped;
  - `reasoning: false` → `thinkingOptions`/`defaultThinkingOptionId` = `undefined`;
  - default resolved with pi's upward-then-downward clamp order
    (`off < minimal < low < medium < high < xhigh < max`), `isDefault: true` on the result.
- `session.open`: omit `--thinking` unless the user explicitly selected a level — pi picks its
  model-specific default.
- After open and after every `setModel`/`setThinkingLevel`: call `getState` and emit
  `session.config` with pi's *effective* clamped level (pi clamps unsupported requests).
- pi also exposes `get_available_thinking_levels` (current model's supported levels) as a
  secondary source if needed.

### 2. Presets (probed, not forked)

- After session open: `get_commands` → `RpcSlashCommand[] { name, description, source }`.
- If `preset` present: emit `session.commands [{ name: "preset", argumentHint: "<name>" }]`.
- Activation arrives as `session.prompt { input: { type: "command", name: "preset", arguments } }`
  → forward as pi slash command → `getState` → re-emit `session.config` (a preset can switch
  model, which changes per-model thinking options).
- No-arg `/preset` opens a TUI picker and cannot work over RPC; only named activation is exposed.
- Extension absent → no preset UI anywhere, no error.

### 3. rpiv-todo → native todo timeline items

- In the tool mapper, detect `todo` tool results (`tool_execution_end`).
- Zod-validate the rpiv snapshot shape:
  `tasks: [{ id?, subject, activeForm?, status: pending|in_progress|completed|deleted, blockedBy?[] }]`
  (plus the pi-example variant `todos: [{ id?, text, done }]` — schemas adapted from
  `pi-tasks-timeline/shared/pi-tasks.ts`).
- Emit one stable-id snapshot: `timeline.item { type: "todo", id: "pi-todos", items: [...] }`,
  mapping `subject → text`, statuses 1:1 (deleted → dropped), `activeForm` passthrough,
  `completed` derived. Reused id = Paseo replaces the row in place.

### 4. pi-subagents → native subagent rendering (foreground only)

- Map `subagent` tool calls to
  `tool_call { detail: { type: "sub_agent", subAgentType, description, log, actions } }`.
- Foreground runs stream child activity into the parent session; accumulate child tool-call
  summaries into `actions[]` across `tool_execution_update` events.
- `childSessionId` left unset in v1 (background runners are detached processes we don't own).

### 5. Baseline parity (ported from old provider, COMPAT code deleted)

- paseo-integration extension: system-prompt injection, entry capture, `paseo_tree` (rewind).
- MCP config temp file when session config carries MCP servers.
- Steer via `steer` RPC; slash commands fall back to interrupt-and-replace.
- Interrupt via `clear_queue` + `abort`.
- Permission UI routing: pi `extension_ui_request` → Paseo permission requests.
- Compaction timeline items; extension notifications → `notification` items.
- Usage polling via `get_session_stats`.
- Internal/temp agents: `--no-session` for non-interactive opens.
- Image attachments with text-only fallback hint for text-only models.
- Persistence: pi session JSONL path as the opaque handle; resume with `--session <path>`;
  `history: "replay"` streams captured entries before `session.ready`.
- Rewind: advertise `session.revert.conversation`, implement via `paseo_tree`.

## pi RPC surface used (verified in pi 0.85.1 `dist/modes/rpc/rpc-types.d.ts`)

Commands: `prompt`, `steer`, `abort`, `clear_queue`, `get_state`, `get_available_models`,
`get_available_thinking_levels`, `get_commands`, `set_model`, `set_thinking_level`,
`set_auto_compaction`, `set_steering_mode`, `set_follow_up_mode`, `get_session_stats`,
`get_messages`, `compact`, `new_session`, `switch_session`, `get_tree`, `get_entries`,
`get_fork_messages`, `fork`, `set_session_name`.

## Implementation order

1. **Scaffold** — manifest, tsconfig (no DOM), package.json, vitest, `.paseo-sdk.json` entry, placeholder icon.svg.
2. **Runtime core** — `jsonl-rpc.ts`, `cli-runtime.ts`, version probe, paseo-integration extension.
3. **Session lifecycle** — open/config/ready/turn/prompt/steer/interrupt/permission/usage; tool mapper incl. native todo emission.
4. **Catalog** — probe process → `get_available_models` → per-model thinking options.
5. **Presets** — `get_commands` probe → `session.commands` → forward + config refresh.
6. **Subagents** — `subagent` stream → `sub_agent` detail.
7. **Persistence/replay/rewind** — session handle, `history:"replay"`, `session.revert.conversation`.
8. **Tests + real-pi smoke** per provider guide checklist: prompt, steer, interrupt, permissions,
   resume, replay, reload/remove during active session.

## Residual risks (accepted)

- `sub_agent` log/actions mapping from pi-subagents' event stream is inferred — fixture-verify
  during smoke testing and iterate.
- Foreground-only subagents: background fleet runs render as plain tool calls.
- No catalog caching = ~1s probe latency each time the agent form opens.
- Icon still needed: vectorize the pixel-art PNG to a self-contained SVG ≤ 64 KiB.

## Dev loop

```bash
npm run sdk:install:local          # build/link unpublished 0.8 SDK from ~/workspace/paseo
cd pi-plugin-mcowger && npm install && npx tsc --noEmit
paseo plugin reload pi-plugin-mcowger
paseo plugin logs pi-plugin-mcowger
```
