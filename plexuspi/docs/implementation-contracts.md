# PlexusPi implementation contracts

Status: original Stage 0 public-adapter gate results plus the current exported
pure-timeline contract. Root controls, native commands, child observation, and
Pi branch rewind are implemented. Gate 3 remains an acceptance gap, not evidence
that rewind implementation hasn't started. See [current behavior](../README.md).

No Paseo core was modified. No Paseo internals were imported by plugin code.
Adapter evidence was read from the local checkout at
`~/workspace/paseo` (`v0.11.0-beta.3-13-g5293ddac3`, source report revision
`5293ddac3f17f35ea090b292447ec0498edafafe`) and from the installed npm beta
`@getpaseo/*@0.11.0-beta.3` in `plexuspi/.test-env/simple`. The repository dependency
baseline remains `@getpaseo/{client,plugin,protocol}@0.10.0`.

## Version boundary

| Surface | Version | Evidence |
| --- | --- | --- |
| Repository pins | `0.10.0` | root `.paseo-sdk.json`, plugin `package.json`s |
| Local adapter checkout | `v0.11.0-beta.3-13-g5293ddac3` | `~/workspace/paseo` `git describe` |
| Installed npm beta (test env) | `0.11.0-beta.3` | `plexuspi/.test-env/simple/node_modules/@getpaseo/*/package.json` |

The plugin SDK `ProviderEvent`/`ProviderTimelineItem`/`session.revert` union is
protocol version `1` and is unchanged between the `0.10.0` pin and the beta in
the inspected provider-file diff (report 1). The gates below only rely on
contracts present at `0.10.0`.

## Gate 1 — Pre-agent provider feature discovery: SUPPORTED

Draft composer features are fetched before any agent/session exists.

- Client: `~/workspace/paseo/packages/app/src/hooks/use-draft-agent-features.ts`
  (`useDraftAgentFeatures`) issues `client.listProviderFeatures(draftConfig)`
  keyed by `serverId`, `provider`, `cwd`, `modeId`, `modelId`,
  `thinkingOptionId`, and is enabled only when `draftConfig` exists.
- Client transport: `packages/client/src/index.ts:736` forwards to
  `daemonClient.listProviderFeatures(...)`.
- Server: provider feature lists are produced from the provider catalog/session
  configuration and surface as native composer controls
  (`packages/server/src/server/agent/plugin-provider.ts` config translation).

Result: PlexusPi may publish tier/context controls through provider configuration
and rely on pre-agent discovery. No new plugin UI is required for that gate.
The known limitation (remembered vs. explicit provenance is discarded before
submission) is unchanged and is already captured in report 1.

## Gate 2 — Canceled read-only child status: SUPPORTED WITH CAVEAT

A provider-owned read-only child can be marked canceled through the public event
vocabulary.

- `ProviderEvent` `session.turn` carries `state: "started" | "completed" |
  "failed" | "canceled"`.
- Adapter child mapping:
  `packages/server/src/server/agent/plugin-provider.ts` `acceptChildEvent`
  maps a non-started `session.turn.state` directly to the subagent status, so
  `canceled` reaches the host subagent store.
- Caveat: a later clean `session.closed` (no error) maps to `completed` and
  overwrites a previously canceled status. This is the inspected adapter
  behavior noted in report 1. The provider must not emit a clean close after a
  canceled child if it needs the canceled outcome to stay sticky.

Result: canceled status is expressible; no capability or event is missing. The
PlexusPi bridge must own emitting exactly one coherent terminal sequence per
child.

## Gate 3 — Conversation history replacement after `session.revert`: BLOCKER

A successful `session.revert` cannot replace the active conversation timeline for
a public plugin provider. The host replacement path exists, but it is fed by an
append-only provider history that a plugin cannot prune.

Verified chain:

1. `AgentManager.rewind` calls the provider revert capability, then, for
   conversation/both scopes, `hydrateTimelineFromProvider(agentId,
   { force: true, broadcast: true, broadcastTimeline: false })` and dispatches
   `timeline_replacement`.
   `packages/server/src/server/agent/agent-manager.ts` `rewind`.
2. `invokeRewindCapability` calls `session.revertConversation(...)`, which for a
   plugin provider is `PluginAgentSession.revert` →
   `ProviderRuntimeSession.revert` → `runtime.complete({ type: "session.revert" })`.
   `packages/server/src/server/agent/rewind/rewind.ts`;
   `packages/server/src/server/agent/plugin-provider.ts` `revert`.
3. The forced replacement path deletes the committed timeline and store, then
   re-records every timeline item yielded by `agent.session.streamHistory()`
   (`forceHydrateTimelineFromLegacyProviderHistory`).
4. For a plugin provider, `streamHistory()` only yields
   `PluginAgentSession.history`, which is append-only: it is populated from
   `bridge.history` plus every live event via `accept`/`publish`, and there is no
   public event, method, or adapter hook to clear or replace it.
   `packages/server/src/server/agent/plugin-provider.ts` `PluginAgentSession`,
   `streamHistory`, `publish`.
5. `ProviderEvent` has no timeline reset/replace event, and re-emitting
   snapshots only upserts rows. Abandoned-future rows already in `history` are
   therefore re-recorded by the forced hydration.

Consequence: after a successful `session.revert`, the in-place visible history
can still contain the abandoned future. Reopening creates a fresh provider
history mirror, but does not guarantee removal from Paseo's committed timeline.
Live PlexusPi checks confirmed that Pi's branch stayed correct across reload
while old rows remained visible. This violates design §8 step 8 and R5.5.

The user subsequently requested OMP's implementation approach. PlexusPi now
implements its navigation/configuration/replay sequence through public Pi APIs;
that request did not establish that the host's visible-history gap was fixed.

Not a workaround, for the record:

- Re-emitting active-branch snapshots after revert does not remove rows.
- A second `session.opened` for an existing provider session id is ignored by the
  runtime (`acceptProviderChild` returns early once `providerSessions` has the
  id) and does not reset history.
- Closing/reopening inside the revert request is not representable: the host
  holds the existing `agent.session` reference for the duration of `rewind`.

Current decision: expose the requested OMP-style Pi navigation with this visible
history limitation documented. This does not satisfy complete in-place history
replacement or make reopening a supported workaround. The remaining gate needs
a public host replacement/reset contract or a verified supported alternate path.
Do not patch Paseo, import production internals, or claim full R5 acceptance.

## Exported pure-timeline contract (`server/timeline.ts`)

`createTimeline({ sessionId, emit })` returns a deterministic, side-effect-free
folding object. It performs no I/O, spawns nothing, and only calls `emit` with
`ProviderEvent` objects.

```ts
interface Timeline {
  readonly sessionId: string;
  accept(record: unknown, context?: { clientMessageId?: string; turnId?: string }): void;
  replay(messages: readonly unknown[]): void;
  items(): readonly ProviderTimelineItem[];
  usage(): ProviderUsage | null;
  size(): number;
  reset(): void;
}
```

- Input records are Pi RPC JSONL records (`message_start`, `message_update`,
  `message_end`, `tool_execution_start`, `tool_execution_update`,
  `tool_execution_end`).
- Emitted timeline items are always complete `ProviderTimelineItem` snapshots.
  Updates reuse the item `id`; Paseo derives deltas from the snapshots.
- Stable identities:
  - assistant message → `assistant:<timestamp|messageId|responseId|unknown>`
  - reasoning block → `reasoning:<nativeKey>:<contentIndex>`
  - tool call → `tool:<toolCallId>`
  - user message → `user:<timestamp|messageId|unknown>`
  Replay and live records therefore share identities.
- `clientMessageId` correlation: a user message folded with
  `context.clientMessageId` sets `item.clientMessageId` for optimistic host
  correlation. It never forms the canonical item ID; native timestamp takes
  precedence so live/replayed identities remain stable.
- Usage: `message_update`/`message_end` usage is mapped to `ProviderUsage` and
  emitted as `session.usage` (deduplicated while unchanged). `turnId` is carried
  from `context.turnId`.
- Tool details: Pi tool name/args/result are mapped to the standard
  `ProviderToolCallDetail` variants (shell/read/edit/write/search/fetch/
  sub_agent/plain_text/plan) with an `unknown` fallback.
  - Tool-result `details` are part of that input: they are where Pi puts what a
    call actually did. An `edit` call carries `edits: [{ oldText, newText }]` in
    its args and the applied change as a unified `patch` on its result, so the
    result is what fills `detail.unifiedDiff`. Reading only the args left every
    edit row with a file path and nothing to expand. `details.diff` is Pi's
    trimmed view with line-number prefixes, not a unified diff, and is ignored.
    A lone `edits[0]` stands in as an old/new pair when no patch was reported;
    several edits do not, because one pair would understate the diff.
  - `write` is the same split in the other direction: the call carries the file
    and the result reports only that the write landed. The call wins, with the
    result text as the fallback.
  - `read` carries `offset`/`limit` (1-indexed start, line count), so the detail
    says when it is a slice rather than a whole file.
  - A sub-agent result names its child, which fills `childSessionId`; consumers
    need not parse it back out of the log text.
  - `bash` reports no exit code anywhere: its args are `{ command, timeout }` and
    its result details are null. A shell row cannot show one because it is not on
    the wire.
- A tool no branch handles still reports facts on its result. Those become a
  bounded, flat projection on `detail.output` (`{ content, details,
  detailsOmitted }`): scalars as-is, arrays and objects as counts, strings clipped
  to 120 characters, at most 12 fields and 1,000 characters. A renderer shows them
  as label/value rows behind a disclosure. This is deliberately not a JSON dump:
  an unparsed schema makes the reader decode it mid-scan, and the size cap is what
  keeps the timeline item small. A tool with a branch keeps its curated view and
  is never projected.
- Every tool whose result details are left unread is logged once per session, with
  key names and never values:
  `unconsumed tool details for "Agent" (agent): status, tokens, …`. This is the
  signal that a tool has structured output worth a real mapping. `DETAIL_USAGE` in
  `server/timeline.ts` is where a mapping declares what it reads (`consumed`) and
  what it drops on purpose (`ignored`, with a reason per key). Ignored keys stay
  out of the log: a log that reports decisions the maintainer already made stops
  being read, and then the line that matters goes unnoticed. The diagnostic is
  deliberately not a timeline item: it is a note to the maintainer, not content.
- A typed detail has fixed fields and the host strips anything else, so a fact with
  no field travels as `metadata.plexuspiFacts` on the tool call: the same bounded
  projection, restricted to keys nothing maps. That is how a sub-agent's status and
  token count, or a shell's truncation, reach the row at all. A shell reports
  truncation as a nested object, so it gets a view of its own
  (`truncated`, `totalBytes`, `totalLines`, `fullOutputPath`).
- The four detail shapes that `DETAIL_USAGE` and `TOOL_DETAIL_USAGE` account for,
  and why they are not parser candidates:
  - sub-agent: status, tokens, tool uses, duration, model name, and tags go out as
    facts; there is no field for them on the `sub_agent` detail.
  - `get_subagent_result` and `ask_user_question` have no branch, and their rows
    present the facts already (the supervisor view, the question/answer list).
  - shell truncation and the full-output path are reduced to the note the shell
    row renders.
- `structuredContent` does not reach a plugin provider, and needs no envelope to
  carry it. Pi's documented `ToolResultMessage` is `{content, details, isError, …}`
  with no such field, and its MCP client (`toLlmContent`) serializes structured
  content into a text block only when the server returned no content blocks. So:
  when structured content exists alone, it already arrives as text; when text
  exists, the text is the payload. Paseo's own MCP path does send
  `{content, structuredContent}`, which is why a renderer may handle that shape —
  that branch is not ours to feed.
- `server/tool-detail.fixtures.test.ts` replays one captured result per tool and
  asserts two things: the payload the row needs survives the mapping, and no
  detail key goes unaccounted for. A Pi shape change therefore fails a test and
  names the field, instead of quietly emptying a row — which is how the edit,
  write and todo payloads were lost before.
- The `todo` tool is not a tool row. Its result reports the whole list
  (`details.tasks`), which is emitted as a `type: "todo"` timeline item under
  `todo:<callId>`, the way Paseo's own providers present a checklist. A running
  call emits nothing (a placeholder would outlive it), and a call with no list
  falls back to a tool row so its outcome stays visible.
- `replay` resets active history and folds an authoritative Pi message array
  into the same identities, without emitting usage. Root restoration reads the
  owned transcript incrementally and selects active ancestry. Lifetime RPC
  `get_entries`/`get_messages` is a fallback for ephemeral sessions, not the
  primary growing-history transport. Resetting this provider-local fold does
  not reset the host's append-only history mirror.

## Gate summary

| Gate | Result |
| --- | --- |
| Pre-agent feature discovery | Supported |
| Canceled read-only child status | Supported (clean-close overwrite caveat) |
| Post-`session.revert` history replacement | **Blocker** |
| Pure timeline folding + stable IDs + snapshots + usage + clientMessageId | Implemented and tested |
