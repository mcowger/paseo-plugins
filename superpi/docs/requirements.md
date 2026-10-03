# Superpi V1 product requirements

Status: agreed requirements baseline, confirmed after the requirements interview
on 2026-10-03. This document authorizes neither implementation nor changes to Pi
or Paseo core. Architecture and an implementation plan are separate work.

## Product goal

Make Pi usable through Paseo without forcing runtime controls through ordinary
chat-message routing. The first-release priorities are non-interrupting controls
and reliable observation of owned subagents. Conversation rewind and normal
attachment handling are also release requirements.

Build for the personal configuration first, with explicit contracts that can be
extended later. Don't promise compatibility with every Pi extension family.

## Boundaries

- Run Pi as a subprocess speaking RPC. Don't embed its SDK in the Paseo plugin.
  Existing SDK use inside the owned subagent extension is a separate boundary.
- Do not modify Pi or Paseo themselves. A required Pi companion extension and
  changes to owned extensions are allowed.
- Use supported plugin APIs. Direct frontend/backend plugin RPC is allowed and
  should bypass ordinary chat routing when needed. It does not grant access to
  the built-in Pi provider's private runtime.
- Choose available Pi/Paseo versions that meet the requirements. No product
  version floor is predetermined. Any repository SDK-baseline change must be
  explicit; this document doesn't change the existing dependency pins.
- Avoid browser/host-internal hacks and keep client code mobile/Hermes-safe.
- Don't edit user configuration or broaden tool permissions silently.

## R1. Execution, resources, and readiness

1. Load normal Pi configuration, models, extensions, skills, and resources plus
   the explicit Superpi companion extension.
2. Use the daemon environment initially. Shell initialization and mise/project
   environment reconstruction aren't V1 requirements.
3. Report actionable executable, version, launch, resource, and extension errors
   without exposing credentials.
4. Require a successful companion capability handshake before session readiness.
   Missing, incompatible, or failed companion startup is a clear failure, not
   degraded chat mode.
5. The companion is the explicit owner of integration tier/context controls.
   Known competing owners cause startup failure with resolution instructions.
   Don't silently disable extensions or rewrite their configuration.
6. Conflict detection must state its limits: Pi doesn't expose a universal
   registry of all request-payload modifiers. Detect known/declared conflicts;
   don't claim complete detection of arbitrary extensions.
7. Optional unrelated extension failures should normally produce diagnostics,
   rather than fail the entire integration merely because an optional feature
   is unavailable.

## R2. Defaults and session configuration

1. Pi owns defaults as much as possible. Core settings use Pi configuration;
   companion-specific defaults live Pi-side rather than in a competing Paseo
   defaults system.
2. Honor the values Paseo's composer submits, including remembered preferences.
   Use Pi defaults when fields are omitted. Never silently override a displayed
   deliberate selection.
3. Runtime changes persist with that conversation, not as global defaults for
   new sessions. Restoring a conversation restores its saved settings.
4. Newly spawned children have independent model, thinking, tier, and context
   defaults. Child definitions and locks still apply; don't fall back to parent
   composer choices for unspecified child defaults.
5. Later parent changes don't propagate into running children.
6. Display confirmed configuration and distinguish it from the settings used by
   an already-in-flight response. A requested change isn't automatically proof
   the backend honored the requested tier.

### Agreed defaults compromise

The preferred behavior was "Pi defaults unless explicitly changed in this
draft." Paseo merges remembered and explicit choices before submission and does
not expose their provenance to providers or hooks. The agreed V1 compromise is
to honor composer values and use Pi defaults on omission, not build a separate
launch workflow or guess which choices were explicit.

## R3. Runtime controls

1. Use native composer model/thinking and provider feature controls first,
   including pre-agent draft selection wherever supported. Composer pills are
   secondary, not a substitute for pre-run configuration.
2. Provide one mutually exclusive tier selector: Default, Fast, Flex, Ultrafast.
   Send the selected request value through the applicable provider payload.
   Backend acceptance isn't a prerequisite: unsupported values may produce a
   normal request error. No exhaustive eligibility matrix is required for V1.
3. Provide a visible long-context toggle that applies the integration's expanded
   context setting. Backend acceptance isn't a prerequisite for exposing it.
   Report the configured budgeting limit honestly, not as verified backend
   capacity, and surface configuration or request errors normally.
4. Tier/thinking changes apply to the next provider request, including a
   continuation within the current turn. Don't interrupt an in-flight response.
5. Model changes use the simplest supported Pi behavior, provisionally the same
   next-request behavior. Don't build a custom deferred-model scheduler.
6. Preserve selected tier/context settings across model changes. Don't hide
   controls or proactively reset values because support is unverified. Attempt
   to apply the selection and surface any configuration or backend error.
7. Backend rejection surfaces as an error. No automatic tier/context fallback or
   dedicated fallback/retry action is required in V1.
8. Manual compaction is available only when idle. Pi's manual compaction aborts
   current work, so it must not be disguised as a non-interrupting busy action.
9. Queue interaction needs only existing Paseo UI capabilities. Don't add a
   dedicated queue view, editor, reordering, or individual-removal UI.
10. Direct plugin controls, where needed, must resolve the intended owned session,
    reject stale identities, and coordinate with provider lifecycle operations.
    Reflect relevant changes through supported provider events so Paseo and Pi
    don't maintain conflicting configuration truth.

### Deferred retry/auto-compaction toggles

Mutable auto-retry and auto-compaction controls were initially desired for V1.
The inspected Pi RPC setters write global settings; the public extension API
doesn't expose session-only setters. A new RPC endpoint alone doesn't fix that
semantic gap.

These mutable toggles are deferred unless a supported extension-only,
session-scoped solution is established. Do not patch Pi, embed its SDK, or
snapshot/restore global settings around sessions. Leave Pi-managed automatic
behavior governed by its configured defaults. Manual compaction remains in V1.

## R4. Subagent observation and history

1. Guarantee the owned `pi-subagents` integration only. Other families aren't a
   V1 compatibility commitment.
2. Use public provider subsessions and native Paseo child views for live activity
   and terminal outcomes. Avoid a second custom transcript interface unless a
   required behavior cannot be represented through supported native views.
3. Preserve stable run/session identities and spawning-tool association. Keep
   these identities distinct rather than equating a tool call with a Pi session.
4. Use the simplest truthful nesting representation. Preserve ancestry when
   supplied by the bridge; don't flatten grandchildren into direct children or
   change the extension's configured admission/depth rules for presentation.
5. Publish live messages/tools and accurate completion, failure, cancellation,
   and stopped/steered outcomes as appropriate to the host's vocabulary.
   Explain outcomes that need richer detail rather than inventing host statuses.
6. Terminal outcomes stay terminal. Later result collection or presentation
   updates must not reopen a finished child.
7. Completion reporting remains observable without waking the parent. Waiting
   for a result must not suppress the child's terminal report.
8. Retain complete durable supported activity through completion. Bound loading,
   rendering, and individual payloads, not the lifetime transcript. Identify any
   payload omissions explicitly and retain terminal status/result visibility.
9. Restore saved child history/results after restart, but don't claim live child
   handles or execution survived. Report lost/interrupted execution honestly.
10. Interactive child steering, targeted stop, independent chatting/configuration,
    and execution resume/restart controls aren't V1 requirements. Steering is a
    known future need.

## R5. Conversation-only rewind

1. Support native-style in-place conversation rewind through the companion's
   public Pi tree-navigation bridge. No new Pi session is required.
2. Rewind to before the selected user message. Don't automatically resubmit it.
3. Keep abandoned history on disk, but exclude it from the active conversation
   and future model context. Don't summarize the abandoned future.
4. Never roll back files as part of this operation.
5. Persist the rewound branch and refresh visible history so reopening preserves
   the rewind. Changing only the next model request's context is insufficient.
6. Reject rewind while owned children are active. Don't add targeted child
   cancellation merely to make rewind possible in V1.
7. On successful rewind, clear pending steering/follow-up input with explicit
   feedback. Don't replay old queued instructions onto the new branch.
8. Follow Paseo's native cancel-then-rewind flow for an active parent. Navigation
   must not race active compaction or other unsafe session operations.
9. Report partial outcomes honestly: Paseo may cancel the parent before the
   provider rejects rewind because children remain active. Don't imply that a
   rejected rewind left the parent run untouched.

## R6. Lifecycle and recovery

1. New Superpi conversations only. No native-provider agent conversion, transcript
   import, or migration requirement.
2. Persist parent identity, history, and session settings durably.
3. Frontend disconnect/reconnect, backgrounding, and tab switching don't stop
   live execution. Reconnect restores observation of surviving work.
4. Parent turn interruption leaves background children running.
5. Actual root session shutdown rejects new work and stops owned Pi/child work.
   Use existing Paseo lifecycle UI; don't add a dedicated shutdown action.
6. Closing a child tab is a presentation action, not targeted child cancellation.
7. Cleanup is idempotent and must cover session close, connection close, and
   plugin contribution teardown. Plugin reload can race orderly session-close
   delivery; don't depend on receiving that event before teardown.
8. After process failure, reopen saved history/settings on subsequent use, mark
   interrupted/lost work accurately, and require explicit new input. Never
   automatically replay uncertain admitted prompts or repeat tool execution.
9. Don't claim successful process/child termination when it cannot be confirmed.
   Report cleanup failures and escalation honestly.

## R7. Attachments, extension UI, and presentation

1. Provide normal Paseo image/file attachment parity. Compatible models receive
   image input; files remain accessible through the normal tool workflow.
   Explain text-only model limitations/fallbacks rather than claiming images
   were consumed. Displaying an image isn't the same as supplying model input.
2. Publish standard tool-call structures with maximum useful supported data,
   including arguments, results, details, diffs, errors, and stable identities.
   Existing presentation plugins own styling/rendering; no new rich-tool theme
   or bespoke tool renderer is required.
3. Support RPC blocking dialogs: select, confirm, input, editor, cancellation,
   timeouts where supplied, and editor prefill.
4. Surface notifications and extension/admission errors without interrupting or
   waking agent work. Companion control responses shouldn't appear as raw JSON
   notification noise.
5. Preserve token usage and available cost data. Label unverified tier-adjusted
   costs as estimates or unavailable; don't invent Ultrafast pricing.
6. Loading, unavailable, stale, and error states must be explicit.

## V1 non-goals and deferrals

- Pi/Paseo core changes or in-process SDK integration.
- Shell/mise environment reconstruction.
- Mutable retry/auto-compaction toggles under the currently inspected contracts.
- Generic extension settings discovery or arbitrary TUI component execution.
- Additional subagent extension families and interactive child controls.
- Resumable child execution or automatic replay after failure.
- Native-agent migration/import, Pi-native fork, and file rollback.
- New queue editing or dedicated shutdown UI.
- Bespoke todo/MCP integration work as a release gate. Normal loaded extension
  tool/result data and blocking dialogs still follow the relevant requirements;
  don't advertise unimplemented MCP policy bridges.
- Keyed status/text-widget UI and extension-requested editor updates.
- Verified billing totals or richer document extraction beyond normal attachments.
- iOS/Android device smoke tests as release gates. Client code must still remain
  native-safe and pass applicable automated bundle/Hermes checks.

## Acceptance criteria

Desktop/web is the required V1 smoke-test target. Tests should cover:

| Area | Required observable result |
| --- | --- |
| Startup | Missing companion or known owner conflict fails clearly; optional failures are visible; discovery starts no model work and leaves no live resources behind. |
| Draft configuration | Native composer selections reach the first request; omission uses Pi defaults; submitted remembered values aren't silently overwritten. |
| Live controls | Tier/thinking changes don't interrupt or replace the current response; the next request uses selected settings; tier/context controls remain visible and selections aren't silently reset on model changes. |
| Configuration durability | Resume restores session values; runtime changes don't rewrite configured Pi defaults; independent child defaults don't inherit parent choices. |
| Backend refusal | Unsupported tier/context selections may be attempted; configuration and backend errors surface normally without automatic fallback or replay. No backend-acceptance proof is required to expose either control. |
| Compaction | Manual compaction is unavailable while busy; idle compaction doesn't create a phantom user/model turn. |
| Children | Live tool/message activity appears in native child views; completion is sticky even when followed by a steered result; parent isn't awakened by reporting. |
| Long child history | Activity beyond the native prefix limits remains durable and recoverable; oversized payload omissions are explicit; final outcomes/results remain visible. |
| Rewind | Before-message active history/context is correct, abandoned future stays on disk, queued input is cleared visibly, no file rollback occurs, reopening preserves the branch. |
| Rewind guards | Active children prevent rewind; active-parent cancellation followed by a rejected rewind is reported accurately; compaction/navigation don't race. |
| Lifecycle | Parent interrupt preserves children; root shutdown stops owned work; child-tab closure doesn't stop execution; repeated cleanup is safe. |
| Recovery | Frontend reconnect preserves live work; plugin/Pi loss restores history with honest terminal outcomes and no automatic prompt replay. |
| Reload races | Cleanup works even when session-close delivery races plugin teardown; no stale UI request controls a replacement session. |
| Attachments | Image/file handling matches normal Paseo behavior and exposes model incompatibility accurately. |
| Dialogs/data | Dialog answers, cancellation, timeout, and prefill work; ordinary tool data remains usable by existing rendering plugins; errors and cost-estimate limitations are visible. |

Implementation validation must include the project's lint, typecheck, tests,
bundle-boundary checks, and applicable mobile/Hermes automated checks. Device
smoke tests on iOS/Android aren't required to declare this personal V1 usable.

## Remaining research and validation gates

These are implementation facts to establish, not product choices to silently
replace with guesses:

1. Verify tier request mapping and error propagation. Backend acceptance,
   including Ultrafast acceptance, isn't a release gate or eligibility-matrix
   requirement.
2. Validate application of the expanded context setting, local budgeting, and
   error propagation. Backend capacity verification isn't a release gate or a
   reason to hide the control.
3. Validate pre-agent feature discovery, session-only persistence, and complete
   child-history restoration through the selected host APIs.
4. Validate conversation rewind, branch persistence, history replacement, and
   queue clearing end to end through the companion/public provider contract.
5. Confirm selected versions and available public APIs before choosing dependency
   pins. No unsupported API or core patch may be assumed to close a gap.
6. Deferred toggles can only return to scope after a supported extension-only
   session-scoped solution is demonstrated and the scope change is confirmed.

## Evidence

The [survey](CurrentLimits.md) and [review](CurrentLimits-review.md) motivate the
requirements. The five research reports establish the main contracts:

- [Provider API](01-paseo-provider-api.md): configuration, subsessions, permissions,
  persistence, revert, and version boundaries.
- [Native integrations](02-paseo-native-pi-omp.md): parsing losses, lifecycle,
  MCP/dialog behavior, and native history handling.
- [OMP reference](03-omercnet-omp-reference.md): comparative subprocess-provider
  patterns, not evidence of Pi-native features.
- [Pi RPC](04-pi-rpc-contract.md): commands, admission/settlement, streams, UI, and
  missing core operations.
- [Owned extensions](05-personal-pi-plugins.md): subagent contracts, lifecycle,
  defaults, private state, and control integrations.

Additional targeted interview research used these local sources:

| Source | Finding |
| --- | --- |
| `colorful-agent-activity/shared/read-image.ts`, `server/read-image.ts`, `client/activity.tsx` | Existing client-to-server plugin RPC pattern, separate from ordinary agent prompts. |
| Paseo `packages/server/src/server/plugins/plugin-process.ts` | RPC handlers and provider connections share the plugin server runtime; owned live state can be coordinated. |
| Paseo `packages/plugin/src/server/provider.ts`, `server/src/server/agent/plugin-provider.ts:1130,1281,1615-1635` | Provider settings become native composer features; changes map to session configuration. |
| Paseo `packages/app/src/hooks/use-draft-agent-features.ts`, `feature-preferences.ts`, `composer/draft/workspace-tab.tsx` | Pre-agent feature discovery exists, but remembered/explicit provenance is discarded before submission. |
| Pi `packages/coding-agent/src/core/agent-session.ts:2430,2717,3202,3775`, `modes/rpc/rpc-mode.ts:470-549` | Model/thinking changes are session-only; manual compaction aborts; automatic retry/compaction setters persist global settings. |
| Pi `packages/coding-agent/src/core/extensions/types.ts:401-436`, `agent-session.ts:3915-4113`, `modes/rpc/rpc-mode.ts:322-346` | Companion command context can navigate the tree; core RPC has no standalone navigation command. |
| Paseo `packages/server/src/server/agent/providers/pi/agent.ts:744-760,1541-1566` | Native companion-style no-summary rewind and persisted branch marker. |
| Paseo `packages/server/src/server/agent/agent-manager.ts:1662-1832,3133-3194`, `plugins/index.ts`, `plugins/runtime.ts` | Root shutdown and native rewind flow; reload races and cleanup boundaries. |
| Owned `plexus-pi/src/service-tier.ts`, `pi-microgpt/src/index.ts` | Existing tier injection and local context expansion. Applying these settings doesn't prove backend acceptance; errors are surfaced normally. |

Paths prefixed Pi/Paseo refer to `~/workspace/pi` and `~/workspace/paseo`; owned
extension sources are under `~/workspace/pi-stuff`. Findings use the research
snapshots listed in the [index](README.md), not promises about arbitrary releases.
