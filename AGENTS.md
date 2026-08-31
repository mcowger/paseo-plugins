# Paseo plugin guidance

This repository contains Paseo plugins. Use the following Paseo resources as the source of truth
when creating or changing a plugin:

The current target host and SDK baseline is **Paseo v0.7.0-beta.2**. Pin `@getpaseo/client`,
`@getpaseo/plugin`, and `@getpaseo/protocol` to that exact version unless a plugin explicitly
targets another host release.

- [Plugin guide](https://paseo.sh/docs/plugins.md): setup, installation, development workflow,
  lifecycle, and debugging.
- [Plugin API reference](https://paseo.sh/docs/plugins/reference.md): contribution surfaces,
  components, SDK usage, RPC, themes, hosts, and troubleshooting.
- [Official plugin examples](https://github.com/getpaseo/paseo/tree/main/plugin-examples):
  working examples for panels and commands, RPC, attachment sources, themes, and timeline items.
- [Community reference index](examples/README.md): reviewed public plugins grouped by the techniques
  they demonstrate and their known API caveats.

## Development reminders

- The plugin API is experimental and may include breaking changes.
- Plugins are trusted, unsandboxed code. Keep daemon-only work and credentials in server modules;
  client modules run inside Paseo.
- Keep `*.client.tsx`, `*.server.ts`, and `*.shared.ts` boundaries separate. Use host-provided
  modules rather than private Paseo internals.
- The plugin entry point should default-export the contribution function and return cleanup for
  timers, watchers, sockets, and other resources.
- Validate RPC inputs and outputs with Zod, keep secrets server-side, and never log credentials.
- Use lowercase IDs containing only letters, numbers, and hyphens.

## Architecture, lifecycle, and state

Patterns observed across public Paseo plugins:

- Each installable plugin directory should be self-contained, with its own `paseo-plugin.json`,
  `package.json`, and TypeScript configuration. Keep the entrypoint focused on wiring handlers and
  contributions; put implementation in client, server, and shared modules.
- Match the contribution scope to the task: use global surfaces with sidebar/Command Center access
  for host-wide workflows, and workspace or agent panels plus contextual commands for embedded
  workflows. Commands should navigate with `openSurface` or `openPanel` rather than duplicating UI.
- Put `defineRpc` contracts, their Zod schemas, and serializable view models in shared modules.
  Pass stable IDs through RPC, then re-resolve and authorize resources on the server rather than
  trusting client-provided paths, URLs, or mutable object data.
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

Patterns observed in [paseo-agent-monitor](https://github.com/omercnet/paseo-agent-monitor):

- Use React Native primitives and host-provided APIs only. Derive component styles from `theme` and
  `layout` in one memoized style object; respect `layout.compact` and platform differences.
- Keep presentation-model transformations—labels, sorting, grouping, filtering, and compact
  summaries—in `*.shared.ts`; keep `*.client.tsx` components focused on rendering.
- Share focused UI components and theme/layout style factories between a surface and related panels.
  Represent loading, error, empty, unavailable, and confirmation states in the UI, and give controls
  accessible roles, labels, values, and disabled/busy states.
- Key list rows and nested rendered items from stable domain IDs, never index, timestamp, or
  serialized data. Stable keys prevent unnecessary remounts only when the host preserves the
  parent item's identity.
- For persisted or slowly changing data, subscription-triggered query invalidation can be debounced
  and backed by a periodic refetch. It is not a substitute for incremental streaming updates.
- Timeline transformers and renderers can replace terminal timeline rows with Zod-validated,
  JSON-compatible view data. They cannot safely render live/streaming rows with the current host
  lifecycle: re-projection can briefly show the native row and remount the plugin component for
  each delta. Preserve native rendering for `running` items and transform only terminal items.
- Safe custom live rendering requires Paseo core support for transformation in the live reducer, a
  stable source-segment ID used in transformed keys, and ideally an `isLive` transformer input.
- Theme-only plugins should use static, side-effect-free `addTheme` registrations. If theme data is
  generated, validate required tokens and contrast, commit generated artifacts, and provide a stale
  output check in tests or CI.

## Security, portability, and verification

- Treat filesystem paths, URLs, subprocess arguments, external API payloads, and persisted data as
  system boundaries: canonicalize and restrict paths, allowlist outbound hosts, cap request or
  render sizes, and normalize untrusted results before returning Zod-validated data to the client.
- Prefer documented Paseo and React Native APIs. DOM selectors, `window`/Zustand store access,
  injected host globals, internal SDK imports, and browser-navigation hacks are version-fragile;
  isolate and document them only when no public capability exists, and provide platform fallbacks.
- Test pure transformations, state folding, schema validation, persistence/migration, and server
  adapters with fixtures and deterministic clocks. Where feasible, also test contribution
  registration and the client/server bundle boundary so server-only imports cannot leak to clients.

For the normal local workflow, install dependencies and typecheck from the plugin directory, then
reload the installed plugin explicitly with `paseo plugin reload <plugin-id>`.
