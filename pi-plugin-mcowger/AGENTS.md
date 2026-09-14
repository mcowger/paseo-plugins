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
