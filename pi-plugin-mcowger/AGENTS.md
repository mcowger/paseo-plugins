# pi-plugin-mcowger guidance

This plugin is a Paseo coding agent provider (direct, in-process). General plugin
guidance lives in the repository root [`AGENTS.md`](../AGENTS.md); this file covers
the provider-specific material that applies here.

When researching Paseo contracts (provider SDK types, protocol, examples), use the local
Paseo checkout at `~/workspace/paseo` (`packages/plugin`, `packages/protocol`,
`plugin-examples`) instead of web calls to GitHub.

## Provider resources

- [Provider plugin guide](https://paseo.sh/docs/plugins/v0.8/providers.md): direct and ACP coding agent
  providers, session lifecycle, composer settings, and provider timeline renderers.
- [Official provider examples](https://github.com/getpaseo/paseo/tree/v0.8.0/plugin-examples):
  direct providers (`provider-direct`) and ACP adapter providers (`provider-acp-transformer`).
- [Community reference index](../examples/README.md): section 5 ("Agent providers and ACP adapters")
  reviews public provider plugins with direct GitHub and paseo.cafe links.

## Provider registration

- This plugin's contribution scope is a coding agent provider (`server.registerProvider(provider)`).
- Import from host-provided module paths:
  - `@getpaseo/plugin/server/provider`: provider registration and event contracts
    (`ProviderRegistration`, `negotiateProviderCapabilities`).
  - `@getpaseo/plugin/server/acp`: command-backed ACP adapter (`runAcpProvider`) and
    `AcpTransformer` hooks.
- Register providers in `index.server.ts` via `server.registerProvider(createProvider())` implementing
  `ProviderRegistration` from `@getpaseo/plugin/server/provider`, or adapt an ACP agent using `runAcpProvider`
  from `@getpaseo/plugin/server/acp`.

## Diff-on-touch (NG anti-drift discipline)

Before editing any ported file, diff it against its upstream counterpart under
`~/workspace/paseo/packages/server/src/server/agent/providers/pi/` and port
what's missing. Record deliberate divergences below so future diffs don't
"fix" them. See `docs/NG.md` for the daily-session parity plan.

Counterpart inventory (plugin file → upstream file):

- `server/tool-call-mapper.ts` → upstream `tool-call-mapper.ts` (+ its tests)
- `server/session.ts` (history/replay sections) → upstream `history-mapper.ts`
- `server/session.ts` (usage polling) → upstream `usage-poller.ts`
- `server/rewind.ts` → upstream `rewind.ts` (+ opaque `pi-revert:` token layer; never expose raw Pi entry ids)
- `server/session.ts` (rewind/revert sections) → upstream `agent.ts` extension markers (`createPiPaseoExtensionFile`, capture/submitted/command-result handling, entry-capture + tree commands)
- `server/runtime.ts` → upstream `runtime.ts` + `cli-runtime.ts`
- `server/rpc-types.ts` → upstream `rpc-types.ts`
- `server/session.ts` (turn lifecycle, autocompact, prompt input) → upstream `agent.ts` sections
- `server/turn-terminal.ts` → upstream `agent.ts` turn-boundary sections (prompt/terminal correlation ~1244/1344, `prompt_result` buffering ~2141, `agent_end`/`agent_settled` ~2190/2288, interruption ~1252/1540) + paseo-omp `session-terminal.ts` pattern
- Deferred: `session-descriptor.ts` (sessions list + import) — touch only if needed per NG deferred backlog

Deliberate divergences (do not "fix" on diff):

- `server/mcp-config.ts`: always-write, no adapter probe — intentional (NG settled decision).
- Paseo SDK pinned to exactly 0.9.1 for provider subagent child sessions (`package.json` + `paseo-plugin.json` `>=0.9.1`); do not downgrade.
- Pi binary floor: minimum >=0.84.4 (covers `clear_queue`, added in pi 0.84.4;
  subsumes cumulative-update floor >=0.84 and `agent_settled` v0.5.0). Latest-tested: 0.86.1.
  Update this line when a newer pi binary is verified.
- Image budgets (NG item 2): 2 MiB per image, 8 MiB aggregate per-turn budget (pi-scale; not OMP's 16MB).
- Terminal `requestId` (NG item 7): upstream `agent_end`/`agent_settled` carry no `requestId` yet; the plugin's `server/rpc-types.ts` adds it as an optional forward-compatible field. Do not remove on diff.

## Coding agent providers (Paseo v0.8)

- Provider SVG icons (`ProviderRegistration.icon`) must be a relative file path to a local SVG file
  (<= 64 KiB), sanitized and self-contained (no scripts, styles, foreignObject, event handlers, or external hrefs).
- Publish provider catalogs (`models`, `modes`, `thinkingOptions`) to populate the agent form before session
  creation. Hub execution credentials also have provider catalog snapshot access (`provider.snapshot`) so
  remote workflow editors can present models and modes without broader daemon read authority.
- Manage session lifecycles: handle `session.open` with complete launch configs; emit `session.opened`,
  `session.config` (with toggle/select composer `settings` and opaque `providerOptions`), `session.ready`,
  and `session.turn`; process user messages and commands via `session.prompt` (supporting `delivery: "steer"`
  when `prompt.steer` is advertised).
- Support persistence and replay (`session.persistence`, `history: "replay" | "skip"`). Refresh closes and
  reopens the provider session (`session.open` re-reads env, credentials, and MCP servers; there is no reload RPC).
