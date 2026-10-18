# Plexus model-policy bridge

Implemented without changing Paseo or running Pi in-process. The `plexus-pi` Pi
extension owns policy metadata and tier injection. PlexusPi reads its live
control state over the `plexuspi-control` command contract.

## Current behavior

The root session applies the published short budget when `longContext` is
false and the published maximum when true. `plexus-pi` does this through its
session-local model policy (a root-session clone via Pi's `setModel`); the
catalog and child defaults aren't mutated. The old fixed 1,050,000 target has
been removed.

The composer button and its two choices show rounded context lengths (`272K`,
`1M`), not On/Off. Its description shows
the short budget, maximum, and optional input pricing threshold. The control is
absent for models without a policy or with equal short/max budgets.

## Data path

1. Plexus publishes model context policy and advertised service tiers in `/v1/models`.
2. `plexus-models` preserves them in the normalized descriptor/cache.
3. `plexus-pi` maps the committed catalog advertisement for the active Plexus
   model. Its policy engine applies the budget and injects the selected tier.
4. `plexus-pi`'s root control module answers `hello`, `get-state`, `configure`,
   `rewind`, and `reload` through the `plexuspi-control` slash command. Replies
   and live `plexuspi:state:v1:` updates include the policy fields.
5. PlexusPi's `server/session.ts` maps that state into provider settings.

No new subprocess or RPC connection is needed. The control command over the
existing Pi RPC prompt channel is the only root Pi-to-Paseo control link. The
subagent activity channel doesn't carry root model configuration.

Keep three values separate:

- **Maximum context tokens:** the backend's advertised total context capacity,
  not independently probed capacity.
- **Short-mode budget tokens:** the intentionally smaller budget used when Long
  Context is off, at or below maximum capacity.
- **Pricing threshold input tokens:** where input pricing changes. This is not
  necessarily a safe total context budget; output reservation and compaction
  headroom still matter.

A versioned policy row contains `provider`, `modelId`,
`maxContextTokens`, and `shortContextBudgetTokens`, with an optional
`pricingThresholdInputTokens`. Validate positive integer limits and
`shortContextBudgetTokens <= maxContextTokens`. Use exact provider/model keys,
not display names or heuristics based on vendor strings.

With metadata available, Off selects the short-mode budget and On selects the
maximum capacity. No policy means retain Pi's declared budget and omit Long
Context. If the catalog refresh
removes or lowers a policy, re-evaluate the active model and report the new
applied state through session-key-scoped state notifications. Reject
enabling expansion when model application fails. Policy removal clears the
selection and restores the original catalog budget. Saved On intent survives
metadata loading/unavailability and is applied if a qualifying policy arrives;
a ready catalog without that policy clears it. Saved intent cannot manufacture
a budget for a model without policy.

Children have independent model selection and independent event buses. Their
own `plexus-pi` instances can consume the same backend policy. Do not inherit the
parent's toggle or session-local model clone. If child context state must appear
in Paseo later, attach the child's selected model/policy to its versioned bridge
records; that's separate from supplying root metadata.

## Existing source hooks

- Plexus `/v1/models`: `packages/backend/src/routes/inference/models.ts`.
  It emits `context_length` and pricing tiers, with ETag/Last-Modified support.
- Plexus policy definitions:
  `packages/backend/src/services/models/model-metadata-manager.ts` and
  `packages/backend/src/config.ts`. PlexusPi consumes the published metadata;
  it doesn't introduce another backend limit or configure enforcement.
- Enforcement: `packages/backend/src/services/models/enforce-limits.ts`.
  It reserves output against the published context limit.
- Shared Plexus descriptors:
  `plexus-agent-plugins/packages/plexus-models/src/types.ts`.
- Pi-side policy and tier injection (`plexus-pi`, `~/workspace/pi-stuff/plexus-agent-plugins/packages/plexus-pi`):
  `src/extension.ts` (catalog advertisement, `before_provider_request`),
  `src/policy.ts`, `src/context-policy.ts`, `src/service-tiers.ts`, and `src/short-names.ts`.
- Pi-side control (`plexus-pi`): `src/paseo-control/protocol.ts` (wire contract),
  `control.ts` (operations), `tier.ts` (saved-tier resolution), and `conflicts.ts`.
- PlexusPi state mapping: `shared/control.ts` (schema),
  `server/control-channel.ts` (request/reply correlation), and `server/session.ts`.

## Policy semantics

The implemented `plexus-pi` contract uses raw `context_length` as maximum and the
first `pricing.tiers[].input_tokens_above` boundary as the intended short budget.
Plexus defines that boundary for both purposes. Models without that boundary are
omitted. PlexusPi does not infer missing values or add provider beta headers.
There is no duplicate settings database or manual per-model override in PlexusPi.

## Service-tier policy

`plexus-pi` reads the advertised tiers for the active Plexus model from the
catalog. Tiers are not a fixed enum. The composer groups advertised `default`,
`auto`, and `standard` names into one `default` choice. It appears only when at
least one tier is advertised; all other tiers keep their names. Existing
advertised alias selections display as `default` without rewriting the stored
tier. No advertised tiers means no tier selector and no injection.

`plexus-pi` injects the selected advertised spelling as `service_tier` for the
`plexus` provider in `before_provider_request`, including OpenAI Completions and
Anthropic-compatible requests. Plexus owns upstream field/value/header
translation. This isn't a claim that each tier has been accepted by every
upstream backend.

Resolution (`plexus-pi` `resolveSavedTier`, mirrored by PlexusPi's
`resolveTierSelection` for explicit host selections):

- An advertised saved tier is kept.
- Legacy `fast` migrates to `priority`; legacy `default` migrates to `auto`.
- Otherwise the fallback is advertised `auto`, then `standard`.
- With neither advertised, the choice stays unselected (`default`), so a
  premium-only list (for example `priority` and `flex`) starts with no tier chosen.
- Explicit new selections that aren't advertised fail. Selecting `default` sends
  advertised `default`, then `auto`, then `standard`, in that preference order.

Saved tier intent survives metadata loss and incompatible model switches; it is
applied when metadata arrives. Children don't inherit or inject root choices.
The exact operations are in [testing](testing.md#policy-discovery-checks) for live probes.

The latest fresh Luna catalog check advertised `auto`, `standard`, `flex`,
`priority` and 272,000 / 1,050,000 token budgets. Astra's advertised tiers and
`flex` selection also passed live checks. Neither model observation is a
hardcoded fallback; catalog refresh is the authority.
