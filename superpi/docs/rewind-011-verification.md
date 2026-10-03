# Rewind blocker verification — Paseo 0.11.0-beta.3

Status: independent verification of Gate 3 in `docs/implementation-contracts.md`
("append-only plugin adapter prevents live rewind history replacement") against
the **installed compiled npm host**, not the local source and not 0.10 types.

Verdict: **CONFIRMED BLOCKER.** No Paseo core was modified.

## Versions and evidence

| Surface | Value | How checked |
| --- | --- | --- |
| npm `@getpaseo/*` latest (stable) | `0.10.3` | `npm view @getpaseo/plugin version` |
| npm `@getpaseo/*` beta dist-tag | `0.11.0-beta.3` | `npm view @getpaseo/plugin dist-tags.beta` |
| npm plain `0.11.0` | **E404, unpublished** | `npm view @getpaseo/plugin@0.11.0 version` |
| Installed host (test env) | `plugin/server/protocol/client/cli` all `0.11.0-beta.3` | `superpi/.test-env/simple/node_modules/@getpaseo/*/package.json` |
| Local checkout | `v0.11.0-beta.3-13-g5293ddac3`, source rev `5293ddac3f17f35ea090b292447ec0498edafafe` | `~/workspace/paseo` `git describe` |
| Source vs beta tag (relevant files) | **identical** | `git diff --stat v0.11.0-beta.3..HEAD -- plugin-provider.ts agent-manager.ts rewind/rewind.ts provider.ts` → empty |

The version table in `implementation-contracts.md` says the installed npm beta is
at `superpi/.test-env/npm/node_modules/@getpaseo/*`. That path is stale; the
live isolated host is `superpi/.test-env/simple/node_modules/@getpaseo/*`. The
rest of that document's evidence is consistent with what is recorded here.

## Exact behavior

Provider timeline seeded with three rows:

| Row | timeline item |
| --- | --- |
| A | `user_message` `messageId=msg-A`, `revertToken` set |
| B | `assistant_message` |
| C | `user_message` `messageId=msg-C`, `revertToken` set |

Observed against the installed `0.11.0-beta.3` adapter (test output, see below):

1. `session.revertConversation({ messageId: "msg-A" })` succeeds and emits
   exactly one `session.revert` input with `token` for A and
   `scope: "conversation"`.
2. `PluginAgentSession.streamHistory()` **before** revert yields `[A, B, C]`.
3. `PluginAgentSession.streamHistory()` **after** revert still yields
   `[A, B, C]`.
4. Then `AgentManager.rewind` calls
   `hydrateTimelineFromProvider(..., { force: true })` →
   `forceHydrateTimelineFromLegacyProviderHistory`, which deletes the committed
   timeline/store and re-records every `streamHistory()` row. Because the source
   still has C, the forced replacement rebuilds `[A, B, C]`.

No `session.open`/`session.close` is sent during revert; the host keeps the same
`agent.session` reference. The one `session.open` in the probe is the original
`createSession`, not a reopen.

## Why (installed compiled refs)

Installed: `superpi/.test-env/simple/node_modules/@getpaseo/server/dist/server/server/agent/`

- `plugin-provider.js` `PluginAgentSession`
  - constructor `this.history = []`, then replays `bridge.history` and subscribes
    to live events.
  - `accept` (`~1057`): `this.history.push(next)` for every translated event.
  - `publish` (`~1260`): `this.history.push(event)` then emit.
  - `streamHistory` (`~940`): `for (const event of this.history) yield event`.
  - `revert` (`~1249`): resolves a revert token and awaits the bridge input; it
    never touches `this.history`.
  - `ProviderRuntimeSession.revert` (`~514`) and `publish` (`~640`) are equally
    append-only.
- `agent-manager.js`
  - `hydrateTimelineFromProvider` (`2141`) → `hydrateTimelineFromLegacyProviderHistory`.
  - `forceHydrateTimelineFromLegacyProviderHistory` (`2797`) iterates
    `agent.session.streamHistory()`, `deleteCommittedTimeline`, `timelineStore.delete`,
    then re-records the same rows.
  - `rewind` (`2145`) runs revert, then the forced hydration + `timeline_replacement`.

Local source (`~/workspace/paseo`, same revision as the tag for these files):
`packages/server/src/server/agent/plugin-provider.ts` `PluginAgentSession`
(L1092), `streamHistory` (L1196), `accept` (L1347), `revert` (L1558), `publish`
(L1570); `packages/server/src/server/agent/agent-manager.ts` `rewind` (L3133),
`forceHydrateTimelineFromLegacyProviderHistory` (L3985);
`packages/server/src/server/agent/rewind/rewind.ts` (L12).

## Public contract surface — no reset/replace path

Checked against installed
`superpi/.test-env/simple/node_modules/@getpaseo/plugin/dist/server/provider.d.ts`
(protocol version `1`):

- `ProviderEvent` has **no** `history.reset`/`history.replace`/`session.refresh`
  member. Full event set: `catalog`, `sessions`, `request.completed`,
  `request.failed`, `session.opened`, `session.ready`, `session.closed`,
  `session.runtime_failed`, `session.persistence`, `session.prompt_result`,
  `session.turn`, `session.usage`, `session.config`, `session.commands`,
  `session.permission`, `session.permission_resolved`, `session.notice`,
  `timeline.item`.
- `ProviderInput` has **no** history-replacement input. Revert is only
  `session.revert` with `scope: conversation | files | both`.
- `PROVIDER_CAPABILITIES` contains `session.revert.{both,conversation,files}`
  and nothing history/reset/replace-shaped.
- The only `history`-named value is the open-time replay mode
  `history: "replay" | "skip"`.

Session close/reopen does **not** help inside a rewind:

- A `session.opened` for an existing provider session id is ignored
  (`acceptProviderChild` returns early once `providerSessions` has the id), so it
  cannot reset `PluginAgentSession.history`.
- `session.closed` removes the runtime session mapping; it does not rebuild a
  fresh adapter history while the host holds the `agent.session` reference.
  A fresh `PluginAgentSession`/history is only built by
  `PluginAgentClient.openSession`/`resumeSession`, i.e. a host-driven
  `session.open`, which `AgentManager.rewind` does not perform.
- There is no public `session.refresh`/hook that accepts a replacement history.
  `agent.timeline.replacement` is a client/server protocol message emitted by
  the host after forced hydration; it is not a provider input.

## 0.11 launch/status capabilities

`ProviderRegistration` adds `command?`, `status?(request)`,
`getCatalogCacheKey?`, and `ProviderLaunch` (`command`, `args`, `env`) in the
0.11 beta. These govern process launch and availability only; none of them
accept or mutate session history. They do not change the conclusion above.

## Executable regression

`superpi/tests/rewind-host-contract.test.ts` runs the installed host adapter with
a mocked **public** `ProviderRegistration` and asserts:

1. `supportsRewindConversation` is true; A/B/C stream before revert.
2. `revertConversation("msg-A")` emits one `session.revert` with token A and
   `scope: "conversation"`, and does not reopen the session.
3. `streamHistory()` after revert is still `[A, B, C]` (the blocker).
4. The installed `provider.d.ts` exposes no reset/replace/refresh member or
   capability.

Run:

```sh
cd superpi
npx vitest run tests/rewind-host-contract.test.ts
```

The test skips when the isolated 0.11 host is absent (so the repo's 0.10 pinned
suite stays green) and can be pointed elsewhere with `PASEO_HOST_ROOT`. The
dynamic import of
`@getpaseo/server/dist/server/server/agent/plugin-provider.js` is test-only
evidence; production Superpi code must never import Paseo internals.

Validation: `npm run lint` passes (0 warnings, 0 errors); `npm run typecheck`
passes; `npm test` passes with this test included (7 test files at
verification time).

## Verdict

The `implementation-contracts.md` Gate 3 claim is independently reproduced
against the installed compiled `@getpaseo/server@0.11.0-beta.3`: a successful
rewind cannot replace live conversation history for a public plugin provider,
and no public reset/replace/refresh contract exists in 0.11.0-beta.3. The
blocker decision in that document is unchanged.
