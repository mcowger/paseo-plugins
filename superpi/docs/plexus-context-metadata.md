# Plexus model-policy bridge

Implemented without changing Paseo or running Pi in-process. `plexus-pi` owns
policy metadata; the Superpi companion consumes its versioned event API.

## Current behavior

Superpi's companion applies the published short budget when `longContext` is
false and the published maximum when true. It uses a root-session clone through Pi's
public `setModel`; the catalog and child defaults aren't mutated. The old fixed
1,050,000 target has been removed.

The composer button and its two choices show rounded context lengths (`272K`,
`1M`), not On/Off. Its description shows
the short budget, maximum, and optional input pricing threshold. The control is
absent for models without a policy or with equal short/max budgets.

## Data path

1. Plexus publishes model context policy in `/v1/models`.
2. `plexus-models` preserves it in the normalized descriptor/cache.
3. `plexus-pi` publishes its current policy snapshot on Pi's public event bus.
4. `superpi-companion` looks up the selected provider/model and includes its
   policy in the existing `hello`/`get-state`/`configure` replies.
5. Superpi renders those values through its provider settings.

No new subprocess or RPC connection is needed. The companion control bridge is
already the root Pi-to-Paseo link. The subagent activity channel needn't carry
root model configuration.

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

The consumer subscribes to `plexus:context-policy:snapshot:v1` before requesting
`plexus:context-policy:request:v1` with `{version:1,requestId}`. It accepts
correlated immediate replies and broadcasts from the established publisher.
New publishers require correlation. Revisions cannot move backwards; snapshots
replace the complete policy list. Requests time out after one second. Invalid
or over-1-MiB snapshots are ignored; listeners/timers are cleaned up on shutdown.

With metadata available, Off selects the short-mode budget and On selects the
maximum capacity. No policy means retain Pi's declared budget and omit Long
Context. If the catalog refresh
removes or lowers a policy, re-evaluate the active model and report the new
applied state through session-key-scoped companion state notifications. Reject
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
  `packages/backend/src/config.ts`. Superpi consumes the published metadata;
  it doesn't introduce another backend limit or configure enforcement.
- Enforcement: `packages/backend/src/services/models/enforce-limits.ts`.
  It reserves output against the published context limit.
- Shared Plexus descriptors:
  `plexus-agent-plugins/packages/plexus-models/src/types.ts`.
- Pi model mapping and refresh:
  `plexus-agent-plugins/packages/plexus-pi/src/mapper.ts` and `src/extension.ts`.
- Public Pi bus: `pi/packages/coding-agent/src/core/event-bus.ts`.
- Companion state and application:
  `superpi-companion/src/protocol.ts`, `src/context-policy.ts`, `src/context.ts`,
  `src/policy-consumer.ts`, and `src/companion.ts`.

## Policy semantics

The implemented `plexus-pi` contract uses raw `context_length` as maximum and the
first `pricing.tiers[].input_tokens_above` boundary as the intended short budget.
Plexus defines that boundary for both purposes. Models without that boundary are
omitted. Superpi does not infer missing values or add provider beta headers.
There is no duplicate settings database or manual per-model override in Superpi.

## Service-tier policy

The same consumer lifecycle handles complete snapshots on
`plexus:service-tiers:snapshot:v1`, requested through
`plexus:service-tiers:request:v1`. Context/tier requests run concurrently at
startup. Per-model advertised names become the exact selector labels/values;
no policy means no tier selector or root injection.

The companion injects the selected advertised spelling as `service_tier` for
the `plexus` provider, including OpenAI Completions and Anthropic-compatible
requests. Plexus owns upstream field/value/header translation. This isn't a
claim that each tier has been accepted by every upstream backend.

Legacy `fast` migrates to `priority` when advertised. Saved tier intent survives
metadata loss and incompatible model switches. Effective fallback prefers
advertised `auto`, then `standard`; a premium-only list remains unselected until
the user chooses. Explicit new unadvertised selections fail. Children don't
inherit or inject root choices. See the
[companion README](../../superpi-companion/README.md#service-tier-lifecycle) for
the exact lifecycle and [testing](testing.md#policy-discovery-checks) for live probes.

The latest fresh Luna catalog check advertised `auto`, `standard`, `flex`,
`priority` and 272,000 / 1,050,000 token budgets. Astra's advertised tiers and
`flex` selection also passed live checks. Neither model observation is a
hardcoded fallback; catalog refresh is the authority.
