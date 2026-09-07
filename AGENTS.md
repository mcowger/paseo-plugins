# Paseo plugin guidance

This repository contains Paseo plugins. Use the following Paseo resources as the source of truth
when creating or changing a plugin:

The current target host and SDK baseline is **Paseo v0.8**. Pin `@getpaseo/client`,
`@getpaseo/plugin`, and `@getpaseo/protocol` to 0.8.0. Declare compatibility in `paseo-plugin.json`
via `requirements: { "paseo": ">=0.8.0" }` to enforce version checks at startup.

- [Plugin guide](https://paseo.sh/docs/plugins.md): setup, installation, development workflow,
  lifecycle, and debugging.
- [Plugin API reference](https://paseo.sh/docs/plugins/v0.8/reference.md): contribution surfaces,
  components, SDK usage, RPC, themes, hosts, and troubleshooting.
- [Runtime entry migration guide](https://paseo.sh/docs/plugins/v0.8/migration.md): migrating from
  mixed root entries to explicit client and server runtime entries.
- [Provider plugin guide](https://paseo.sh/docs/plugins/v0.8/providers.md): direct and ACP coding agent
  providers, session lifecycle, composer settings, and provider timeline renderers.
- [Official plugin examples](https://github.com/getpaseo/paseo/tree/main/plugin-examples):
  working examples for panels and commands (`local-plugin`), RPC, attachment sources (`linear`),
  themes (`catppuccin`), timeline items (`timeline-items`, `inline-thinking`), direct providers
  (`provider-direct`), and ACP adapter providers (`provider-acp-transformer`).
- [Community reference index](examples/README.md): reviewed public plugins grouped by the techniques
  they demonstrate and their known API caveats.

## Development reminders

- The plugin API is experimental and may include breaking changes.
- Plugins are trusted, unsandboxed code. Keep daemon-only work and credentials in server modules;
  client modules run inside Paseo.
- Paseo v0.8 splits runtime entries into explicit `index.client.tsx` and `index.server.ts`. A mixed
  root `index.ts` is obsolete and rejected by the compiler. If a plugin has no server entry, no daemon
  subprocess is started.
- Enforce strict directory boundaries:
  - `client/`: compiled only into the app bundle (React, React Native, hooks, styles, surfaces, panels, callbacks).
  - `server/`: compiled only into the daemon bundle (Node APIs, filesystem/process access, credentials, RPC handlers, providers).
  - `shared/`: compiled into both runtimes (Zod RPC contracts, plain data schemas, and shared types; no Node or React Native runtime code).
  - Do not keep any other code modules in the plugin root.
- The compiler strictly rejects boundary crossings: client importing `server/`, server importing `client/`,
  and any `node:*` imports reachable from client code.
- Entry points:
  - `index.client.tsx` default-exports `contribute(client: PluginClientContext)`. Every client `add*` method
    returns an idempotent removal function.
  - `index.server.ts` default-exports `contribute(server: PluginServerContext)`. Server cleanup may be async.
- Import from host-provided module paths:
  - `@getpaseo/plugin`: contracts (`defineRpc`, `defineAttachmentSource`, `RpcInput`, `RpcOutput`), contexts (`PluginClientContext`, `PluginServerContext`), and data hooks (`useRpc`, `usePaseo`, `useWorkspace`, `useAgent`).
  - `@getpaseo/plugin/react-native`: Paseo React Native UI components (`Icon`, `Modal`, `useToast`, `useRevealedText`).
  - `@getpaseo/plugin/server`: handler-only types such as `PluginHandlerContext`.
  - `@getpaseo/plugin/provider`: provider registration and event contracts (`ProviderRegistration`, `negotiateProviderCapabilities`).
  - `@getpaseo/plugin/acp`: command-backed ACP adapter (`runAcpProvider`) and `AcpTransformer` hooks.
- Cross-platform and mobile guardrails:
  - Omit `"DOM"` from `tsconfig.json` `lib` and never add `/// <reference lib="dom" />`. Browser globals
    (`window`, `document`, `localStorage`) are type errors by default.
  - Sanctioned web-only APIs belong exclusively in `client/web.ts`, declaring only used globals, gated by
    `Platform.OS === "web"`, and providing a native fallback or no-op.
- Validate RPC inputs and outputs with Zod, keep secrets server-side, and never log credentials.
- Use lowercase IDs containing only letters, numbers, and hyphens (starting with a lowercase letter).

## Architecture, lifecycle, and state

Patterns observed across Paseo plugins:

- Each installable plugin directory is self-contained with `paseo-plugin.json` (`{ "id": "my-plugin" }`),
  `package.json`, `tsconfig.json`, `index.client.tsx`, and/or `index.server.ts`, with implementation
  organized strictly under `client/`, `server/`, and `shared/`.
- Match the contribution scope to the task:
  - Global surfaces (`client.addSurface`) and sidebar items (`client.addSidebarItem`) for host-wide workflows.
  - Workspace and agent panels (`client.addWorkspacePanel`) declaring `locations: ["workspace", "explorer"]`.
  - Dedicated settings screens (`client.addSettingsScreen({ id, title, icon, Component })`) under Settings.
  - Agent and workspace lifecycle hooks & customization (`server.agents.onAgentCreate`, lifecycle observation, and archiving hooks for closed agents).
  - Contextual commands (`client.addCommandCenterItem` for `global`, `workspace`, or `agent` contexts).
  - Message composer slash commands (`client.addSlashCommand` with `context: "workspace" | "agent"`).
  - Composer pills (`client.addComposerPill`) managed during the client entry lifecycle.
  - Attachment sources (`client.addAttachmentSource`) backed by server search RPCs.
  - Custom themes (`client.addTheme`) with semantic palette tokens.
  - Timeline transformers and renderers (`client.addTimelineTransformer`, `client.addTimelineRenderer`).
  - RPC handlers (`server.handle(contract, handler)`).
  - Coding agent providers (`server.registerProvider(provider)`).
- Coding agent providers (Paseo v0.8):
  - Register providers in `index.server.ts` via `server.registerProvider(createProvider())` implementing
    `ProviderRegistration` from `@getpaseo/plugin/provider`, or adapt an ACP agent using `runAcpProvider`
    from `@getpaseo/plugin/acp`.
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
- Put `defineRpc` contracts, their Zod schemas, and serializable view models in `shared/`. Pass stable IDs
  through RPC, then re-resolve and authorize resources on the server rather than trusting client-provided paths.
- Scope query keys to every relevant identity, such as host, workspace, agent, and resource ID.
  Do not assume separately mounted surfaces share a query cache. Update or invalidate queries after
  mutations, and model loading, empty, error, unavailable, and transitional states explicitly.
- Combine an initial query with subscriptions for persisted data; debounce invalidation and retain a
  periodic refetch as a recovery backstop. Poll only while state is transitioning or stale, and
  clean up timers and subscriptions. For direct client-side event streams, merge by stable domain
  IDs and reject stale async responses before updating state.
- Represent optional CLIs, services, and credentials as capability state with an installation hint;
  do not fail an entire surface because one optional integration is unavailable. Keep external
  integrations behind server-only adapters and degrade each independent data source separately.
- Make persistence durable: version and Zod-validate stored data, normalize legacy or malformed
  values, serialize read-modify-write operations, and use restrictive permissions plus atomic
  temp-file-and-rename writes where applicable. Preserve unknown user configuration when patching
  external config files.
- Cleanup is part of the contribution contract. Make shutdown idempotent and stop timers,
  subscriptions, child processes, sockets, tunnels, and temporary resources; use `finally` for
  credential or temporary-directory removal.

## Rendering patterns

Patterns observed across Paseo plugins:

- Use React Native primitives and host-provided APIs only. Derive component styles from `theme` and
  `layout` in one memoized style object; respect `layout.compact` and `layout.platform` (`ios`, `android`, `web`).
- Color every primary `Text` from `theme.colors.foreground` and secondary text from `theme.colors.foregroundMuted`.
  Never hardcode hex colors or rely on React Native's default text colors.
- Use Paseo host UI components from `@getpaseo/plugin/react-native`:
  - `<Icon name="..." />` for Lucide icons (unknown names safely render nothing; do not import `lucide-react-native`).
  - Controlled `<Modal title="..." icon={...} open={open} onOpenChange={setOpen}><Modal.Content>...</Modal.Content></Modal>` supporting custom body layout, `scrollable={false}` with `ScrollView`, and clipboard actions (`client.clipboard.copyText`).
  - `useToast()` (`show(message, options)`, `error(message)`).
- Keep presentation-model transformations—labels, sorting, grouping, filtering, and compact
  summaries—in `shared/`; keep `client/` components focused on rendering.
- Share focused UI components and theme/layout style factories between a surface and related panels.
  Represent loading, error, empty, unavailable, and confirmation states in the UI, and give controls
  accessible roles, labels, values, and disabled/busy states.
- Key list rows and nested rendered items from stable domain IDs, never index, timestamp, or
  serialized data.
- Timeline transformation and rendering (Paseo v0.8):
  - Paseo v0.8 supports full live streaming transformation and rendering without remounting.
  - Transformers registered via `client.addTimelineTransformer` run synchronously during render model
    construction for both fetched history and live streaming events.
  - The transformer callback receives `{ item, phase }`, where `phase` is `"streaming"` for active/running
    tool calls or reasoning, and `"complete"` otherwise.
  - Paseo memoizes transformer output by source-item reference and derives replacement keys from the source
    item identity, preserving mounted component identity across streaming deltas.
  - Use `useRevealedText(text, phase)` from `@getpaseo/plugin/react-native` to pace custom streaming text
    smoothly, matching Paseo's built-in assistant message behavior.
  - Timeline notifications: Pi extension `ctx.ui.notify()` and OpenCode notices are unified as first-class
    `type: "notification"` timeline items with log levels (info, warning, error) mapped to activity log styling.
    Transformers can target `query: { itemType: "notification" }`.
  - Server handlers can append canonical plugin timeline rows to agent history:
    `await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id, kind, version, data })`
    (payload capped at 64 KiB; advertised via `server_info.features.pluginTimelineItems`).
- Theme plugins: use static `client.addTheme` registrations in `index.client.tsx` with hex color palettes.
  Paseo expands palettes through semantic builders covering surfaces, status, diffs, syntax, and terminals.

## Security, portability, and verification

- Treat filesystem paths, URLs, subprocess arguments, external API payloads, and persisted data as
  system boundaries: canonicalize and restrict paths, allowlist outbound hosts, cap request or
  render sizes, and normalize untrusted results before returning Zod-validated data to the client.
- Prefer documented Paseo and React Native APIs. DOM selectors, `window`/Zustand store access,
  injected host globals, internal SDK imports, and browser-navigation hacks are version-fragile;
  isolate web-only APIs in `client/web.ts` with `Platform.OS === "web"` checks and native fallbacks.
- Subprocess logging and diagnostics: server stdout/stderr output is captured into an in-memory tail
  (up to 500 entries, 256 KiB) and written to `$PASEO_HOME/daemon.log`. Inspect recent logs with
  `paseo plugin logs <plugin-id>` or from Settings → Plugins → Logs. Never log credentials or tokens.
- Test pure transformations, state folding, schema validation, persistence/migration, and server
  adapters with fixtures and deterministic clocks. Verify client and server bundle boundaries so
  server-only or Node imports cannot leak into the client bundle.

For the normal local workflow, install dependencies and typecheck from the plugin directory, then
reload the installed plugin explicitly with `paseo plugin reload <plugin-id>`.
