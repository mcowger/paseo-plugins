# Paseo plugin guidance

This repository contains Paseo plugins. Use the following Paseo resources as the source of truth
when creating or changing a plugin:

The current target host and SDK baseline is **Paseo v0.8.0**. Pin `@getpaseo/client`,
`@getpaseo/plugin`, and `@getpaseo/protocol` to 0.8.0. Declare compatibility in
`paseo-plugin.json` via `requirements: { "paseo": ">=0.8.0" }` to enforce version checks at startup.

When researching Paseo contracts (plugin SDK types, protocol, examples), use the local
Paseo checkout at `~/workspace/paseo` (`packages/plugin`, `packages/protocol`,
`plugin-examples`) instead of web calls to GitHub.

- [Plugin guide](https://paseo.sh/docs/plugins.md): setup, installation, development workflow,
  lifecycle, and debugging.
- [Plugin API reference](https://paseo.sh/docs/plugins/v0.8/reference.md): contribution surfaces,
  components, SDK usage, RPC, themes, hosts, and troubleshooting.
- [Runtime entry migration guide](https://paseo.sh/docs/plugins/v0.8/migration.md): migrating from
  mixed root entries to explicit client and server runtime entries.
- [Official plugin examples](https://github.com/getpaseo/paseo/tree/v0.8.0/plugin-examples):
  working examples for panels and commands (`local-plugin`), RPC, attachment sources (`linear`),
  themes (`catppuccin`), and timeline items (`timeline-items`, `inline-thinking`).
  Provider examples (`provider-direct`, `provider-acp-transformer`) are covered in
  `pi-plugin-mcowger/AGENTS.md`.
- [Community plugin registry (paseo.cafe)](https://paseo.cafe/): community-run directory indexing
  Paseo plugins from GitHub. Machine-readable endpoints:
  - Catalog JSON: [`https://paseo.cafe/api/plugins`](https://paseo.cafe/api/plugins)
  - LLM compact index: [`https://paseo.cafe/llms.txt`](https://paseo.cafe/llms.txt)
  - LLM expanded facts: [`https://paseo.cafe/llms-full.txt`](https://paseo.cafe/llms-full.txt)
  - OpenAPI spec: [`https://paseo.cafe/openapi.json`](https://paseo.cafe/openapi.json)
  - GitHub registry source: [`https://github.com/paseo-cafe/paseo-cafe/tree/main/registry`](https://github.com/paseo-cafe/paseo-cafe/tree/main/registry)
  - Per-plugin markdown: `https://paseo.cafe/plugins/<id>.md`
- [Community reference index](examples/README.md): reviewed public plugins from the paseo.cafe registry
  grouped by the techniques they demonstrate (surfaces, panels, timeline transformers, pills,
  lifecycle hooks, telemetry) with direct GitHub and paseo.cafe links.
  Provider and ACP adapter entries are covered in `pi-plugin-mcowger/AGENTS.md`.

## Development reminders

- The Paseo 0.8 plugin API is stable.
- Fix every lint, typecheck, and test warning or failure before completing the task. Never dismiss one as pre-existing.
- Modifying Paseo itself is never a viable path; solve plugin work within the supported plugin API.
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
  - `@getpaseo/plugin`: shared contracts (`defineRpc`, `defineAttachmentSource`, `RpcInput`, `RpcOutput`).
  - `@getpaseo/plugin/client`: client contexts, contribution types, hooks, and navigation (`PluginClientContext`, `useRpc`, `usePaseo`, `useWorkspace`, `useAgent`).
  - `@getpaseo/plugin/client/react-native`: Paseo React Native UI components (`Icon`, `Modal`, `useToast`, `useRevealedText`).
  - `@getpaseo/plugin/server`: server contexts and handler-only types such as `PluginHandlerContext`.
  - Provider-only imports (`@getpaseo/plugin/server/provider`, `@getpaseo/plugin/server/acp`)
    are covered in `pi-plugin-mcowger/AGENTS.md`.
- Cross-platform and mobile guardrails:
  - Omit `"DOM"` from `tsconfig.json` `lib` and never add `/// <reference lib="dom" />`. Browser globals
    (`window`, `document`, `localStorage`) are type errors by default.
  - Sanctioned web-only APIs belong exclusively in `client/web.ts`, declaring only used globals, gated by
    `Platform.OS === "web"`, and providing a native fallback or no-op.
  - Client bundles run on Hermes in native iOS/Android. Avoid ES6 classes, browser DOM utilities, and
    heavy AST libraries in client modules; see [Mobile and Hermes runtime compatibility](#mobile-and-hermes-runtime-compatibility).
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
  - Coding agent providers (`server.registerProvider(provider)`); see `pi-plugin-mcowger/AGENTS.md`.
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
- Use Paseo host UI components from `@getpaseo/plugin/client/react-native`:
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
  - Use `useRevealedText(text, phase)` from `@getpaseo/plugin/client/react-native` to pace custom streaming text
    smoothly, matching Paseo's built-in assistant message behavior.
  - Timeline notifications: Pi extension `ctx.ui.notify()` and OpenCode notices are unified as first-class
    `type: "notification"` timeline items with log levels (info, warning, error) mapped to activity log styling.
    Transformers can target `query: { itemType: "notification" }`.
  - Server handlers can append canonical plugin timeline rows to agent history:
    `await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id, kind, version, data })`
    (payload capped at 64 KiB; advertised via `server_info.features.pluginTimelineItems`).
- Theme plugins: use static `client.addTheme` registrations in `index.client.tsx` with hex color palettes.
  Paseo expands palettes through semantic builders covering surfaces, status, diffs, syntax, and terminals.

## Mobile and Hermes runtime compatibility

Paseo runs on desktop/web (V8/Chromium) and native mobile (iOS and Android via Hermes in React Native). Plugin client bundles must execute in both runtimes.

### Evaluation model on mobile

- App code is bundled ahead of time with Metro and Babel, lowering modern syntax to ES5.
- Plugin client bundles bypass Metro. The Paseo daemon compiles `index.client.tsx` on the fly with `esbuild` (`es2020` target, no Babel lowering pass) and sends the bundle string over the WebSocket to the app.
- The mobile app runs the bundle directly via `globalThis.eval(bundle)`.
- If evaluation throws, `PluginRegistry.installCatalog` catches the exception and drops the plugin for that session. The plugin shows as Failed under **Settings → Plugins** with the evaluation error message.

### Hermes restrictions and client dependencies

- **Dynamic `eval()` and class syntax in Hermes:** Paseo mobile runs Hermes as configured by React Native. Unlike the main app bundle (which Babel transpiles ahead of time), plugin client bundles are evaluated dynamically via `eval()`. Under this evaluation mode, certain ES6 class patterns have known runtime failures:
  - Anonymous class expressions assigned to variables (`var Schema = class {}; Schema.prototype.prop = ...`) can evaluate the variable as `undefined` before prototype assignment, throwing:
    ```text
    TypeError: Cannot read property 'prototype' of undefined
    ```
  - Certain class declarations and inheritance patterns can also trigger `SyntaxError: invalid statement encountered` depending on the Hermes runtime flags configured by the host build.
  - Writing client plugin code with plain functions, closures, and object literals avoids these runtime evaluation pitfalls. Prefer functions and plain objects in client modules.
- **Audit client dependencies:** Any npm package bundled into `client/` or `shared/` runs through `eval()` on Hermes. Packages that pass in Node or browser tests can crash Hermes immediately during evaluation.
  - Packages with known mobile eval failures:
    - `@shikijs/*`: pulls in `property-information`, Unified/HAST AST utilities, and class expressions that trigger the prototype TypeError.
    - `highlight.js` (v11+): uses class declarations (`class MultiRegex`, `class TokenTree`) that can fail parsing on Hermes.
    - `diff`: pulls in unnecessary class/prototype chains and adds bundle bloat.
  - Safe alternatives:
    - `prismjs`: modular imports (`prismjs/components/prism-core` plus specific language grammars like `prismjs/components/prism-typescript`) use pure ES5 functions and prototype objects without classes.
    - Native protocol diffs: use Paseo's `ToolCallDetail.unifiedDiff` directly instead of running a diff engine in the client. If fallback diffing is needed when `unifiedDiff` is absent, use a compact functional line diff.
- **Keep client bundles small:** Aim for under 300 KB. Mobile devices must download, parse, and evaluate the full bundle string over WebSocket. Large bundles hurt startup time and can cause `esbuild` to rename loop variables (e.g. `key` to `key2`), breaking the daemon compiler's `makeHermesInteropEager` export fix.

### Verifying mobile compatibility

Do not rely on standard unit tests alone; they run in Node (V8) against raw source files and will not catch bundle-level Hermes bugs.

#### Automated bundle checks in `npm test`

Add an automated client bundle test (e.g. `client/bundle.test.ts`) that runs with Vitest to catch syntax, class, and size regressions in CI:

1. **Bundle with `esbuild`:** Use `esbuild` in tests to build the client entrypoint using the same config Paseo daemon uses (target `es2020`, platform `neutral`, format `cjs`, externalizing `@getpaseo/*`, `react`, `react-native`, `@tanstack/react-query`, and `zod`).
2. **Assert no unlowered ES6 classes:** Strip comments and verify no `class ` declarations or expressions (`/\bclass\s+[A-Za-z0-9_$]+|\bclass\s*\{|=\s*class\b/`) exist in the output bundle.
3. **Assert bundle size budget:** Keep client bundle under ~300 KB to guard against accidental heavy imports.
4. **Bytecode compilation via `hermesc`:** Resolve React Native's bundled Hermes compiler (`node_modules/react-native/sdks/hermesc/<platform>-bin/hermesc`) and run `-emit-binary` to guarantee Hermes bytecode parser acceptance.

See `colorful-agent-activity/client/bundle.test.ts` for the reference test implementation.

#### Runtime verification on device

`hermesc` verifies syntax and bytecode generation, but cannot catch runtime evaluation, missing globals, or native UI interop failures. Always smoke test changes on a connected mobile device or emulator:
- Reload the plugin on your host (`paseo plugin reload <plugin-id>`).
- Open the Paseo app on iOS or Android and check **Settings → Plugins** (or **Settings → Hosts → [Host] → Plugins**) to confirm the plugin is active and shows no evaluation error.

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

## Cora review

Never run `cora` or `cora-code` unless the user explicitly requests that specific Cora action in the current turn. A request to commit, test, review, stage, push, or open a PR does not grant Cora permission.

## Plugin CLI workflow

Run the plugin CLI help before using a subcommand: `paseo plugin <command> --help`.

- `paseo plugin init <directory> [--id <id>]` creates a local plugin.
- `paseo plugin install <directory> [--id <id>]` installs a local directory. It also accepts a Git source, `--ref`, and `--path`.
- `paseo plugin ls [id] [--json]` checks install, enablement, and load state. Use `--host` or `--home` to target a specific daemon.
- `paseo plugin reload <id>` reloads an installed plugin. Use it after every server or client change.
- `paseo plugin logs <id>` checks daemon-side load and runtime errors after install or reload.
- `paseo plugin enable <id>`, `disable <id>`, `remove <id>`, and `update [id|--all]` manage existing plugin configuration.

For the normal local workflow, install dependencies, run `npm run lint`, `npm run typecheck`, and
`npm test` from the plugin directory, then install the plugin with `paseo plugin install <directory>`
(if it is not already configured), reload it explicitly with `paseo plugin reload <plugin-id>`, and
confirm it loaded with `paseo plugin ls <plugin-id>` and `paseo plugin logs <plugin-id>`.
