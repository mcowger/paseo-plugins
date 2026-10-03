# Plexus context metadata bridge

Feasible without changing Paseo or running Pi in-process. This is an assessment,
not an implemented metadata integration.

## Current behavior

Superpi's companion clones the current Pi model with a context budget of
`max(model.contextWindow, 1_050_000)`. It applies that clone to the root session
through Pi's public `setModel`. The catalog and child defaults aren't mutated.
The 1,050,000 target came from the previous microgpt integration, not a Plexus
capability lookup. Turning it on doesn't establish that a backend accepts it.

The composer now shows On/Off and the observed Pi budget. Its description shows
the baseline and target. Superpi preserves those companion fields and refreshes
them after model changes instead of retaining the old model's limits.

## Recommended path

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

- **Maximum context tokens:** the backend's actual total context capacity.
- **Short-mode budget tokens:** the intentionally smaller budget used when Long
  Context is off, at or below maximum capacity.
- **Pricing threshold input tokens:** where input pricing changes. This is not
  necessarily a safe total context budget; output reservation and compaction
  headroom still matter.

A minimal versioned policy row would contain `provider`, `modelId`,
`maxContextTokens`, and `shortContextBudgetTokens`, with an optional
`pricingThresholdInputTokens`. Validate positive integer limits and
`shortContextBudgetTokens <= maxContextTokens`. Use exact provider/model keys,
not display names or heuristics based on vendor strings.

`plexus-pi` should own publication, since it already has the model snapshot and
refresh lifecycle. Pair a snapshot event with a request event so a companion
loaded after the initial publication can ask for the current snapshot. Give
snapshots a revision and replace them atomically. A catalog refresh should
publish a replacement, including removed policies, not merge stale rows forever.
Keep the snapshot bounded and free of credentials.

With metadata available, Off selects the short-mode budget and On selects the
maximum capacity. No policy means retain Pi's declared budget and show Long
Context as unavailable; don't fall back to 1,050,000. If the catalog refresh
removes or lowers a policy, re-evaluate the active model and report the new
applied state. Reject enabling expansion when model application fails.

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
  `packages/backend/src/config.ts`. Currently there is only one context limit.
- Enforcement: `packages/backend/src/services/models/enforce-limits.ts`.
  It reserves output against the published context limit.
- Shared Plexus descriptors:
  `plexus-agent-plugins/packages/plexus-models/src/types.ts`.
- Pi model mapping and refresh:
  `plexus-agent-plugins/packages/plexus-pi/src/mapper.ts` and `src/extension.ts`.
- Public Pi bus: `pi/packages/coding-agent/src/core/event-bus.ts`.
- Companion state and application:
  `superpi-companion/src/protocol.ts`, `src/context.ts`, and `src/companion.ts`.

## Decisions before implementation

Agree on the short-mode budget semantics, whether expansion needs provider flags
(for example a beta header), and what budget children use by default. Prefer
Plexus-backed metadata over a second per-model settings database in Superpi.
Manual overrides can wait unless there is a model source that cannot publish
policy metadata.
