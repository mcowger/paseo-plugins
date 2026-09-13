# Paseo plugin reference index

Reviewed community and official plugins to consult alongside the Paseo v0.8 documentation.
The community registry at [paseo.cafe](https://paseo.cafe/) indexes community-built plugins
straight from their GitHub repositories and provides machine-readable feeds for agents and tooling.

When developing plugins, treat third-party projects' legacy single-entry structures (`index.ts`)
and private host integrations as implementation details; prefer documented Paseo v0.8 APIs and
the guidance in [`../AGENTS.md`](../AGENTS.md).

## The paseo.cafe registry ecosystem

The [paseo.cafe registry](https://github.com/paseo-cafe/paseo-cafe/tree/main/registry) indexes
public Paseo plugins. Each listing is driven by a single JSON entry (`registry/<plugin-id>.json`)
pointing to a GitHub repository, with metadata, categories, platforms, and caveats verified by CI.

### Discovery and machine-readable interfaces

- **Web catalog**: [paseo.cafe](https://paseo.cafe/)
- **Registry repository**: [paseo-cafe/paseo-cafe/tree/main/registry](https://github.com/paseo-cafe/paseo-cafe/tree/main/registry)
- **Compact index for LLMs**: [`https://paseo.cafe/llms.txt`](https://paseo.cafe/llms.txt)
- **Expanded Markdown catalog**: [`https://paseo.cafe/llms-full.txt`](https://paseo.cafe/llms-full.txt)
- **Full JSON catalog**: [`https://paseo.cafe/api/plugins`](https://paseo.cafe/api/plugins)
- **OpenAPI document**: [`https://paseo.cafe/openapi.json`](https://paseo.cafe/openapi.json)
- **Per-plugin Markdown**: `https://paseo.cafe/plugins/<id>.md` (e.g. [`colorful-agent-activity.md`](https://paseo.cafe/plugins/colorful-agent-activity.md))
- **Per-plugin JSON**: `https://paseo.cafe/api/plugin/<id>.json` (e.g. [`colorful-agent-activity.json`](https://paseo.cafe/api/plugin/colorful-agent-activity.json))

---

## 1. Surfaces, dashboards, and navigation

Plugins contributing host-wide screens (`client.addSurface`), sidebar items (`client.addSidebarItem`),
and cross-workspace management tools.

| Plugin & links | Study for | Useful locations / implementation | Caveats & platforms |
| --- | --- | --- | --- |
| [github-board](https://github.com/gpambrozio/paseo-plugins/tree/main/github-board) &bull; [cafe](https://paseo.cafe/plugins/github-board) | 4-column GitHub work surface (`addSurface`), RPC queries to daemon-side `gh` CLI, optimistic status changes. | `github-board/board.client.tsx`, `github-board/board.server.ts` | Requires `gh` authenticated on daemon host. |
| [agent-monitor](https://github.com/omercnet/paseo-plugins/tree/main/agent-monitor) &bull; [cafe](https://paseo.cafe/plugins/agent-monitor) | Host-wide triage roster across all workspaces, theme-derived `FlatList`, debounced subscription refetches. | `src/components/agent-monitor.client.tsx`, `src/lib/monitor.shared.ts` | Requires Paseo 0.8.x. |
| [agents-dash-list](https://github.com/panrafal/paseo-plugins/tree/main/agents-dash-list) &bull; [cafe](https://paseo.cafe/plugins/agents-dash-list) | Sidebar dashboard of workspaces grouped by status (waiting, unread, in progress, idle, closed), unread tracking. | `agents-dash-list/client/`, `agents-dash-list/server/` | Unread marks stay on the daemon that stored them. |
| [agents-history](https://github.com/panrafal/paseo-plugins/tree/main/agents-history) &bull; [cafe](https://paseo.cafe/plugins/agents-history) | Global search over all workspaces and archived agents, on-disk transcript parsing, local SQLite/JSON search index. | `agents-history/client/`, `agents-history/server/` | Reads local transcripts on disk. |
| [paseo-cafe](https://github.com/paseo-cafe/paseo-cafe/tree/main/plugin) &bull; [cafe](https://paseo.cafe/plugins/paseo-cafe) | Native in-app plugin catalog browser and installer (`client.addSurface`), calls daemon `paseo` CLI to install. | `plugin/client/`, `plugin/server/` | Runs `paseo` CLI on daemon host; requires network. |
| [k8s](https://github.com/jeroenfrenken/paseo-k8s) &bull; [cafe](https://paseo.cafe/plugins/k8s) | Kubernetes workloads, streaming pod logs, GitOps integration, and interactive kubectl command bar. | `client/`, `server/` | Requires reachable cluster credentials on daemon. |
| [launchd-jobs](https://github.com/gpambrozio/paseo-plugins/tree/main/launchd-jobs) &bull; [cafe](https://paseo.cafe/plugins/launchd-jobs) | macOS LaunchAgent scheduler and monitor surface, cron expression and interval parsing, launchd IPC. | `launchd-jobs/jobs.client.tsx`, `launchd-jobs/jobs.server.ts` | macOS only; requires active GUI login session. |
| [schedule-runs](https://github.com/panrafal/paseo-plugins/tree/main/schedule-runs) &bull; [cafe](https://paseo.cafe/plugins/schedule-runs) | Sidebar feed of scheduled agent runs with status, archived states, and final responses. | `schedule-runs/client/`, `schedule-runs/server/` | Read-only feed of existing schedule runs. |
| [paseo-mcp](https://github.com/itsjustanks/paseo-mcp) &bull; [cafe](https://paseo.cafe/plugins/paseo-mcp) | Surface for managing host and workspace MCP servers, project credentials, and OAuth handshakes. | `client/`, `server/` | Manages daemon config and credentials. |
| [paseo-prompt-manager](https://github.com/yannelli/paseo-prompt-manager) &bull; [cafe](https://paseo.cafe/plugins/paseo-prompt-manager) | Prompt library surface with version history, file imports, and optional Git sync. | `client/`, `server/` | Local filesystem persistence. |
| [shared-browser](https://github.com/omercnet/paseo-plugins/tree/main/paseo-shared-browser) &bull; [cafe](https://paseo.cafe/plugins/shared-browser) | One shared Chromium session per workspace, remote frame streaming via WebSockets to React Native canvas. | `client/`, `server/` | Installs ~180MB Chromium download on daemon host. |
| [daemon-link](https://github.com/itsjustanks/paseo-plugin-daemon) &bull; [cafe](https://paseo.cafe/plugins/daemon-link) | Multi-daemon management, localhost tunnel discovery, Git project transfers, and host telemetry. | `client/`, `server/` | Multi-host network setup. |

---

## 2. Workspace and agent panels

Plugins contributing inspector and contextual tool panels (`client.addWorkspacePanel`) in the `workspace`, `explorer`, or `agent` locations.

| Plugin & links | Study for | Useful locations / implementation | Caveats & platforms |
| --- | --- | --- | --- |
| [opencode-session-overview](https://github.com/mcowger/paseo-plugins/tree/main/opencode-session-overview) &bull; [cafe](https://paseo.cafe/plugins/opencode-session-overview) | Read-only agent inspector panel, native session IDs, context window meters, skills/tasks listing. | `client/overview.tsx`, `shared/overview.ts` | Scoped to OpenCode agents. |
| [subagent-activity](https://github.com/mcowger/paseo-plugins/tree/main/subagent-activity) &bull; [cafe](https://paseo.cafe/plugins/subagent-activity) | Agent-scoped activity pane tracking managed descendants and provider-native subagent tasks. | `client/subagent-activity.tsx`, `shared/subagent-activity.ts` | Best effort for provider-native subagents. |
| [session-summary](https://github.com/mcowger/paseo-plugins/tree/main/session-summary) &bull; [cafe](https://paseo.cafe/plugins/session-summary) | Live session recap, token usage metrics, tool invocation counts, markdown session notes generation. | `client/session-summary-panel.tsx`, `client/use-summary-data.ts` | Usage fields depend on provider reporting. |
| [skills](https://github.com/gpambrozio/paseo-plugins/tree/main/skills) &bull; [cafe](https://paseo.cafe/plugins/skills) | Lists available agent skills, parses and renders `SKILL.md` documents, invokes skills into conversation. | `skills/panel.client.tsx`, `skills/skills.server.ts` | Reads skill locations on daemon host. |
| [agent-crew](https://github.com/omercnet/paseo-plugins/tree/main/agent-crew) &bull; [cafe](https://paseo.cafe/plugins/agent-crew) | Explorer panel for visualizing and orchestrating multi-agent crews within a workspace. | `client/`, `server/` | Requires Paseo 0.8.x. |
| [setup-monitor](https://github.com/stevecastaneda/paseo-plugins/tree/main/setup-monitor) &bull; [cafe](https://paseo.cafe/plugins/setup-monitor) | Live view of `worktree.setup` execution subscribing to `workspace_setup_status` stream during setup. | `client/`, `server/` | Tracks setup commands declared in `paseo.json`. |
| [review-deck](https://github.com/mentalfl0w/review-deck) &bull; [cafe](https://paseo.cafe/plugins/review-deck) | Human-in-the-loop code review panel, file diff inspection, inline comments, agent task generation. | `client/`, `server/` | Requires Paseo 0.8.x. |
| [branch-garden](https://github.com/NaruForge/Paseo-Plugin/tree/main/plugins/branch-garden) &bull; [cafe](https://paseo.cafe/plugins/branch-garden) | Git branch management, worktree visualizer, status indicators inside workspace panel. | `plugins/branch-garden/client/` | Paseo 0.8.0 Windows/macOS/Linux. |
| [command-deck](https://github.com/NaruForge/Paseo-Plugin/tree/main/plugins/command-deck) &bull; [cafe](https://paseo.cafe/plugins/command-deck) | Interactive command launcher and output viewer in workspace panel. | `plugins/command-deck/client/` | Paseo 0.8.0. |
| [prompt-palette](https://github.com/NaruForge/Paseo-Plugin/tree/main/plugins/prompt-palette) &bull; [cafe](https://paseo.cafe/plugins/prompt-palette) | Contextual prompt template library and quick-insertion panel. | `plugins/prompt-palette/client/` | Paseo 0.8.0. |
| [workspace-activity](https://github.com/ABorakati/paseo-workspace-activity) &bull; [cafe](https://paseo.cafe/plugins/workspace-activity) | Workspace task list and agent status panel. | `client/`, `server/` | Workspace-level aggregation. |
| [workspace-links](https://github.com/stevecastaneda/paseo-plugins/tree/main/workspace-links) &bull; [cafe](https://paseo.cafe/plugins/workspace-links) | Setup and management panel for URLs declared in `.paseo/workspace-links.json`. | `client/`, `server/` | Opens links in daemon host browser. |

---

## 3. Timeline transformers and custom renderers

Plugins modifying or replacing transcript rows (`client.addTimelineTransformer`, `client.addTimelineRenderer`).
Paseo v0.8 supports live streaming transformation without remounting using `{ item, phase }`.

| Plugin & links | Study for | Useful locations / implementation | Caveats & platforms |
| --- | --- | --- | --- |
| [colorful-agent-activity](https://github.com/mcowger/paseo-plugins/tree/main/colorful-agent-activity) &bull; [cafe](https://paseo.cafe/plugins/colorful-agent-activity) | Dense IDE-style tool & reasoning cards, streaming expansion, Prism syntax highlighting, automated Hermes mobile bundle test. | `client/activity.tsx`, `client/highlight.ts`, `client/bundle.test.ts` | Detailed tool mode; mobile-safe (Hermes verified). |
| [readable-agent-activity](https://github.com/geoqiao/paseo-stuff/tree/main/plugins/agent-activity) &bull; [cafe](https://paseo.cafe/plugins/readable-agent-activity) | Clean tool call and reasoning presentation, JSON syntax formatting, bounded payload folding. | `plugins/agent-activity/client/` | Full detail only; do not stack with other transformers. |
| [reasoning-display](https://github.com/mcowger/paseo-plugins/tree/main/reasoning-display) &bull; [cafe](https://paseo.cafe/plugins/reasoning-display) | Expandable Markdown renderer for provider reasoning blocks matching native tool-call cards. | `client/reasoning.tsx`, `client/transform-reasoning.ts` | Scoped to provider-reported reasoning blocks. |
| [pi-tasks-timeline](https://github.com/mcowger/paseo-plugins/tree/main/pi-tasks-timeline) &bull; [cafe](https://paseo.cafe/plugins/pi-tasks-timeline) | Parses completed `todo` tool results into interactive task list items, state folding across timeline history. | `client/pi-tasks.tsx`, `client/transform-pi-tasks.ts` | Requires compatible `todo` tool output shape. |
| [math-renderer](https://github.com/geoqiao/paseo-stuff/tree/main/plugins/math-renderer) &bull; [cafe](https://paseo.cafe/plugins/math-renderer) | Renders block LaTeX in assistant messages using local MathJax and embedded resvg WASM. | `plugins/math-renderer/client/` | Block math only; fallback on unsupported macros. |
| [video-embeds](https://github.com/kschniedergers/paseo-plugins/tree/main/video-embeds) &bull; [cafe](https://paseo.cafe/plugins/video-embeds) | Parses `![clip](/path.mp4)` in assistant markdown, embeds native video player on desktop/web with mobile fallback. | `client/`, `server/` | Desktop/web playback only; mobile shows card. |

---

## 4. Composer pills, modals, and contextual actions

Plugins adding interactive pills (`client.addComposerPill`), modal dialogs, and slash commands to the message composer.

| Plugin & links | Study for | Useful locations / implementation | Caveats & platforms |
| --- | --- | --- | --- |
| [time-since](https://github.com/stevecastaneda/paseo-plugins/tree/main/time-since) &bull; [cafe](https://paseo.cafe/plugins/time-since) | Live ticking elapsed timer pill showing duration since last user or assistant message in thread. | `client/time-since.tsx` | Pure client-side timeline observation. |
| [chat-resume](https://github.com/panrafal/paseo-plugins/tree/main/chat-resume) &bull; [cafe](https://paseo.cafe/plugins/chat-resume) | Contextual pills appearing only on quota/limit errors to resume, wait for allowance, or prepare handover. | `chat-resume/client/` | Conditional pill visibility based on last agent error. |
| [agent-heartbeats](https://github.com/panrafal/paseo-plugins/tree/main/agent-heartbeats) &bull; [cafe](https://paseo.cafe/plugins/agent-heartbeats) | Composer pill showing heartbeat count with modal dialog to create, edit, and cancel recurring prompts. | `agent-heartbeats/client/`, `agent-heartbeats/server/` | Modifying heartbeat resets run history. |
| [remote-editor](https://github.com/alhassanaraouf/paseo-remote-editor) &bull; [cafe](https://paseo.cafe/plugins/remote-editor) | Composer pill opening the workspace in VS Code or Zed over SSH on desktop. | `client/`, `server/` | Desktop only; requires SSH remote extension. |
| [vscode-open-remote](https://github.com/panrafal/paseo-plugins/tree/main/vscode-open-remote) &bull; [cafe](https://paseo.cafe/plugins/vscode-open-remote) | Composer pill opening workspace directory in VS Code, Cursor, or vscode.dev tunnel. | `client/`, `server/` | Desktop & tablet only; requires matching tunnel. |
| [workspace-links](https://github.com/stevecastaneda/paseo-plugins/tree/main/workspace-links) &bull; [cafe](https://paseo.cafe/plugins/workspace-links) | Composer pill and header button showing quick-open menu of URLs defined in workspace config. | `client/`, `server/` | Opens URL in daemon host default browser. |
| [paseo-plain](https://github.com/scowalt/paseo-plain) &bull; [cafe](https://paseo.cafe/plugins/paseo-plain) | Composer trigger to rewrite assistant response in plain English without modifying canonical conversation. | `client/`, `server/` | Preserves original transcript. |
| [paseo-prometheus-status](https://github.com/infectiousstupidity/paseo-prometheus-status) &bull; [cafe](https://paseo.cafe/plugins/paseo-prometheus-status) | Dynamic warning pill appearing only when GPU temperature, VRAM, or power cross configured thresholds. | `client/`, `server/` | Requires reachable Prometheus endpoint. |

---

## 5. Agent providers and ACP adapters

Plugins registering coding agents via `server.registerProvider()` implementing `ProviderRegistration`,
or adapting external agents via `runAcpProvider()`.

| Plugin & links | Study for | Useful locations / implementation | Caveats & platforms |
| --- | --- | --- | --- |
| [pi-plugin-mcowger](https://github.com/mcowger/paseo-plugins/tree/main/pi-plugin-mcowger) &bull; [cafe](https://paseo.cafe/plugins/pi-plugin-mcowger) | Direct in-process provider embedding `@earendil-works/pi-coding-agent`, session lifecycle, tool policy, vendor SDK bundling. | `server/provider.ts`, `server/session.ts`, `docs/packaging.md` | In-process daemon embedding; CJS eval bundling. |
| [commandcode-provider](https://github.com/alhassanaraouf/paseo-commandcode-provider) &bull; [cafe](https://paseo.cafe/plugins/commandcode-provider) | Stdio CLI wrapper provider for Command Code, streaming output mapping, effort level negotiation. | `server/provider.ts`, `server/session.ts` | Requires `commandcode` CLI on daemon PATH. |
| [agy-provider](https://github.com/3ae3ae/paseo-plugin-agy-provider) &bull; [cafe](https://paseo.cafe/plugins/agy-provider) | Provider adapter for Google Antigravity ACP server, Command Center login flow, capability negotiation. | `server/` | macOS ARM64 verified; Node 22.18+ on daemon. |
| [deepseek-harness](https://github.com/geoqiao/paseo-stuff/tree/main/plugins/deepseek-harness) &bull; [cafe](https://paseo.cafe/plugins/deepseek-harness) | ACP profile adapter for DeepSeek Harness, native context resumption without transcript replay. | `plugins/deepseek-harness/server/` | Requires DSH 0.1.5-rc.1/2 and credentials. |
| [zcode-provider](https://github.com/supermomonga/paseo-plugin-zcode-provider) &bull; [cafe](https://paseo.cafe/plugins/zcode-provider) | Headless integration with ZCode desktop app, custom tool dispatch, model discovery. | `server/` | Unofficial headless connection; macOS/Linux/Windows. |
| [acp-manager](https://github.com/alhassanaraouf/paseo-acp-manager) &bull; [cafe](https://paseo.cafe/plugins/acp-manager) | Sidebar management UI for ACP providers, testing `initialize` handshake, quick-add from ACP registry. | `client/`, `server/` | Direct `$PASEO_HOME/config.json` edits; runs `paseo reload`. |
| [obol](https://github.com/broomva/obol) &bull; [cafe](https://paseo.cafe/plugins/obol) | Multi-subscription proxy behind provider, live credential switching without restarting daemon. | `server/` | Provider routing proxy. |
| [agent-link-9router](https://github.com/itsjustanks/paseo-plugin-9router/tree/main/apps/paseo) &bull; [cafe](https://paseo.cafe/plugins/agent-link-9router) | Provider routing bridge connecting external multi-model router into Paseo. | `apps/paseo/` | External routing service. |

---

## 6. Usage, quotas, and telemetry

Plugins tracking token usage, plan allowances, API costs, and system resources.

| Plugin & links | Study for | Useful locations / implementation | Caveats & platforms |
| --- | --- | --- | --- |
| [usage-sidebar](https://github.com/RUIIIOVO/paseo-usage-sidebar) &bull; [cafe](https://paseo.cafe/plugins/usage-sidebar) | Always-visible sidebar quota meter + full breakdown panel, reads Paseo's native usage state. | `client/`, `server/` | Requires Paseo 0.8.0+; meter desktop/web only. |
| [provider-usage](https://github.com/nerveband/paseo-provider-usage) &bull; [cafe](https://paseo.cafe/plugins/provider-usage) | Sidebar surface tracking Claude, Codex, and Antigravity plan usage with stale-while-revalidate caching. | `usage.shared.ts`, `usage.server.ts`, `main.client.tsx` | Stale-while-revalidate; per-provider error isolation. |
| [usage-monitor](https://github.com/ABorakati/paseo-usage-monitor) &bull; [cafe](https://paseo.cafe/plugins/usage-monitor) | Model token usage limits, balance tracking, and reading local CLI credential files. | `client/`, `server/` | Reads local provider configuration files. |
| [session-usage](https://github.com/panrafal/paseo-plugins/tree/main/session-usage) &bull; [cafe](https://paseo.cafe/plugins/session-usage) | Transcript parser for Claude/Codex costs, sortable statistics, visual charts, and CSV data export. | `session-usage/client/`, `session-usage/server/` | Reads local disk transcripts; no billing API needed. |
| [smart-session](https://github.com/tomgrin10/paseo-smart-session) &bull; [cafe](https://paseo.cafe/plugins/smart-session) | Historical plan-usage tracking, automatic context pruning for long-running sessions. | `client/`, `server/` | Claude plan-focused. |
| [paseo-prometheus-status](https://github.com/infectiousstupidity/paseo-prometheus-status) &bull; [cafe](https://paseo.cafe/plugins/paseo-prometheus-status) | Prometheus metrics subscriber polling GPU VRAM, utilization, power, and temperatures. | `client/`, `server/` | Requires reachable Prometheus instance. |

---

## 7. Git, worktrees, lifecycle, and automation

Plugins intercepting daemon lifecycle events (`onAgentCreate`, `onAgentArchive`), automating Git, or connecting external triggers.

| Plugin & links | Study for | Useful locations / implementation | Caveats & platforms |
| --- | --- | --- | --- |
| [archive-branch-cleanup](https://github.com/MaplumeX/paseo-archive-branch-cleanup) &bull; [cafe](https://paseo.cafe/plugins/archive-branch-cleanup) | Server daemon lifecycle hook (`onAgentArchive`) automatically deleting the local Git branch on archive. | `index.server.ts` | Operates on Paseo-created worktree branches. |
| [fresh-worktrees](https://github.com/omercnet/paseo-plugins/tree/main/fresh-worktrees) &bull; [cafe](https://paseo.cafe/plugins/fresh-worktrees) | Intercepts branch-off worktree creation to fast-forward local base branches, preventing stale branches. | `server/` | Requires Paseo 0.8.0-beta.1+; aborts if fetch fails. |
| [paseo-defer](https://github.com/tomgrin10/paseo-defer) &bull; [cafe](https://paseo.cafe/plugins/paseo-defer) | Queue messages to coding agents until a future timestamp or plan reset window, timer cleanup, daemon client. | `defer.shared.ts`, `store.server.ts`, `engine.server.ts` | Durable persisted queue; bundle-boundary checks. |
| [tell-agent](https://github.com/omercnet/paseo-plugins/tree/main/tell-agent) &bull; [cafe](https://paseo.cafe/plugins/tell-agent) | Inter-agent messaging and orchestration across different workspaces. | `client/`, `server/` | Requires Paseo 0.8.x. |
| [send-to-paseo](https://github.com/tomgrin10/send-to-paseo/tree/main/plugin) &bull; [cafe](https://paseo.cafe/plugins/send-to-paseo) | Local daemon HTTP bridge listening for browser extension clicks to create PR worktrees automatically. | `plugin/server/`, `plugin/client/` | Companion Chrome extension; requires `git` on daemon. |
| [discord-rich-presence](https://github.com/sleeyax/paseo-plugins/tree/main/plugins/discord-rich-presence) &bull; [cafe](https://paseo.cafe/plugins/discord-rich-presence) | Daemon-side local IPC socket connection to Discord desktop client for live rich activity presence. | `plugins/discord-rich-presence/` | Linux and macOS; Discord must run on same machine. |
| [paseo-display-switcher](https://github.com/nerveband/paseo-display-switcher) &bull; [cafe](https://paseo.cafe/plugins/paseo-display-switcher) | Keyboard shortcuts (`⌘K`) and Command Center triggers to switch sidebar view modes. | `client/` | Private host state workarounds (reference only). |

---

## 8. Themes and appearance

Plugins contributing custom semantic palettes (`client.addTheme`).

| Plugin & links | Study for | Useful locations / implementation | Caveats & platforms |
| --- | --- | --- | --- |
| [catppuccin-theme](https://github.com/sleeyax/paseo-plugins/tree/main/plugins/catppuccin-theme) &bull; [cafe](https://paseo.cafe/plugins/catppuccin-theme) | Adds 4 theme variations (Latte, Frappé, Macchiato, Mocha) via static `addTheme` registrations. | `plugins/catppuccin-theme/index.client.tsx` | Pure client theme registration. |
| [paseo-dracula](https://github.com/omercnet/paseo-plugins/tree/main/paseo-dracula) &bull; [cafe](https://paseo.cafe/plugins/paseo-dracula) | Dracula Classic and Alucard Classic theme palettes for Paseo. | `index.client.tsx` | Pure client theme registration. |

---

## 9. Official Paseo v0.8 plugin examples

Official example plugins from the [getpaseo/paseo v0.8.0 repository](https://github.com/getpaseo/paseo/tree/v0.8.0/plugin-examples):

- [Paseo settings example](https://github.com/getpaseo/paseo/tree/v0.8.0/plugin-examples/settings): Contributes dedicated settings screens via `client.addSettingsScreen({ id, title, icon, Component })`.
- [Paseo modal-ui example](https://github.com/getpaseo/paseo/tree/v0.8.0/plugin-examples/modal-ui): Demonstrates modal layouts, scrolling (`scrollable={false}` with custom `ScrollView`), and clipboard actions (`client.clipboard.copyText`).
- [Paseo lifecycle-actions and lifecycle-logger](https://github.com/getpaseo/paseo/tree/v0.8.0/plugin-examples): Demonstrates observing and customizing agent and workspace lifecycle events (`server.agents.onAgentCreate`, archiving hooks).
- [Paseo agent-configuration](https://github.com/getpaseo/paseo/tree/v0.8.0/plugin-examples/agent-configuration): Shows customizing agent parameters and config on the server.
- [Paseo provider-direct](https://github.com/getpaseo/paseo/tree/v0.8.0/plugin-examples/provider-direct): Complete coding agent provider implementation via `server.registerProvider(createProvider())`, models/modes catalog, session lifecycle, composer toggle/select settings, turns, steering, and history replay.
- [Paseo provider-acp-transformer](https://github.com/getpaseo/paseo/tree/v0.8.0/plugin-examples/provider-acp-transformer): Adapting a command-backed ACP agent using `runAcpProvider()` from `@getpaseo/plugin/server/acp` with `AcpTransformer` hooks.
- [Paseo inline-thinking](https://github.com/getpaseo/paseo/tree/v0.8.0/plugin-examples/inline-thinking): Demonstrates custom timeline renderers independent of provider implementations.
- [Paseo timeline-items](https://github.com/getpaseo/paseo/tree/v0.8.0/plugin-examples/timeline-items): Canonical `addTimelineTransformer` and `addTimelineRenderer` contribution patterns.

---

## 10. Local plugins in this repository

Reference implementations maintained within this repository:

- [pi-plugin-mcowger](../pi-plugin-mcowger/README.md): Embedded coding agent provider for pi via `@earendil-works/pi-coding-agent`. See [Packaging Guide](../pi-plugin-mcowger/docs/packaging.md) for bundling large SDKs under Paseo's daemon boundary checker.
- [colorful-agent-activity](../colorful-agent-activity/README.md): Timeline transformer replacing reasoning and tool-call rows with dense IDE cards, Prism syntax highlighting, and automated Hermes mobile bundle tests.
- [opencode-session-overview](../opencode-session-overview/README.md): OpenCode agent activity pane showing native session ID, usage, context window, and subagent state.
- [subagent-activity](../subagent-activity/README.md): Hierarchical subagent activity pane tracking managed descendants and provider-native child agents.
- [session-summary](../session-summary/README.md): Agent-scoped session summary panel with token metrics and markdown export.
- [reasoning-display](../reasoning-display/README.md): Expandable markdown renderer for provider reasoning blocks.
- [pi-tasks-timeline](../pi-tasks-timeline/README.md): Interactive timeline transformer for `todo` tool results.
- [scratch-chat](../scratch-chat/README.md): Disposable temporary chat surface with composer pill integration.
