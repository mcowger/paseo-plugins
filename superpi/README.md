# Superpi

Experimental Paseo provider for Pi. The root agent runs as a Pi RPC subprocess,
not through the in-process SDK. A required Pi companion owns tier/context
controls and tree navigation. The owned `pi-subagents` extension supplies the
child activity bridge.

Tested with Paseo **0.11.0-beta.3**, Pi **1.0.0+local**, and DeepSeek
`deepseek-v4.1-flash`. SDK dependencies remain pinned to the common 0.10.0 API;
that pin is not a claim that newer hosts are unsupported.

## Implemented

- Model/thinking selection and service-tier choices discovered per model from
  `plexus-pi`, preserving advertised names. Models without tier support have no
  service-tier selector. Catalog refreshes and model changes update it live.
  A context-length selector shows rounded budgets such as `272K` and `1M` on
  the button itself, with short/max choices. It appears only for models with
  distinct short/max budgets supplied by `plexus-pi`. Internally, Off uses the
  short budget and On uses the maximum; the UI shows token lengths, not On/Off.
  Models without a short budget retain Pi's declared limit and have no context
  selector.
  Settings apply to subsequent requests without interrupting a response.
  Backend errors are surfaced, not hidden behind an eligibility matrix.
  Legacy Fast selections migrate to advertised `priority`; unsupported saved
  tiers use `auto` or `standard` while retaining the user's choice for compatible
  models. Premium-only lists remain unselected until the user chooses. Plexus
  handles upstream tier translation; Superpi sends the advertised spelling.
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

Registry costs are estimates, not verified billing. Context budgets come from
Plexus policy metadata, not a separate backend probe. Text-only models receive a visible
image-omission explanation rather than a claim that the image was analyzed.

Host API gaps, including the built-in resume menu and harmless child-outline
errors, are tracked in [PaseoShortcomings.md](docs/PaseoShortcomings.md).
The policy event contract and lifecycle are described in
[the Plexus context integration](docs/plexus-context-metadata.md).

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

The daemon must inherit the intended `PI_CODING_AGENT_DIR` and `PASEO_HOME`.
They default to `~/.pi/agent` and `~/.paseo`. Superpi stores private manifests,
native transcripts, and child journals under
`$PASEO_HOME/plugins/superpi/state`. Pi subprocesses inherit the daemon
environment plus per-session overrides. Configure the host explicitly; Paseo
doesn't discover an arbitrary copied Pi installation. The isolated launcher in
[testing](docs/testing.md) writes that config and sets these paths for you.

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
paseo plugin ls --help
paseo plugin ls superpi
paseo plugin logs --help
paseo plugin logs superpi
```

Select **Superpi** for a new Paseo conversation. Native-provider conversations
aren't converted or imported.

## Developing through SuperPi

Future work uses SuperPi itself with this repository as the workspace. The
provider label in Paseo remains **Superpi**.

1. Read [the docs index](docs/README.md), then the current limits here and in
   [Paseo shortcomings](docs/PaseoShortcomings.md). The numbered research reports
   are source snapshots, not a list of unfinished implementation tasks.
2. Run the checks below in both packages. Test changed runtime behavior in the
   [isolated daemon](docs/testing.md), not the daemon hosting your work session.
3. After companion edits, sync its copied source and open a fresh test Pi session.
   After provider/client edits, reload Superpi on the isolated host. Check plugin
   load state/logs and the actual UI, not just CLI request success.
4. Before updating the active host, save changes and leave the next session a
   summary of changed files, checks, and unresolved limits. Run the active-host
   reload from a separate terminal. Plugin reload closes owned Pi processes,
   including the one running this development conversation.

Do not replace the root subprocess with Pi's in-process SDK, patch Paseo core,
or add fixed model-policy fallbacks. Keep credentials in the daemon/Pi environment.
To move a saved conversation into terminal Pi, use **Superpi: Copy Pi resume
command (stop session first)** and stop/detach its Paseo session before executing
the command. Supply required credentials/environment separately; never run two
transcript writers at once. The copied command uses POSIX shell quoting.

## Development and checks

```bash
npm --prefix superpi run lint
npm --prefix superpi run typecheck
npm --prefix superpi test
npm --prefix superpi-companion run lint
npm --prefix superpi-companion run typecheck
npm --prefix superpi-companion test
npm run sdk:check
```

Client tests check bundle size, classes, server-boundary isolation, and Hermes
bytecode compilation. The host-contract test uses an installed beta host only
in tests, never as a production internal import.

For the isolated launch script and browser workflow, see
[testing](docs/testing.md). The original scope remains in
[requirements](docs/requirements.md), with the
[architecture and staged acceptance goals](docs/design.md) and
[contract findings](docs/implementation-contracts.md).

The rewind adaptation retains OMP's MIT notice in
[`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES).
