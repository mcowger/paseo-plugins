# pi-plugin-mcowger: daily-session parity plan (NG)

Goal: bring `pi-plugin-mcowger` to **daily-session parity** with the in-tree Pi
provider for personal daily-driver use. Not literal full parity.

## Sources of truth

- Upstream: `~/workspace/paseo/packages/server/src/server/agent/providers/pi/`
  (`agent.ts` + `cli-runtime.ts`, `history-mapper.ts`, `session-descriptor.ts`,
  `tool-call-mapper.ts`, `usage-poller.ts`, `rewind.ts`, `runtime.ts`, `rpc-types.ts`).
  Every ported file diffs against its upstream counterpart before editing
  (diff-on-touch, see item 0).
- Technique reference (learn, do not duplicate): `paseo-omp` in
  `github.com/omercnet/paseo-plugins` (0.9-era direct provider, ~19k lines in
  `server/provider/`, written parity audit in its `TESTING.md`).

## Settled decisions

| Decision | Verdict |
|---|---|
| Goal | Daily-session parity: everything visible in live sessions matches in-tree; host plumbing deprioritized |
| Quality bar | Personal daily driver |
| Anti-drift discipline | Diff-on-touch, enforced by the AGENTS.md rule (item 0) |
| Ranking | Session-visible correctness first |
| Profile pill | Delete `client/pi-profile-pill.tsx`, `client/pi-profile-indicator.ts` (+ test); keep `shared/tool-policy.ts` + server side |
| MCP config | Deliberate divergence: keep always-write, no adapter probe |
| SDK target | 0.9.x (including betas) allowed; pin bump rides with item 3 |
| Out of scope | Permissions work (`ask_user` port, 0.9 typed permissions) · MCP transport inversion · dev-safety `.paseo-dev` rule · literal full parity |
| Scale warning | Reference provider is ~19k lines vs our ~2.5k; the deferred list is allowed to stay deferred |

## Already ahead — no action

Tool-policy system, microgpt fast/long-context, runtime-settings pill.

## Item 0 — Discipline enabler (do first, trivial)

Add a standing rule to `pi-plugin-mcowger/AGENTS.md`: before editing any ported
file, diff it against its upstream counterpart and port what's missing. Record
deliberate divergences in the same file so future diffs don't "fix" them:

- `server/mcp-config.ts`: always-write (no adapter probe) — intentional.
- Minimum pi binary floor: name the tested releases; formalize the existing
  `COMPAT(...)` comment instinct.

## Session-visible work, in order

### 1. Tool-call mapper port

- `server/tool-call-mapper.ts` ← upstream `tool-call-mapper.ts` (~500 lines + its tests).
- Biggest visible delta today: no `ls`/`task` kinds, legacy `old_string` edits
  unhandled, naive `mcp` naming, no xdev unwrap, zero validation.
- Port the Zod-validated trackers, `resolveToolCallOutput`,
  `mapWriteToolDetail`, `mapLsToolDetail`, `mapTaskToolDetail`. Borrow
  paseo-omp-style defensiveness where cheap (reject malformed provider ids),
  but keep upstream's structure so diff-on-touch keeps working.

### 2. Image gating

- Prompt path ← upstream `convertPromptInput`/`piModelSupportsImageInput`,
  built to the paseo-omp `image.ts` standard.
- Capable models get image blocks; text-only models get content-addressed
  local files with hint text.
- Include what upstream lacks: magic-byte payload validation, sha256 dedup,
  aggregate byte budget, private file modes, cleanup on turn/session end.
- Cap sizes to pi-scale (don't blindly copy OMP's 16MB — pick at port time).

### 3. Entry-capture extension + rewind correctness (carries the 0.9.x pin bump)

- `createPaseoExtension` + `revert()` ← upstream extension markers +
  `revertPiConversation`, upgraded to the paseo-omp token design.
- Port `paseo_capture_entries` / submitted-entry markers first (fixes history
  linkage as a side effect).
- Replace raw-id revert with opaque minted tokens
  (`<id>-revert:<base64url>`, regex-validated, server-side map to entry ids)
  using the 0.9 `revertToken` timeline field.
- Do the SDK pin bump to 0.9.x as part of this item.

### 4. History replay fidelity

- `replayHistory()` ← upstream `history-mapper.ts` (`PiHistoryMapper` + `streamHistory`).
- Real `messageId` linkage via captured entries (unblocked by item 3),
  `custom`/`bashExecution` roles, caller hooks.
- Kill the synthetic `history-user-N` ids.
- Adopt paseo-omp-style replay budgets (message/byte/node caps) as guardrails.

### 5. `/autocompact` handling

- `session.ts` ← upstream autocompact parsing, extracted toward a dedicated
  class per paseo-omp `session-compaction.ts`.
- `on`/`off`/state-backed `toggle`; invalid state fails visibly.
- Shape: small `PiSessionCompaction` class owning trigger state,
  retry/skipped/canceled outcomes, and usage refresh — don't grow the inline version.

### 6. Usage poller upgrade (with scheduler seam)

- Naive 3s timer ← upstream `usage-poller.ts`, plus paseo-omp behavior:
  generation guards, change-dedup, completion flush, poll-error path,
  stale-generation rejection, final-deadline flush.
- Put emission behind an injectable scheduler seam (their
  `OmpTimelineScheduler` pattern) so it's fake-timer testable.

### 7. Turn-completion state machine

- `session.ts` turn lifecycle ← paseo-omp `session-terminal.ts` pattern:
  - Authoritative `agent_end.requestId` matching; mismatch discarded before
    turn state changes.
  - Ordered-evidence legacy fallback for binaries that omit the field: fresh
    branch-correlated user entry, later current-turn assistant activity, idle
    non-compacting runtime, no conflicting permission/tool/steer work.
  - Exactly-one terminal guarantee; ambiguous-active terminals ignored;
    confirmed-idle ambiguity fails only the Paseo turn without killing the process.
  - `prompt_result.agentInvoked: false` stays local-only.
- Acceptance: adapted regression tests for sequential prompts, stale
  terminals, keyed mismatch/match, degraded state — mirroring their coverage,
  scaled to pi's RPC surface.

### 8. Per-model thinking map + label normalization

- `thinking.ts` + catalog ← upstream `transformPiModels`/`mapPiModel`.
- Honor `thinkingLevelMap`, correct defaults, normalized labels. Small; pair
  with item 7's terminal work since both read committed model state.

### 9. Streaming coalescing

- Timeline emission behind item 6's scheduler seam with ~32ms frame
  coalescing for `message_update` deltas (paseo-omp pattern).
- Keeps streaming smooth without changing item 4's snapshot semantics. Small
  once the seam exists.

### 10. Bounds + public-error convention

- New `server/bounds.ts`: byte-bounded ingress checks, `PiPublicError` vs
  internal errors (never leak internals to the client), NUL rejection,
  regex-validated ids (paseo-omp `security.ts` pattern, scaled down).
- Apply opportunistically via diff-on-touch, starting with connect-request
  and permission-adjacent inputs. Not a big-bang.

### 11. Delete the profile pill (standalone closer)

- Remove `client/pi-profile-pill.tsx`, `client/pi-profile-indicator.ts` (+ test).
- Verify no RPC becomes orphaned; prune only what's truly dead.

## Deferred backlog (touch only if needed)

- `sessions` list + import (upstream `session-descriptor.ts`; paseo-omp's
  budgeted-scan + first/last-preview pattern is the reference).
- `isAvailable`/diagnostics, `sessionDir` provider params via 0.9
  `providerOptionsSchema`, `rpc-ui`/`extraArgs`/`noSession` launch flags,
  refresh-deadline wiring, `cancelExtensionUiRequest`.
- 0.9 capability additions: `session.list`, `timeline.plugin`; real modes
  (`full`/`write`/`ask` shape with gating) replacing the `modes.ts` stub.
- Docker canary with mock LLM (aspirational E2E).

## Acceptance standard (every item)

Port with upstream's tests adapted, not just code. Keep file structure parallel
to upstream so diff-on-touch stays mechanical. Record each item's verdict in an
in-repo evidence matrix (paseo-omp `TESTING.md` pattern: behavior →
Equivalent / Unsupported / Protocol / Blocked → evidence). The matrix is the
definition of done.
