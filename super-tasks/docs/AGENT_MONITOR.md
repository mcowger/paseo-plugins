# Agent Monitor

![Agent Monitor](images/agent-monitor.png)

The Agent Monitor panel lists every agent and subagent in the current workspace, nests subagents under their parents, and lets you inspect, steer, archive, or stop any of them without leaving the panel.

Source files:

- `src/agents/panel.client.tsx` - the panel itself (`WorkspaceSubagentsPanel`, `WorkspaceSubagentsBody`, `AgentCard`, `SubagentTranscriptView`, `ToolCallRow`, `TimelineEntryRow`).
- `src/agents/controls.client.tsx` - the reusable controls the panel composes (`AgentStatusIndicator`, `WorkingIndicator`, `AgentActionBar`, `SteerComposer`).
- `src/agents/control.shared.ts` / `src/agents/control.server.ts` - the RPCs the panel calls for cancellation and provider subagent data (see [ARCHITECTURE.md](ARCHITECTURE.md)).

## Opening the panel

The plugin registers the panel under the id `agent-monitor` (and the legacy alias `subagents`) with the title "Agent Monitor". Open it from:

- The workspace sidebar or the Explorer dock.
- Command center: **Open Agent Monitor** (`open-agent-monitor`) or **Open Agent Monitor in Explorer** (`open-agent-monitor-explorer`).

## Data model

Each row in the panel is a `SubagentViewModel` (defined in `subagents.client.tsx`). The important fields:

| Field                                  | Meaning                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `parentAgentId`                  | Identity and parent link. `parentAgentId` comes from the `paseo.parent-agent-id` agent label.                                        |
| `isMain`                               | `true` when the agent has no parent label.                                                                                           |
| `isProviderSubagent`                   | `true` for subagents reported by the provider (for example Claude Code task agents) rather than tracked as first-class Paseo agents. |
| `status`                               | `initializing`, `idle`, `running`, `error`, or `closed`.                                                                             |
| `requiresAttention`, `attentionReason` | Attention flag and its cause: `finished`, `error`, `permission`, or `null`.                                                          |
| `archivedAt`                           | Non-null when the agent is archived.                                                                                                 |
| `turnStartedAt`                        | Start of the active turn; drives the elapsed counter while running.                                                                  |
| `recentActivitySummary`                | One-line summary of the newest transcript item (assistant text, tool call, reasoning, error, or prompt).                             |

### How the list is built

`fetchAgentsForWorkspace` in `WorkspaceSubagentsBody` runs on mount, on every `paseo.agents.subscribe` event (debounced 400 ms), and on manual refresh:

1. Call `paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200 } })`.
2. Keep agents whose `workspaceId` matches the panel. Main agents and archived agents always pass. Subagents pass only when they are active, need attention, or are `closed`.
3. For each agent whose snapshot changed since the last fetch, refetch the last 20 projected timeline entries and derive `recentActivitySummary`. Unchanged agents reuse the previous view model so memoized cards do not re-render.
4. Call the `listWorkspaceProviderSubagents` RPC with every main agent id. Provider subagents map onto the same view model: `running` -> `running`, `failed` -> `error` + attention, `completed` -> `idle` + `finished`, `canceled` -> `closed`.
5. Sort: attention first, then running, then most recent activity.

## Hierarchical agent tree

The panel renders a tree, not a flat list. `agentTree` (a `useMemo` in `WorkspaceSubagentsBody`) groups filtered subagents by `parentAgentId`:

- A subagent whose parent is in the filtered list nests under that parent. Nesting is recursive, so a subagent's own subagents nest under it.
- A subagent whose parent is missing (archived or closed parent, or filtered out) becomes an orphan. Orphans render at the bottom under the label "Agents without a matching parent".
- Every main agent owns a child group even when it is empty; the group then shows "No active subagents" (or "No subagents match the filter").

`renderAgentNode` draws a card followed by its children in an indented, left-ruled group (`styles.nestedGroup`).

### Header chevron behaviour

The chevron on a card header does one of two things, chosen by whether the card owns children (`childSummary !== null`):

| Card type                                                    | Chevron action                     | How to open the thread              |
| ------------------------------------------------------------ | ---------------------------------- | ----------------------------------- |
| Owns children (main agents, subagents with nested subagents) | Folds or unfolds the child group   | The Thread button in the action bar |
| Leaf (no children)                                           | Toggles the inline thread directly | Chevron or the Thread button        |

While a child group is folded, the parent card shows a one-line summary: "N subagents - M running" with a status dot that is `running` when any child is running.

## Filter tabs

The summary strip at the top of the panel doubles as a tab list. Each tab shows a live count and selects a `SubagentStatusFilter`:

| Tab         | Filter value | Main agents shown                                                 | Subagents shown                                                        |
| ----------- | ------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Main agents | `main`       | All live main agents                                              | None (child groups show "No active subagents")                         |
| Subagents   | `all`        | All live main agents                                              | All live subagents, plus archived subagents whose parent is still live |
| Running     | `running`    | Live main agents with `status === "running"`                      | Live subagents with `status === "running"`                             |
| Attention   | `attention`  | Live main agents with `requiresAttention` or an `attentionReason` | Same rule for live subagents                                           |
| Idle        | `idle`       | Live main agents with `status === "idle"`                         | Live subagents with `status === "idle"`                                |
| Archived    | `archived`   | Archived main agents                                              | Archived subagents                                                     |

The default filter is `all`. The tree is rebuilt from the filtered lists, so a filter can turn a subagent into an orphan when its parent no longer matches.

Counts on the tabs:

- **Main agents**: live main agents.
- **Subagents**: live subagents plus archived subagents with a live parent.
- **Running**, **Idle**: live agents (main or sub) in that status.
- **Attention**: live agents with `requiresAttention` or a non-null `attentionReason`. The number turns to the warning colour when non-zero.
- **Archived**: all archived agents.

## Agent card

`AgentCard` (memoized) renders one agent. From left to right the header shows:

1. The chevron (see above).
2. `AgentStatusIndicator` from `agent-controls.client.tsx`: a 6 px dot coloured by `statusDotColor`. While `running` it becomes a rotating arc ring. Colour rules: permission -> warning, error -> danger, running/initializing -> blue, finished -> success, idle/closed -> muted.
3. Title, then `provider - model - relative time`. Main agents also show `Directory: <cwd>`. If `recentActivitySummary` exists it renders in italics on its own line.
4. Badges: an uppercase attention badge (`FINISHED`, `ERROR`, `PERMISSION`, or `ATTENTION`) when relevant, then the status badge (`archived` overrides the live status label).
5. `AgentActionBar`.

A red banner under the header (`cardErrorBanner`) shows the last error from a stop or archive action for that card.

### Action bar

`AgentActionBar` in `agent-controls.client.tsx` renders ghost icon buttons. Every button calls `event.stopPropagation()` so it does not trigger the header chevron.

| Button   | Icon            | Visible when           | Effect                                                                                                       |
| -------- | --------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Thread   | `ScrollText`    | Always                 | Toggles the inline transcript (`expandedAgentIds`).                                                          |
| Open tab | `ExternalLink`  | Always                 | Calls `openAgentInPaseoWorkspace(host.id, workspaceId, agentId)` to open the agent in a dedicated Paseo tab. |
| Steer    | `MessageSquare` | Always                 | Toggles the steer composer (`steerOpenAgentIds`). Opening it also expands the thread.                        |
| Archive  | `Archive`       | Agent is not archived  | Calls `paseo.agents.ref(id).archive()` then refetches. Disabled while archiving.                             |
| Stop     | Red square      | `status === "running"` | Calls the `cancelWorkspaceAgent` RPC. Disabled while stopping.                                               |

Provider subagents (`isProviderSubagent`) have no Paseo agent behind them, so Open, Steer, Archive, and Stop are wired to no-op handlers for those cards. Only the Thread button works.

## Transcript expansion

Expanding a card mounts `SubagentTranscriptView` under the heading "Live Transcript & Tools".

Data source:

- Regular agents: `paseo.agents.ref(id).timeline.refetch({ direction: "tail", limit: 150, projection: "projected" })`, then a live `timeline.subscribe` stream. A replacement event on that subscription means the epoch moved and the fetched page no longer matches, so the transcript refetches.
- Provider subagents: the `getProviderSubagentTimeline` RPC with `limit: 150`. No live subscription; reopen the thread to refresh.

Behaviour constants (top of the transcript section in `subagents.client.tsx`):

| Constant                   | Value | Effect                                                                                         |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------------- |
| `TRANSCRIPT_INITIAL_TAIL`  | 40    | Entries rendered when the thread opens.                                                        |
| `TRANSCRIPT_PAGE`          | 60    | Entries revealed per "Show N earlier" press.                                                   |
| `TRANSCRIPT_MAX_ENTRIES`   | 300   | Cap on entries kept in memory; older entries drop.                                             |
| `TRANSCRIPT_FLUSH_MS`      | 80    | Live events are batched into one render per window.                                            |
| `TRANSCRIPT_PIN_THRESHOLD` | 32    | Scroll distance (px) from the bottom within which new entries keep the view pinned to the end. |

`mergeTimelineEntries` keeps the list coherent as events arrive:

- A `tool_call` with a `callId` already in the list replaces that entry in place (running -> completed).
- Consecutive `reasoning` items concatenate into one block.
- Everything else appends.

Pressing "Show N earlier" unpins the view from the bottom so new entries no longer auto-scroll.

### Timeline entry rendering

`TimelineEntryRow` renders one entry by `item.type`:

| Type                | Rendering                                                            |
| ------------------- | -------------------------------------------------------------------- |
| `user_message`      | "User Message" label and text.                                       |
| `assistant_message` | "Assistant" label and text.                                          |
| `reasoning`         | "Reasoning Summary" box with a brain icon.                           |
| `todo`              | "Todos & Checklists" box; each item shows a checked or empty circle. |
| `error`             | Red "Error" box with the message.                                    |
| `tool_call`         | `ToolCallRow` (see below).                                           |

Other types render nothing.

## Tool call inspection

`ToolCallRow` shows a collapsed header: chevron, wrench icon, tool name, a one-line summary from `getToolCallSummary`, and a status badge (`completed`, `running`, `failed`, or other). The summary depends on `detail.type`:

| `detail.type`           | Summary                                    |
| ----------------------- | ------------------------------------------ |
| `shell`                 | First 60 characters of `command`           |
| `read`, `write`, `edit` | `filePath`                                 |
| `search`                | `query`                                    |
| `fetch`                 | `url`                                      |
| `sub_agent`             | `description` or `subAgentType`            |
| `plan`, `plain_text`    | First 60 characters of `text` (or `label`) |
| `worktree_setup`        | `branchName` or `worktreePath`             |

Press the header to expand the details. Rows appear only when the field exists on `detail`:

- **File**, **Query**, **URL**, **Description**: single-line rows.
- **Command**, **Output**, **Content**: code blocks. Output and Content are clipped to 12 lines.
- **Input**, **Result**: code blocks for `detail.type === "unknown"`, clipped to 10 lines. Non-string values are pretty-printed as JSON via `formatSafeObjectText`.
- **Error**: red-bordered code block when `toolCall.error` is set.

## Steering

Pressing Steer opens `SteerComposer` under the transcript. The composer adapts to the agent status:

| Agent status  | Helper text                                 | Placeholder                | Send behaviour                                                     |
| ------------- | ------------------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| `running`     | "Message is delivered into the active turn" | "Steer the active turn..." | `paseo.agents.ref(id).send(text, { activeTurnBehavior: "steer" })` |
| Anything else | "Starts a new turn"                         | "Send a prompt..."         | `paseo.agents.ref(id).send(text)`                                  |

Submit with the arrow button or Enter. Shift+Enter inserts a newline on web. The composer disables while sending, clears on success, and shows the rejection message inline on failure. The status check happens at send time from `agentsRef`, so a composer opened while the agent was running still sends correctly if the agent went idle first.

## Cancellation

The Stop button appears only while `status === "running"`. `handleStopAgent`:

1. Adds the id to `stoppingAgentIds` (button shows disabled).
2. Calls the `cancelWorkspaceAgent` RPC with `{ agentId }`.
3. On `{ ok: false, error }` or a thrown error, writes the message into `cardErrors` for that card.
4. On success, clears any previous card error.
5. Removes the id from `stoppingAgentIds`. The next agent list refresh also clears stale stopping ids for agents that are no longer running.

Cancellation interrupts the active turn only. The agent stays alive and idle, and a later prompt (for example from the steer composer) resumes it. The RPC has a 10 second timeout on the server side and returns `Timed out waiting for the daemon to cancel the agent` when the daemon does not answer. See [ARCHITECTURE.md](ARCHITECTURE.md) for how the RPC reaches the daemon.

## Empty, loading, and error states

- Loading with no agents yet: "Loading active subagents...".
- `paseo.agents.list` failure: "Unable to synchronize subagents" banner with a Retry button. Previously loaded cards stay visible.
- No main agents and no orphans: "No agents" with a hint that depends on the filter.
- Transcript load failure: "Timeline Error" box inside the card.
