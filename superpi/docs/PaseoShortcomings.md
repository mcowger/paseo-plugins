# Paseo shortcomings

Candidate upstream issues, checked on 2026-10-03 against the local Paseo
checkout and the installed 0.11.0-beta.3 host. Superpi uses the public 0.10.0
plugin contracts. No Paseo source was modified.

## Plugin providers cannot supply native resume commands

**Repro:** right-click a Superpi conversation and choose **Copy Resume Command**.
The app reports "Resume command not available".

`packages/app/src/utils/provider-command-templates.ts` hardcodes built-in
provider IDs. It has `pi` and `omp`, but not `superpi`, `omp-plugin`, or OMP's
profile-specific plugin IDs. `workspace-screen.tsx`'s `handleCopyResumeCommand`
reads only `runtimeInfo.sessionId` or `persistence.sessionId`.

The generic plugin adapter uses its bridge ID or an opaque `plugin:{...}`
persistence handle for that value, not the native Pi/OMP transcript identity.
Adding a hardcoded `superpi` template alone would still give the wrong session
argument. The public provider contract has no native resume-command field.

**Paseo-OMP confirmation:** the inspected plugin registers `omp-plugin` in
`paseo-omp/server/provider/registration.ts`, and profile providers in
`paseo-omp/index.server.ts`. Those IDs have no host resume template, so the same
menu resolves to unavailable. This is a source-contract confirmation, not a
separate interactive OMP smoke test. Built-in `omp` is a different provider.

**Needed API:** let a provider return a native resume command (or a native resume
identity with a provider-declared template). Don't interpret opaque persistence
data as a CLI session ID.

**Superpi workaround:** the agent command-center action **Superpi: Copy Pi resume
command (stop session first)** resolves the owned transcript server-side and
copies a quoted terminal command. Stop/detach the Paseo session before running
it; Pi's terminal process must not write the same transcript concurrently.
Unsaved/ephemeral sessions cannot supply a resume command.
The command preserves the daemon's Pi agent directory, but does not copy
per-agent environment overrides or credentials. Supply any needed environment
in the terminal yourself. The command uses POSIX shell quoting.

## Provider child views trigger top-level prompt-index requests

**Observed:** opening the two explore children of root agent
`e648c66a-45e1-42a1-960a-b6099616d873` logged errors at 19:39:36 and 19:42:31 UTC.
Both were `agent.timeline.list_prompts.request` failures with
`Agent not found: provider:<root>:superpi-child%3A<run>`.

`provider-subagent-panel.tsx` renders an `AgentStreamView` using a synthetic
`provider:` stream ID. `agent-stream/chat-outline/use-chat-outline.ts` requests
its prompt index. The daemon's `handleAgentTimelineListPromptsRequest` in
`packages/server/src/server/session.ts` calls `ensureAgentLoaded` unconditionally,
but provider children are not top-level stored agents.

The client catches the rejection without displaying an error. That explains
why the child UI looked fine: execution and timeline rendering aren't broken;
the optional chat outline cannot load. It is a real invalid request, not merely
a misleading log level.

**Needed fix:** skip top-level outline requests for provider child streams, or
support a provider-child prompt index. Don't register fake top-level agents or
hide all errors to work around it.

## Rewind cannot replace a plugin provider's mirrored history

Pi's active branch rewinds successfully, but abandoned rows can remain visible
in Paseo. The generic adapter's `streamHistory()` stays append-only after
`session.revert`; host forced hydration replays those same abandoned rows.
The provider event contract has no history replacement/reset operation.

**Needed API:** an explicit supported history replacement after revert.
See [the executable verification](rewind-011-verification.md) and
`tests/rewind-host-contract.test.ts` for the installed-host repro.

## Plugin commands have no out-of-band dispatch hook

The host's `PluginAgentSession` does not implement `tryHandleOutOfBand`.
Provider slash commands use the ordinary prompt path, where the host may
interrupt the current turn before the provider sees them.

Superpi uses `session.configure` for live model/tier/context controls, so those
controls can use configuration rather than chat commands. The slash-command
alternatives should be used while idle; they may interrupt a running turn
before reaching Superpi. Manual `/compact` is idle-only. This does not
make arbitrary extension commands safe to invoke during generation.

**Needed API:** a provider-declared non-interrupting command/control path.

## Generic permission cards cannot preserve Pi editor prefill

Pi's `editor` dialog supplies initial text, but the generic host question-card
contract does not carry that prefill into its input. Superpi's **Pi dialogs**
settings screen preserves it through a plugin RPC and native text input.

**Needed API:** initial values and multiline editor semantics on question inputs.

## Do not file these as Paseo defects

- Missing Superpi model labels and built-in slash-command advertisement were
  plugin bugs, fixed here. Pi's `get_commands` omits terminal built-ins; the
  plugin must advertise and dispatch the RPC-supported ones explicitly.
- Long Context's old fixed target was Superpi policy, not a host defect. It is
  now replaced by [Plexus policy metadata](plexus-context-metadata.md).
- Direct steering, MCP translation, arbitrary Pi TUI widgets, and Windows
  descendant cleanup remain Superpi implementation limits unless a specific
  missing host contract is demonstrated.
- Reload worked in the user's test. The earlier `ERR_IPC_CHANNEL_CLOSED` during
  worker shutdown is recorded, but not enough by itself to claim a persistent
  reload failure.
