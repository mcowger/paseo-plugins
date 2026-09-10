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
| Presets | **Paseo-owned**: host-scoped settings edited in a plugin Settings screen, synchronized to the provider through a revisioned RPC, and exposed as Paseo modes; apply via `setModel`/`setThinkingLevel`/tool glob resolution + appended system prompt; state via `appendCustomEntry("preset-state")`. Manual model/thinking changes keep the mode selected but mark it modified. `/preset` command is also supported natively |
| User extensions | Load normally via `DefaultResourceLoader` (plexus provider, rpiv-todo, pi-subagents, etc.) — verified they register into the shared ModelRuntime after a one-time warmup session |
| MCP | Paseo-injected MCP servers are connected **in-process** via `@modelcontextprotocol/sdk` and exposed as pi custom tools `mcp_<server>_<tool>`; no mcp.json temp files, no pi-mcp-adapter dependency |
| Todos | rpiv-todo `details.tasks` (+ pi-example `details.todos`) → native `type:"todo"` timeline items, live + replay |
| Subagents | Foreground `task`/`subagent` calls → native `sub_agent` tool detail |
| Permissions | Headless `ExtensionUIContext` (bound via `session.bindExtensions`, mode `"rpc"`): select/confirm/input/editor → Paseo permission questions; notify → notification items; `custom()` rejects (no TUI) |
| Rewind | Not advertised. Pi tree navigation and active-leaf persistence remain implemented, but Paseo's plugin adapter cannot replace its session-local history after rewind. |
| Persistence | `SessionManager.open(sessionFile)` resume; `history:"replay"` streams mapped message history before `session.ready` |
| Catalog | `ModelRuntime.create()` (cached catalogs, no network by default) + extension warmup; per-model `thinkingOptions` from `reasoning` + `thinkingLevelMap` (PR #4413 semantics) |
| Commands published | `compact`, `preset`, Pi extension commands, plus prompt templates discovered by the loader |
| Testing | 53 unit tests (fake SDK session) + in-process smoke suite (catalog, live prompt with streaming, persistence/resume) |

## Known limitations

- `ask_user`'s combined select+comment flow is simplified to sequential dialogs.
- Foreground-only subagent rendering; detached pi-subagents background runs are out of scope.
- Project-local extensions that register providers (rare) only appear after that cwd's
  session loads them.
- Preset settings synchronize to the provider when the Pi Presets settings screen saves or reloads
  the document.
- Conversation rewind is disabled until Paseo exposes a way for plugin providers to replace
  adapter history after a rewind.
- Fork visibility is host-gated by Paseo's global `agentForkContext` feature; the provider plugin
  has no provider-level fork capability to advertise or withdraw.
