# Review of the current-limits survey

Reviewed against the five research reports in this directory. This review did
not repeat the source audit or independently verify the survey's session-log
analysis. The original [survey](CurrentLimits.md) remains unchanged.

The issue list is useful, but its closing summary understates what remains
broken. It mixes user-visible problems, source-level fixes, and proposed
solutions. These need to stay separate when defining Superpi requirements.

## Main findings

### The summary contradicts the survey

The summary says subagent terminal-state issues and reload crashes are resolved,
while sections 1.12–1.13 describe remaining failures.

The remaining problems aren't merely cosmetic:

- Runtime controls can interrupt active work.
- Cancel doesn't guarantee shutdown.
- Completed subagents can return to running.
- Daemon-launched sessions can lack required tools or environment.

These are execution and lifecycle problems, not presentation polish.

### Non-interrupting controls are a strong motivation for Superpi

Section 1.14 identifies an important distinction: Pi can handle extension
commands during streaming, but Paseo's routing prevents using that safely.

Pi extension commands still use the native RPC `prompt` command. Here,
"out-of-band" means bypassing Paseo's ordinary message/interrupt path, not a
separate Pi wire command.

A requirement should describe the outcome: changing service tier or querying
extension settings must not cancel, steer, or replace unrelated work. Pi's
`handled` disposition must not create a phantom model turn.

See [Pi prompt admission and settlement](04-pi-rpc-contract.md#prompt-admission-queues-and-settlement).

### Subagent completion isn't solved

Section 1.13 agrees with the research. Completion metadata normalizes `steered`
to completed, but later result collection exposes `steered`, which Paseo can
map back to running.

Other gaps worth preserving in the requirements discussion:

- Child transcript truncation.
- Missing nested ancestry.
- No restored control handles after restart.
- Private extension events not crossing RPC.

The section's "Residual reload race" heading is copied incorrectly. This is a
separate state-mapping issue.

See [existing native consumption and losses](05-personal-pi-plugins.md#existing-native-paseo-consumption-and-losses).

### Native support doesn't imply plugin support

Part 2 is a useful regression checklist, not an inherited implementation
baseline:

- Native rewind uses capabilities not directly exposed by core Pi RPC. `fork`
  isn't equivalent to in-place rewind.
- Native todo/subagent parsers are internal, not supported plugin imports.
- Durable parent history doesn't imply durable child control.
- The survey targets Paseo `0.11.0-beta.3`; this repository pins `0.10.0`.

Preserve desired behavior without assuming the native implementation is
reusable. See the [provider API version boundary](01-paseo-provider-api.md#scope-and-version-boundary)
and [Pi history seams](04-pi-rpc-contract.md#session-history-and-persistence-seams).

## Qualifications to the proposed borrowing patterns

| Survey section | Review |
| --- | --- |
| 2.2a: Transparent reload/retry | Safe only when we know the prompt wasn't accepted. Retrying after an uncertain disconnect can duplicate edits or tool execution. |
| 2.2b: Early terminal notifications | The research didn't establish premature notification as the current bug. The verified problem is inconsistent terminal-state interpretation. |
| 2.2c: Capability probing | Good direction, but `get_commands` isn't a generic extension capability registry. Subagent capability discovery needs an explicit contract. |
| 2.2f: Prerelease matching | Don't copy prerelease stripping universally. Compatibility policy must distinguish supported prereleases from unsupported versions. |
| 2.2h: Environment diagnostics | Useful for diagnosis, but displaying PATH doesn't fix propagation. Diagnostics must avoid exposing credentials. |

Two additional qualifications:

- Section 1.5 conflates strict-schema rejection with silently ignoring options.
  Those are different failure modes; keep observed behavior explicit.
- Section 1.8 needs to distinguish stopping the current turn, shutting down the
  Pi process, terminating children, and archiving the Paseo record.

## Input to requirements discussion

The strongest themes are:

- Predictable environment.
- Non-interrupting runtime controls.
- Reliable stop semantics.
- Correct subagent lifecycle.
- Extension observability and control.

Part 2 should become "behavior we must not regress," with each item marked as
source-supported versus exercised end-to-end. The survey's historical complaints
remain valid evidence even where newer code appears to address them.

These are inputs to the requirements discussion, not an approved architecture
or implementation plan.
