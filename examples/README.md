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

## Official timeline reference

- [Paseo timeline-items example](https://github.com/getpaseo/paseo/tree/main/plugin-examples/timeline-items)
  shows the supported `addTimelineTransformer` and `addTimelineRenderer` contribution shape.
- Paseo v0.8 natively supports live streaming timeline transformation and rendering:
  - Transformers receive `{ item, phase }`, where `phase` is `"streaming"` or `"complete"`.
  - Paseo memoizes by source-item reference and derives replacement identities from the source item,
    preserving mounted component identity across streaming deltas without remounting.
  - Custom streaming text can be paced with `useRevealedText(text, phase)` from `@getpaseo/plugin/react-native`.
  - Extension notifications (Pi `ctx.ui.notify()` and OpenCode notices) are unified as first-class
    `type: "notification"` timeline items with log levels mapped to activity log styling.
  - Server handlers can append canonical plugin timeline rows using
    `await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id, kind, version, data })`
    (capped at 64 KiB; advertised via `server_info.features.pluginTimelineItems`).

## Official provider reference (Paseo v0.8)

- [Paseo provider-direct example](https://github.com/getpaseo/paseo/tree/main/plugin-examples/provider-direct)
  demonstrates registering a full coding agent via `server.registerProvider()` implementing `ProviderRegistration`,
  including models/modes catalog, session lifecycles, composer toggle/select settings, prompts, turns,
  steering, persistence replay, and provider-emitted custom timeline items.
- [Paseo provider-acp-transformer example](https://github.com/getpaseo/paseo/tree/main/plugin-examples/provider-acp-transformer)
  demonstrates wrapping a command-backed ACP agent with `runAcpProvider()` from `@getpaseo/plugin/acp` and
  applying focused `AcpTransformer` hooks.
- [Paseo inline-thinking example](https://github.com/getpaseo/paseo/tree/main/plugin-examples/inline-thinking)
  shows that custom timeline renderers operate independently of provider implementations.
