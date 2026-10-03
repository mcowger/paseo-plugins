# Superpi documentation

These reports document the existing integration contracts before requirements or
design work. They describe what the inspected code does, where the integrations
meet, what information crosses those boundaries, and what gets lost.

The agreed integration boundary is a Pi subprocess speaking RPC. Embedding Pi in
the Paseo plugin through the in-process SDK is out of scope. The existing
`pi-subagents` extension's use of that SDK inside the Pi process is a separate
fact, not a change to this boundary.

## Requirements and issue survey

- [Agreed V1 requirements](requirements.md): scope, non-goals, acceptance criteria,
  contract-driven deferrals, and remaining validation gates.
- [Technical design and implementation plan](design.md): runtime boundaries,
  proposed integration contracts, lifecycle rules, and staged acceptance checks.
- [Independent testing environment](testing.md): copied Pi/extensions, npm beta
  Paseo, isolated config, and direct agent-browser checks.
- [Current-limits survey](CurrentLimits.md): historical problems and native
  behaviors worth preserving.
- [Survey review](CurrentLimits-review.md): contradictions, qualifications, and
  requirements implications from the existing research.

## Reports

1. [Paseo provider plugin API](01-paseo-provider-api.md). Registration, capability
   negotiation, session and prompt lifecycles, permissions, persistence, child
   sessions, timeline rendering, and the v0.10.0 compatibility boundary.
2. [Native Paseo Pi and OMP integrations](02-paseo-native-pi-omp.md). RPC adaptation,
   extension recognition, subagent parsing, transcript following, MCP and
   permission bridges, recent changes, and loss cases.
3. [omercnet's OMP provider plugin](03-omercnet-omp-reference.md). An advanced
   reference implementation, its transport and lifecycle safeguards, OMP-only
   capabilities, SDK compatibility shims, and private workarounds.
4. [Pi subprocess RPC contract](04-pi-rpc-contract.md). Framing, commands, responses,
   streaming events, settlement, session history, extension UI, process shutdown,
   and missing operations.
5. [Personal Pi plugins and subagents](05-personal-pi-plugins.md). The actual
   mcowger/tintinweb-compatible contract, execution and policy rules, notifications,
   persistence limits, and the other extensions' integration needs.

## Source snapshots

Research and documentation were collected on 2026-10-03 from local checkouts.
No remote repository was modified or fetched as part of this documentation work.

| Source | Local root | Revision |
| --- | --- | --- |
| Paseo, initial research | `~/workspace/paseo` | `d070db15b3eb710b84dd001c29cbbdc8266e675a`, `v0.10.0-60-gd070db15b` |
| Paseo, documentation verification | `~/workspace/paseo` | `5293ddac3f17f35ea090b292447ec0498edafafe`, `v0.11.0-beta.3-13-g5293ddac3` |
| Paseo target baseline | Same repository, tag `v0.10.0` | `c481ecf3e101326e3758d419341bc4faaf5b4f98` |
| Pi source (`earendil-works/pi`) | `~/workspace/pi` | `86dfceec402ad77e563bf4feab5f26c42d5f5db6`, `v1.0.0-1-g86dfceec4` |
| Active Pi build | `~/.local/share/path-overrides/pi-local` | Reports version `1.0.0+local`; not an exact git revision identifier |
| omercnet plugins | `~/workspace/omercnet/paseo-plugins` | `5f38b18ebdfe541d450a327e4fda5e9ebcd38cda` |
| Personal Pi plugins | `~/workspace/pi-stuff/pi-plugins` | `05f22e92e928c0b754ac24e1df8b9b8268528d31` |
| This repository, before reports | `~/workspace/paseo-plugins` | `eeae077` |

The Paseo checkout changed between the initial research and verification. Reports
use the verification snapshot unless they explicitly describe the older revision
or the v0.10.0 tag. Current source behavior is not automatically a promise about
the project's pinned `@getpaseo/*` 0.10.0 baseline.

## Reading the evidence

- Each report has a source map. Paths are relative to its stated repository root;
  line ranges refer to the pinned snapshot, not an arbitrary future checkout.
- Small code and JSON examples preserve the relevant fields but may omit unrelated
  fields. They are contract illustrations, not ready-to-run implementation files.
- Public Paseo plugin APIs, Pi RPC APIs, native Paseo internals, and private
  extension/file contracts are identified separately.
- Source inspection establishes behavior visible in the code. It does not prove
  end-to-end runtime compatibility, mobile rendering, or correctness under every
  extension combination.
- Existing tests and captured fixtures were inspected, but the external projects'
  test suites were not run for this research. The initial Pi RPC investigation
  included limited live probes; those observations are labeled in the RPC report.

## Corrections made during verification

The reports incorporate these corrections rather than copying the initial agent
summaries verbatim:

- Native Pi extension parsers run in the Paseo daemon, not in the client app.
- Native Pi parsers emit internal `provider_subagent` events. Public plugin
  providers use `session.opened` and other `ProviderEvent` values instead.
- The inspected native OMP subagent index associates children with a spawning tool
  but does not populate nested `parentSubagentId` ancestry. The OMP plugin has a
  different, child-session-based implementation.
- Pi here is `earendil-works/pi` 1.0.0, not an assumed historical `badlogic/pi-mono`
  release. Some fields described as undocumented in the first summary already
  appear in the current Pi documentation.
- Pi's lack of native subagent RPC events does not rule out a provider plugin
  implementing subsessions through extension metadata or file contracts.
- Personal subagents have no implemented concurrency queue or run-resume registry,
  despite some related vocabulary in types and presentation helpers.

The [V1 requirements](requirements.md) are agreed, and the [design and plan](design.md)
propose how to implement them. Exact supported versions and bounded implementation
choices remain to be verified. Research reports retain their original source
snapshots; no implementation has started.
