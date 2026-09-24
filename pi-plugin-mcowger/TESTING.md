# pi-plugin-mcowger testing evidence matrix

Parity plan: `docs/NG.md`. This matrix is the definition of done (paseo-omp
`TESTING.md` pattern): every NG item records Behavior → Classification →
Evidence. Allowed classifications: **Equivalent**, **Unsupported**,
**Protocol**, **Blocked**.

## Item matrix

| Behavior | NG item | Classification | Evidence | Verification |
|---|---|---|---|---|
| Diff-on-touch discipline + divergence registry | 0 | Protocol | `AGENTS.md` diff-on-touch rule; `docs/NG.md` restored from `e58e3f0` | `npm run lint`, `npm run typecheck`, `npm test` |
| Tool-call mapper port (`ls`/`task` kinds, `old_string` edits, `mcp` naming, xdev unwrap, validation) | 1 | Equivalent | `server/tool-call-mapper.ts` ports upstream trackers, Zod schemas, `resolveToolCallOutput`, `mapWrite/Task/Ls` details, legacy edit normalization, xdev unwrap; plugin-only `apply_patch` mapping preserved; retired `subagent`/`spawn_agent`/coordination shapes degrade to unknown | `npm test` (10 files, 63 tests) |
| Image gating (prompt path, magic-byte validation, sha256 dedup, byte budget, private modes, cleanup) | 2 | Equivalent | `server/image.ts` (`validatePiImagePayload`, `PiImageMaterializer`, `convertPromptImages`, `piModelSupportsImageInput`); wired into `server/session.ts` prompt + steer with release on failure/terminal/interrupt/close; 2 MiB per-image / 8 MiB aggregate divergence recorded below; 14 image unit tests + 5 session lifecycle tests (incl. rejected-while-active release regression) | `npm test` (11 files, 81 tests), `npm run lint`, `npm run typecheck` |
| Entry-capture extension + rewind correctness (opaque revert tokens, 0.9.x pin bump) | 3 | Equivalent | `server/rewind.ts` (opaque `pi-revert:` tokens, bounded map, upstream `revertPiConversation` shape) + `server/session.ts` (ported extension markers, capture/command-result waits, tokenized `revert`); `server/rewind.test.ts`, `server/extension.test.ts`, `server/session.test.ts`, `server/provider.test.ts` | `npm test` (12 files, 98 tests), `npm run lint`, `npm run typecheck` |
| Entry identity (`messageId` linkage via captured entries) | 3 | Equivalent | Submitted-entry markers emit live `user_message` rows with real `messageId`; `replayHistory` requests capture first and links rows to captured ids with `revertToken`; markers consumed internally | `server/session.test.ts` capture/replay tests |
| History replay fidelity (`messageId` linkage, `custom`/`bashExecution` roles, caller hooks, budgets) | 4 | Equivalent | `server/history-mapper.ts` ports upstream `PiHistoryMapper` + `streamPiHistory` (`getUserMessageText`, captured-entry-ordered `messageId`, `custom`/`bashExecution` roles, `mapCustomMessage`/`resolveToolCallId`/`mapToolDetail` caller hooks); `server/session.ts` `replayHistory` delegates to it with `mintRevertToken`/`mapToolDetail` hooks; opaque ids without capture (no `history-user-N`); 100k-message / 64MiB / 400k-node budgets throw `PiHistoryBudgetError` all-or-nothing; upstream `rpc-types` `user`/`custom` split adopted | `npm test` (13 files, 118 tests), `npm run lint`, `npm run typecheck` |
| `/autocompact` handling (`PiSessionCompaction` class, on/off/toggle, invalid-state failure) | 5 | Equivalent | `server/session-compaction.ts` ports upstream `parseAutoCompactMode` + `executeCompact/AutoCompactCommand` (`agent.ts`) as `PiSessionCompaction` (stable compaction id, first-trigger-wins, exactly-one terminal, manual ownership with completed/error/canceled/retry/skipped outcome space, injectable usage-refresh); `server/session.ts` publishes `compact` + `autocompact` and routes command + slash-text forms; `rpc-types.ts` unchanged (compaction event shape already covers upstream); 13 compaction unit tests + 6 session tests (upstream-adapted: off/text-form/unknown/toggle/unavailable/hint-preservation) | `npm test`, `npm run lint`, `npm run typecheck` |
| Usage poller upgrade (guards, dedup, flush, error path, stale-generation rejection, scheduler seam) | 6 | Equivalent | `server/usage-poller.ts` ports upstream `PiUsagePoller` + `PiUsagePollScheduler` + `toAgentUsage`/`isSameUsage`/`takeChangedUsage`/`completeTurn` verbatim (ProviderUsage instead of field-identical AgentUsage); `server/scheduler.ts` shared `PiScheduler` seam (`nodeScheduler` default, `createPollScheduler` adapter, reusable for item 9); `server/session.ts` replaces the naive 3s timer with the poller (`startTurn` on prompt, `stopTurn` on failed/canceled finish, bounded `completeTurn` flush on completed finish, `refreshNow` interim refresh on tool end / assistant message end / compaction + long-context sink, `close` invalidation); 10 poller unit tests (4 upstream-adapted + error-path/stale-poll/empty-stats/deadline/`refreshNow`) + 6 session wiring tests (periodic/flush/fail/cancel/close/tool-refresh) | `npm test` (15 files, 154 tests), `npm run lint`, `npm run typecheck` |
| Turn-completion state machine (keyed `agent_end` match, legacy fallback, exactly-one terminal) | 7 | Equivalent | `server/turn-terminal.ts` (pure `checkTerminalKey`/`decideLegacyTerminal`/`shouldHonorNoTurnAck` reducer) + `server/session.ts` (ack correlation, `prompt_result` buffering, early-terminal buffering, legacy evidence via `getState` + conflicting-work check, generation-guarded `finish`); `server/rpc-types.ts` gains forward-compatible `requestId` on `agent_end`/`agent_settled` | `npm test` (16 files, 179 tests), `npm run lint`, `npm run typecheck` |
| Per-model thinking map + label normalization | 8 | Equivalent | `server/thinking.ts` central `mapPiCatalogModel` (upstream `mapPiModel` + `transformPiModels`: slash-segment label, `normalizePiModelLabel` vendor/underscore normalization, full native id as description, `thinkingLevelMap`-filtered thinking, medium-then-above-then-highest default, `normalizePiThinkingOption`); shared by `catalog` RPC (`server/provider.ts`) and live `session.config` (`server/session.ts`, committed model/thinking re-read after configure); upstream advertises all levels vs plugin null-filter divergence recorded below; 8 thinking tests (upstream-adapted label/default/normalize/catalog cases) + 1 session configure-normalization test | `npm test`, `npm run lint`, `npm run typecheck` |
| Paseo 0.9 provider contract (SDK 0.9.0-beta.2, `revertToken` timeline field) | 3 | Protocol | Pins bumped to exactly 0.9.0-beta.2; `paseo-plugin.json` requires `>=0.9.0-beta.2`; `revertToken` used from real 0.9 types, no casts | `npm run typecheck`, `npm test` |
| Streaming coalescing (~32ms frame coalescing behind scheduler seam) | 9 | Equivalent | `server/stream-coalescer.ts` (`PiStreamCoalescer`: cumulative text/reasoning per stable timeline id, at most one ~32ms frame per active block via `server/scheduler.ts` seam reused from item 6, synchronous flush before message end / accepted terminal / interrupt / generation change / replay transition / close, stale-generation frames emit nothing); `server/session.ts` routes live `message_update` deltas through it while item 4 replay calls `timeline` directly (synchronous/uncoalesced); burst deltas emit one full snapshot with same item/message ids; 7 coalescer unit tests (frame budget, burst, interleaved, stable-id continuity, sync flush, stale generation, close) + 5 session wiring tests (burst, mixed + message-end flush, interrupt flush, close flush, replay-transition flush) | `npm test` (17 files, 203 tests), `npm run lint`, `npm run typecheck` |
| Bounds + public-error convention (`server/bounds.ts`, `PiPublicError`, NUL/id checks) | 10 | Equivalent | `server/bounds.ts` (16 MiB envelope fits the 8 MiB image turn after base64 overhead — measured in-test; 256 KiB nested persistence/settings/MCP/permission caps; `^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$` ids; 4096-byte NUL-free paths; serialization-free bounded walk rejecting over-depth/excessive-node/cyclic/non-JSON; `PiPublicError` vs fixed `Pi provider request failed` / `Pi prompt failed` messages); applied at the connection boundary (`provider.ts` envelope + connect/session/permission/revert/config ingress) and permission/revert/config validation (`session.ts`); 7 bounds unit tests + 3 provider boundary tests + 1 session boundary test | `npm test` (18 files, 214 tests), `npm run lint`, `npm run typecheck` |
| Delete the profile pill (remove pill + indicator + test, no orphaned RPC) | 11 | Unsupported | Deleted `client/pi-profile-pill.tsx`, `client/pi-profile-indicator.ts` + test, `server/active-profile.ts` + test; `index.client.tsx` contributes only the runtime-settings pill; `index.server.ts` registers only runtime-settings RPCs (profile/tool-policy RPC contracts retained untouched in `shared/tool-policy.ts` as data contracts); pre/post repo-wide symbol search confirmed no live importer of deleted modules | `npm test` (client bundle test: small + class-free), `npm run lint`, `npm run typecheck` |

## Intentional divergences (never "fix" on diff)

| Divergence | Upstream behavior | Plugin behavior | Rationale |
|---|---|---|---|
| MCP config | Adapter probe before write | `server/mcp-config.ts` always-write | NG settled decision |
| Paseo SDK | 0.9.0 baseline | Pinned to exactly 0.9.0 | NG settled decision |
| Pi binary floor | Assorted COMPAT floors | Minimum >=0.84.4, latest-tested 0.86.1 | Highest upstream floor (`clear_queue` in pi 0.84.4) |
| Image budgets | No built-in caps (OMP uses 16MB) | 2 MiB per image, 8 MiB aggregate per turn | pi-scale cap picked at port time |
| Final usage deadline | `completeTurn` awaits stats unbounded | Final stats read bounded by `FINAL_USAGE_WAIT_MS` (250ms, `finalWaitMs` override); deadline win drops the sample | paseo-omp final-deadline behavior; turn teardown never hangs on usage |
| Interim usage refresh | No mid-turn refresh beyond the 3s poll | Plugin-only `PiUsagePoller.refreshNow` (generation-guarded one-shot, never disturbs the schedule) for tool-end / message-end / compaction-sink refreshes | Keeps plugin responsiveness without diverging the ported poll loop |

## Deferred backlog (touch only if needed)

- `sessions` list + import (upstream `session-descriptor.ts`; budgeted-scan + first/last-preview reference).
- `isAvailable`/diagnostics, `sessionDir` provider params via 0.9 `providerOptionsSchema`,
  `rpc-ui`/`extraArgs`/`noSession` launch flags, refresh-deadline wiring, `cancelExtensionUiRequest`.
- 0.9 capability additions: `session.list`, `timeline.plugin`; real modes
  (`full`/`write`/`ask`) replacing the `modes.ts` stub.
- Docker canary with mock LLM (aspirational E2E).

Each deferred item, if touched, gains a matrix row with its verdict and evidence.

## OpenCodeReview pass (2026-09-21, session b29f6ec3)

`ocr review` over the NG workspace diff: 18 files reviewed, 65 findings.
All correctness/safety/UX findings were fixed with regression tests; pure-style
suggestions were applied where cheap. Notable fixes: `toolCalls` + projector
delegations now reset at turn end (previously blocked legacy terminals forever
after an interrupt), extension waiters cleaned up on send failure, replay
degrades to tokenless on capture failure, coalescer blocks cleared per turn,
pre-decode image sizing, ancestor-chain bounds walk (shared DAG refs no longer
rejected), poller callback guards + turn-keyed final usage, per-session marker
nonce, entry-id-keyed rewind map. Final gate: `npm run lint` clean,
`npm run typecheck` clean, `npm test` 17 files / 246 tests pass.
Follow-up round closed two more: reentrancy-guarded coalescer flush in the
shared `timeline()` funnel (buffered text can never be overtaken by tool
calls/notifications; collect-then-emit preserves insertion order) and a single
`assertBoundedProviderInput` envelope path in provider dispatch.
