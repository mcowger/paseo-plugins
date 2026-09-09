# Paseo plugin reference index

Reviewed public projects to consult alongside the official examples. Treat their current Paseo SDK
versions, legacy single-entry structures (`index.ts`), and any internal-host integration as
implementation details; prefer documented Paseo v0.8 APIs and the guidance in
[`../AGENTS.md`](../AGENTS.md).

## Surfaces, panels, and rendering

| Project | Study for | Useful locations |
| --- | --- | --- |
| [paseo-canvas](https://github.com/itsjustanks/paseo-canvas) | One feature composed as a surface, sidebar item, agent panel, and contextual commands; responsive React Native UI. | `index.ts`, `canvas.client.tsx`, `ui.client.tsx` |
| [paseo-agent-monitor](https://github.com/omercnet/paseo-agent-monitor) | Theme/layout-derived `FlatList` UI, stable list keys, accessible destructive-action confirmation, and debounced subscription refreshes. | `src/components/agent-monitor.client.tsx`, `src/lib/monitor.shared.ts` |
| [paseo-plugins (gpambrozio)](https://github.com/gpambrozio/paseo-plugins) | Focused agent panels, global board surfaces, shared UI models, and granular failure states. | `skills/panel.client.tsx`, `github-board/board.client.tsx` |
| [paseo-plugins (Dey11)](https://github.com/Dey11/paseo-plugins) | Contribution composition across global, workspace, and agent contexts; query-backed panels. | `plugins/*/index.ts`, `plugins/*/main.client.tsx` |
| [eidos-paseo-plugin-store](https://github.com/eidos-agi/eidos-paseo-plugin-store) | Shared client components, machine-state hooks, and capability-dependent UI. | `plugins/volta/main.client.tsx`, `plugins/page-pane/main.client.tsx` |
| [paseo-plugin-vscode-web](https://github.com/itsjustanks/paseo-plugin-vscode-web) | Separating machine state from workspace state; independently mounted surfaces and transitional-state polling. | `state.client.tsx`, `surface.client.tsx`, `ui.client.tsx` |
| [paseo-plugins (sleeyax)](https://github.com/sleeyax/paseo-plugins) | Reusable UI/theme components, platform-aware menus, and optimistic transcript presentation. | `plugins/claude-code-panel/src/client/`, `plugins/discord-rich-presence/src/client/` |

## Data, persistence, and lifecycle

| Project | Study for | Useful locations |
| --- | --- | --- |
| [paseo-plan-manager](https://github.com/huangcb01/paseo-plan-manager) | Versioned and migrated persistence, serialized writes, private file permissions, atomic saves, and preserving external config. | `store.server.ts`, `file-utils.server.ts`, `config.server.ts` |
| [paseo-defer](https://github.com/tomgrin10/paseo-defer) | Zod RPC contracts, queued-state persistence, cleanup of timers/daemon clients, and client/server bundle-boundary checks. | `defer.shared.ts`, `store.server.ts`, `engine.server.ts`, `check-bundles.mjs` |
| [paseo-provider-usage](https://github.com/nerveband/paseo-provider-usage) | Stale-while-revalidate capability data, per-integration failures, temporary credential cleanup, and accessible status/progress UI. | `usage.shared.ts`, `usage.server.ts`, `main.client.tsx` |
| [paseo-canvas](https://github.com/itsjustanks/paseo-canvas) | Server-side path canonicalization, request/render limits, optional dependency detection, and teardown of subprocesses/tunnels. | `canvas.shared.ts`, `canvas.server.ts` |
| [paseo-plugin-vscode-web](https://github.com/itsjustanks/paseo-plugin-vscode-web) | Revalidating workspace paths, limiting RPC inputs, URL allowlisting, and explicit ownership of transient versus independent services. | `links.shared.ts`, `handlers.server.ts`, `tunnel.server.ts` |

## Timeline, themes, and platform caveats

| Project | Study for | Caveat |
| --- | --- | --- |
| [paseo-processes](https://github.com/mjakl/paseo-processes) | Initial timeline fetch plus subscriptions, state folding, stable process IDs, stale-response rejection, and timer cleanup. | It consumes timeline data in a panel; it does not demonstrate a timeline transformer/renderer. Note that live streaming transformation without remounting is natively supported in Paseo v0.8. |
| [agent-paint](https://github.com/jzlosman/agent-paint) | Static `addTheme` registrations, deterministic generation, contrast validation, and checked-in generated artifacts. | Do not hand-edit generated theme output. |
| [paseo-display-switcher](https://github.com/nerveband/paseo-display-switcher) | Keyboard shortcut normalization, idempotent async UI actions, and listener cleanup. | Its DOM selectors, synthetic events, and persisted-store access are private-host workarounds; do not treat them as portable APIs. |
| [paseo-plugins (sleeyax)](https://github.com/sleeyax/paseo-plugins) | Static multi-theme registration and platform-specific React Native behavior. | CLI scraping and Discord IPC are integration-specific server adapters. |

## Official Paseo v0.8 Plugin Examples

- [Paseo settings example](https://github.com/getpaseo/paseo/tree/v0.8.0-beta.1/plugin-examples/settings) demonstrates contributing dedicated settings screens via `client.addSettingsScreen()`.
- [Paseo modal-ui example](https://github.com/getpaseo/paseo/tree/v0.8.0-beta.1/plugin-examples/modal-ui) demonstrates modal layouts, scrolling (`scrollable={false}` with custom `ScrollView`), and clipboard actions (`client.clipboard.copyText`).
- [Paseo lifecycle-actions and lifecycle-logger examples](https://github.com/getpaseo/paseo/tree/v0.8.0-beta.1/plugin-examples) demonstrate observing and customizing agent and workspace lifecycle events (`server.agents.onAgentCreate`, archiving hooks).
- [Paseo agent-configuration example](https://github.com/getpaseo/paseo/tree/v0.8.0-beta.1/plugin-examples/agent-configuration) shows customizing agent parameters and config on the server.
- [Paseo provider-direct example](https://github.com/getpaseo/paseo/tree/v0.8.0-beta.1/plugin-examples/provider-direct)
  demonstrates registering a full coding agent via `server.registerProvider()` implementing `ProviderRegistration`,
  including models/modes catalog, session lifecycles, composer toggle/select settings, prompts, turns,
  steering, persistence replay, and provider-emitted custom timeline items.
- [Paseo provider-acp-transformer example](https://github.com/getpaseo/paseo/tree/v0.8.0-beta.1/plugin-examples/provider-acp-transformer)
  demonstrates wrapping a command-backed ACP agent with `runAcpProvider()` from `@getpaseo/plugin/server/acp` and
  applying focused `AcpTransformer` hooks.
- [Paseo inline-thinking example](https://github.com/getpaseo/paseo/tree/v0.8.0-beta.1/plugin-examples/inline-thinking)
  shows that custom timeline renderers operate independently of provider implementations.
- [Paseo timeline-items example](https://github.com/getpaseo/paseo/tree/v0.8.0-beta.1/plugin-examples/timeline-items)
  shows the supported `addTimelineTransformer` and `addTimelineRenderer` contribution shape.
- [pi-plugin-mcowger packaging notes](../pi-plugin-mcowger/docs/packaging.md) (in this repo): what it actually takes to embed a
  large npm SDK (pi's coding agent) in a plugin server bundle. Covers the boundary checker's type-dependency walk, broken
  vendor declaration unions, the eval'd-CJS runtime (no `import.meta`), Paseo's eager interop rewrite, and a local harness
  that reproduces the daemon's exact compile-and-eval path before you hit reload.
