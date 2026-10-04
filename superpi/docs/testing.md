# Independent testing environment

One directory and one setup/start script:

```bash
node superpi/testing/start.mjs --setup
node superpi/testing/start.mjs --sync-resources
node superpi/testing/start.mjs
```

The first command copies the current Pi distribution and selected extension
sources, installs `@getpaseo/cli@0.11.0-beta.3` from npm, and writes isolated Pi
and Paseo config files. Subsequent starts reuse them without overwriting state.
The final command runs the test daemon in the foreground. Ctrl-C stops it.
`--sync-resources` refreshes the copied companion and extension sources without
overwriting the test settings, transcripts, or credentials.

Default directory: `superpi/.test-env/simple` (gitignored).
Web interface: `http://127.0.0.1:6899/`.

When developing through SuperPi, use this separate daemon for runtime changes.
Do not stop/reload the daemon/provider hosting the development conversation.
The launcher writes explicit Paseo configuration; pointing at a copied Pi
directory alone does not register its executable or load Superpi.

## Automated checks

From the repository root:

```bash
npm --prefix superpi run lint
npm --prefix superpi run typecheck
npm --prefix superpi test
npm --prefix superpi-companion run lint
npm --prefix superpi-companion run typecheck
npm --prefix superpi-companion test
npm run sdk:check
```

Provider tests include client size/classes/Hermes and runtime-boundary checks.
The rewind host-contract probe runs against the installed isolated host; it
skips when that host is absent. Install the test host or set `PASEO_HOST_ROOT`
before claiming the host contract was checked. Mobile device smoke is separate
and remains unverified.

## Layout and configuration

```text
simple/
  pi/                  copied binary and its shipped resources
  extensions/          copied Pi extensions and superpi-companion
  node_modules/        npm Paseo beta and extension runtime dependencies
  pi-agent/            isolated settings, model config, agent definitions
  sessions/            default isolated Pi transcript directory
  paseo/config.json    explicit provider command, listener, web UI configuration
  paseo/plugins/superpi/state/  Superpi-owned manifests, native transcripts, journals
  workspace/           disposable test working directory
  home/                separate HOME/XDG state
```

The generated Paseo config explicitly enables Pi and points its command at
`simple/pi/pi`. Provider environment overrides pin the copied package, agent,
and session directories. The launcher also sets `PASEO_HOME`,
`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and `PI_PACKAGE_DIR`.
Plugins are enabled. `SUPERPI_PI_COMMAND` and `SUPERPI_COMPANION_PATH` point
Superpi at those copied resources.

Keep the copied `plexus-pi` package loaded for context/service-tier policy tests.
Current policy discovery needs its event publisher. If that copy declares a
competing `/service-tier` command, the companion rejects startup and names the
owner/resolution. Resolve ownership explicitly in the disposable configuration
or use the current owned extension build; do not remove the policy publisher
as the normal setup or silently change production configuration. Conflict tests
exercise the competing-command case separately.

The listener is loopback-only, relay is disabled, and voice/dictation downloads
are disabled. No production Paseo config or Pi auth/session files are copied.
Use the test workspace, not the production repository, for model/tool work.
`GIT_CEILING_DIRECTORIES` prevents accidentally treating the enclosing repository
as the test project.

Extension sources are copies, not links into working repositories. Their npm
runtime dependencies are installed locally. Only the three listed extensions
are included initially; this isn't a complete clone of every personal resource.
Additional extensions can be copied into this directory
and added to its `pi-agent/settings.json` as needed.

This isolates state/configuration, not operating-system permissions. Trusted
extensions and shell tools can still access files outside the test directory.

## Credentials and model

Use a dedicated staging key, not production credentials. The script's default
private key file is `superpi/.test-env/live/staging-credential.json`; it reads the
value without printing it. The original smoke key was restricted to
`deepseek-v4.1-flash`, with raw passthrough disabled and a seven-day lifetime.
Do not assume that key is still valid or that later test keys have the same scope.

For another dedicated key, set `SUPERPI_STAGING_API_KEY` in the invoking
environment or point `SUPERPI_TEST_KEY_FILE` at a private JSON file containing a
`secret` field. Don't put key values in shell commands, docs, or committed files.
Only the inference key is passed into the daemon; staging admin credentials and
unrelated shell credentials aren't inherited.

The isolated Pi model uses provider ID `superpi-test` and model ID
`deepseek-v4.1-flash`, targeting Plexus staging. This avoids a startup-resolution
collision between the Plexus extension's dynamic catalog and a same-provider
model override. The Plexus extension still loads from its copied distribution.
The test context/output limits and zero costs in `models.json` are test metadata,
not verified backend capacity or billing claims. Image tests need an appropriate
model/metadata configuration; this initial DeepSeek entry declares text input.

## CLI and plugin operations

The same launcher can run a scoped CLI command. It prints subcommand help first
and always selects the isolated Paseo home:

```bash
node superpi/testing/start.mjs --cli plugin install "$PWD/superpi"
node superpi/testing/start.mjs --cli plugin reload superpi
node superpi/testing/start.mjs --cli plugin ls superpi
node superpi/testing/start.mjs --cli plugin logs superpi

node superpi/testing/start.mjs --cli agent run \
  'Reply with exactly LAB_DEEPSEEK_OK. Do not call tools.' \
  --provider superpi --model superpi-test/deepseek-v4.1-flash \
  --cwd "$PWD/superpi/.test-env/simple/workspace" \
  --title 'DeepSeek isolated smoke' --wait-timeout 60s --json

node superpi/testing/start.mjs --cli daemon stop
```

The daemon must already be running. `--provider pi` tests the built-in provider,
not Superpi. After companion edits, run `--sync-companion` (or `--sync-resources` when owned
extensions changed) and open a fresh conversation to load the new extension.
The sync commands exit after copying; they don't restart Pi or the daemon.

Only install plugins whose external integrations are appropriate for the test
environment. An isolated home doesn't neutralize a plugin's hardcoded external
paths/services. Don't pass `--home` or `--host` through this helper.

Overrides:

- `SUPERPI_TEST_DIR`: another test root; use a new directory for a clean setup.
- `SUPERPI_TEST_PORT`: another non-production loopback port (default 6899).
- `SUPERPI_PI_DIST`: source Pi distribution to copy during initial setup.
- `PLEXUS_STAGING_URL`: staging inference endpoint during initial setup.

## Policy discovery checks

The generated `superpi-test` model is an isolated inference fixture. It is not
the `plexus` provider and does not receive Plexus tier injection; it is not a
valid test of the current policy selectors. To check those, keep `plexus-pi`
loaded, run `/plexus refresh` while idle, and select an actual `plexus/<model>`
from its catalog. Use a key authorized for that model before doing inference.
Catalog/state discovery alone isn't an upstream tier-acceptance or billing test.

Check the actual composer after refresh/model changes: advertised tier names
appear unchanged, models with no tiers have no tier selector, and distinct
short/max budgets show token-length options. Saved selections should restore
and live policy broadcasts should update the controls without a model turn.
At the latest live check, Luna advertised `auto`, `standard`, `flex`, `priority`
and 272,000 / 1,050,000 tokens (`272K` / `1M`). Astra discovery and `flex`
selection also passed. These are observed catalog values, not fixed policy.

## Browser checks

Use `agent-browser` directly, with a named session. No custom browser framework
or production Chrome profile is needed. Load its installed core skill before
driving the UI:

```bash
agent-browser skills get core
```

For this Linux machine, a separate browser home and short socket directory avoid
sharing state and Unix socket path-length failures:

```bash
export AGENT_BROWSER_SESSION=superpi-simple
export AGENT_BROWSER_SOCKET_DIR=/tmp/superpi-simple-browser
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.agent-browser/browsers/chrome-154.0.8037.92/chrome"
export HOME="$PWD/superpi/.test-env/simple/home"
export TMPDIR=/tmp

agent-browser open http://127.0.0.1:6899/
agent-browser wait --text History
agent-browser snapshot -i
agent-browser find role button click --name History
agent-browser snapshot -i
# Click the relevant history-row ref from the fresh snapshot.
agent-browser wait --text LAB_DEEPSEEK_OK
agent-browser screenshot "$PWD/superpi/.test-env/simple/web-check.png"
agent-browser close
```

Run browser commands in a separate shell/subshell so changing `HOME` doesn't
change later source-path resolution in the launcher. If Chrome changes, use
`agent-browser doctor --offline --quick` to find the installed executable.
Don't use the default browser session, auto-connect, or a production profile.
Snapshots, screenshots and logs stay in ignored/private test storage.

Use snapshots and public UI actions for live checks. CLI-created agents are
useful for getting to a known state; browser checks then verify displayed history,
streaming, settings, attachments, dialogs, and child navigation as those behaviors
are implemented. Don't count CLI success alone as a UI test.

## Recorded verification

These combine the original isolated desktop/web smoke tests with the later
controls/commands and policy-discovery checks. They aren't all fresh probes of
the same fixture configuration. Rerun relevant checks after runtime changes.

- Actual npm beta daemon starts with the bundled web UI and separate state.
- Copied current Pi and copied extensions load.
- A Paseo agent completes a real DeepSeek staging request.
- `agent-browser` opens the isolated UI, locates the agent in History, and verifies
  `LAB_DEEPSEEK_OK` in its conversation. A screenshot is saved locally.
- The original dedicated smoke key rejected models other than DeepSeek server-side.
- Superpi completes a real tool-reading request and reopens its persisted Pi
  session. Current policy controls have separate live/automated checks described
  above; the `superpi-test` inference fixture doesn't establish those controls.
- A browser-uploaded text file is handled by the conversation.
- A real Pi editor dialog displays seeded text in the **Pi dialogs** screen;
  submitting it completes the extension command without model work.
- A real owned child completes through DeepSeek and appears in a native
  read-only child tab.
- A synthetic 520-row, multi-megabyte child history reaches row 259 in the native
  view. This is a no-model contract probe, not claimed child execution.
- OMP-style rewind leaves a durable Pi branch pin, excludes the abandoned child
  request from active ancestry, and leaves the fixture file unchanged.
- Native RPC-supported slash commands dispatch without a model turn; terminal
  commands fail explicitly. `/autocompact` exposes Pi's global preference.
- Both package suites passed 292 tests at implementation baseline `1c13cae`,
  along with lint/typecheck, SDK, client boundaries, and Hermes bytecode checks.

Paseo's visible history can still retain abandoned rows, including after reload.
Do not count the successful Pi navigation as proof that the original in-place
UI-replacement requirement passes. See [the provider README](../README.md) for
the current implementation and limits.

Screenshots and small temporary Pi smoke commands are stored only under the
ignored test directory. No fixture server or custom browser framework was added.
