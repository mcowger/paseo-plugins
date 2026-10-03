# Superpi Stage 0 implementation contracts

Status: Stage 0 public-adapter gate results. This document records what was
verified against the public host/adapter contracts before implementation, and
the exported pure-timeline contract implemented in `server/timeline.ts`.

No Paseo core was modified. No Paseo internals were imported by plugin code.
Adapter evidence was read from the local checkout at
`~/workspace/paseo` (`v0.11.0-beta.3-13-g5293ddac3`, source report revision
`5293ddac3f17f35ea090b292447ec0498edafafe`) and from the installed npm beta
`@getpaseo/*@0.11.0-beta.3` in `superpi/.test-env/simple`. The repository dependency
baseline remains `@getpaseo/{client,plugin,protocol}@0.10.0`.

## Version boundary

| Surface | Version | Evidence |
| --- | --- | --- |
| Repository pins | `0.10.0` | root `.paseo-sdk.json`, plugin `package.json`s |
| Local adapter checkout | `v0.11.0-beta.3-13-g5293ddac3` | `~/workspace/paseo` `git describe` |
| Installed npm beta (test env) | `0.11.0-beta.3` | `superpi/.test-env/simple/node_modules/@getpaseo/*/package.json` |

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

Result: Superpi may publish tier/context controls through provider configuration
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
Superpi bridge must own emitting exactly one coherent terminal sequence per
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
Live Superpi checks confirmed that Pi's branch stayed correct across reload
while old rows remained visible. This violates design §8 step 8 and R5.5.

The user subsequently requested OMP's implementation approach. Superpi now
implements its navigation/configuration/replay sequence through public Pi APIs;
that request did not establish that the host's visible-history gap was fixed.

Not a workaround, for the record:

- Re-emitting active-branch snapshots after revert does not remove rows.
- A second `session.opened` for an existing provider session id is ignored by the
  runtime (`acceptProviderChild` returns early once `providerSessions` has the
  id) and does not reset history.
- Closing/reopening inside the revert request is not representable: the host
  holds the existing `agent.session` reference for the duration of `rewind`.

Blocker decision needed (owner: delegating agent/user): choose one of

1. Treat rewind as reopen-scoped only and require the host to reopen after a
   successful revert before the active history is authoritative (product scope
   change, needs host behavior that the current public adapter does not
   provide), or
2. Keep rewind out of V1 until a public timeline replacement/reset contract
   exists (aligns with requirements R5 and the stage-5 exit gate), or
3. Confirm an alternate supported replacement path not found here.

No Stage 5 (rewind) work should claim in-place history replacement until this is
resolved. Stages 0–4 are unaffected.

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
  - assistant message → `assistant:<responseId|messageId|timestamp>`
  - reasoning block → `reasoning:<nativeKey>:<contentIndex>`
  - tool call → `tool:<toolCallId>`
  - user message → `user:<clientMessageId|messageId|timestamp>`
  Replay and live records therefore share identities.
- `clientMessageId` correlation: a user message folded with
  `context.clientMessageId` uses `user:<clientMessageId>` and sets
  `item.clientMessageId`, so the host replaces its optimistic row.
- Usage: `message_update`/`message_end` usage is mapped to `ProviderUsage` and
  emitted as `session.usage` (deduplicated while unchanged). `turnId` is carried
  from `context.turnId`.
- Tool details: Pi tool name/args/result are mapped to the standard
  `ProviderToolCallDetail` variants (shell/read/edit/write/search/fetch/
  sub_agent/plain_text/plan) with an `unknown` fallback.
- `replay` resets active history and folds an authoritative Pi message array
  (e.g. `get_messages`) into the same identities, without emitting usage.

## Gate summary

| Gate | Result |
| --- | --- |
| Pre-agent feature discovery | Supported |
| Canceled read-only child status | Supported (clean-close overwrite caveat) |
| Post-`session.revert` history replacement | **Blocker** |
| Pure timeline folding + stable IDs + snapshots + usage + clientMessageId | Implemented and tested |
