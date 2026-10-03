# Superpi

Experimental Paseo provider for Pi. The root agent runs as a Pi RPC subprocess,
not through the in-process SDK. A required Pi companion owns tier/context
controls and tree navigation. The owned `pi-subagents` extension supplies the
child activity bridge.

Tested with Paseo **0.11.0-beta.3**, Pi **1.0.0+local**, and DeepSeek
`deepseek-v4.1-flash`. SDK dependencies remain pinned to the common 0.10.0 API;
that pin is not a claim that newer hosts are unsupported.

## Implemented

- Model/thinking selection, visible Default/Fast/Flex/Ultrafast tier choices,
  and a long-context toggle showing On/Off and the current Pi token budget.
  Settings apply to subsequent requests without
  interrupting a response. Backend errors are surfaced, not hidden behind an
  eligibility matrix.
- Private durable conversation handles and active-branch history restoration.
  Large histories are read from the owned Pi transcript instead of requesting
  one growing RPC response.
- **Superpi: Copy Pi resume command (stop session first)** in the agent command
  center copies a terminal command for the saved native transcript. Stop/detach
  the Paseo session before running it to avoid concurrent transcript writers.
- Native `/compact`, `/autocompact`, `/model`, `/thinking`, `/name`, and `/session`
  commands are listed and dispatched without sending them to the model.
  Terminal-only built-ins fail explicitly; extension commands keep precedence.
  Run slash commands while idle: Paseo may interrupt an active turn before
  dispatching them. `/autocompact` changes Pi's global preference, not just this
  conversation; project overrides may still take precedence.
- Image/text/file inputs, native blocking dialogs, and an editor-prefill screen.
  Open **Pi dialogs** from the command center (`Ctrl+K` on Linux).
- Read-only native child views, ordered live activity, terminal outcomes, and
  an append-only child journal. Final activity is durable; streaming updates
  aren't repeatedly appended to the journal.
- Independent child defaults and model budgeting, nested bridge propagation,
  parent interruption that preserves background children, and root cleanup.
- Conversation rewind using OMP's navigation/configuration/replay sequence,
  adapted to Pi's public tree-navigation API. No file rollback or automatic
  resubmission.

## Known limits

**This is not a declaration that every original V1 acceptance criterion passes.**

Paseo's published 0.11 beta keeps an append-only provider history mirror.
Superpi's rewind changes Pi's active branch correctly, but abandoned rows can
remain in Paseo's visible history. Reloading an agent does not guarantee their
removal. The limitation is covered by an executable host-contract test and
[verification notes](docs/rewind-011-verification.md).

Child journals retain activity beyond the host's cached-preview limits. A
synthetic 520-row, multi-megabyte history reached row 259 in the native view;
this does not establish every recovery/display path on every host version.

Direct steering, arbitrary TUI widgets, and MCP configuration/tool-policy
translation are not implemented. Nonempty MCP and exact preapproval requests
fail explicitly. Pi-managed retry defaults are left alone; `/autocompact`
controls automatic compaction and manual compaction is idle-only.

Daemon cleanup was tested on Linux. Windows descendant process-group cleanup
is not implemented.

Registry costs and expanded context windows are estimates/configured budgets,
not verified billing or backend capacity. Text-only models receive a visible
image-omission explanation rather than a claim that the image was analyzed.

Host API gaps, including the built-in resume menu and harmless child-outline
errors, are tracked in [PaseoShortcomings.md](docs/PaseoShortcomings.md).
The fixed expanded budget is not model capability discovery; a possible
replacement is described in [the Plexus metadata assessment](docs/plexus-context-metadata.md).

## Install

Install dependencies in both packages:

```bash
npm --prefix superpi ci
cd superpi-companion
bun install
cd ..
```

Place the companion at
`$PI_CODING_AGENT_DIR/extensions/superpi/index.ts`, including its `src/` and
runtime dependencies, or set the daemon environment's
`SUPERPI_COMPANION_PATH` to the companion's absolute `index.ts` path.
`SUPERPI_PI_COMMAND` optionally selects a Pi executable; the default is `pi`.
These are daemon settings, not shell initialization performed by the plugin.

Pi loads its normal resources plus the explicit companion. Known competing
tier/context owners cause a clear startup failure. Resolve that conflict in
your Pi configuration; Superpi does not disable extensions or rewrite defaults
for you. The current owned `pi-subagents` bridge changes are required for child
observation.

Use plugin CLI help before installation and reload:

```bash
paseo plugin install --help
paseo plugin install "$PWD/superpi"
paseo plugin reload --help
paseo plugin reload superpi
```

Select **Superpi** for a new Paseo conversation. Native-provider conversations
aren't converted or imported.

## Development and checks

```bash
npm --prefix superpi run lint
npm --prefix superpi run typecheck
npm --prefix superpi test
npm --prefix superpi-companion run lint
npm --prefix superpi-companion run typecheck
npm --prefix superpi-companion test
```

Client tests check bundle size, classes, server-boundary isolation, and Hermes
bytecode compilation. The host-contract test uses an installed beta host only
in tests, never as a production internal import.

For the isolated launch script and browser workflow, see
[testing](docs/testing.md). The original scope remains in
[requirements](docs/requirements.md), with the
[implementation plan](docs/design.md) and
[contract findings](docs/implementation-contracts.md).

The rewind adaptation retains OMP's MIT notice in
[`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES).
