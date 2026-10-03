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

## Layout and configuration

```text
simple/
  pi/                  copied binary and its shipped resources
  extensions/          copied Pi extensions and superpi-companion
  node_modules/        npm Paseo beta and extension runtime dependencies
  pi-agent/            isolated settings, model config, agent definitions
  sessions/            isolated Pi transcripts
  paseo/config.json    explicit provider command, listener, web UI configuration
  workspace/           disposable test working directory
  home/                separate HOME/XDG state
```

The generated Paseo config explicitly enables Pi and points its command at
`simple/pi/pi`. Provider environment overrides pin the copied package, agent,
and session directories. The launcher also sets `PASEO_HOME`,
`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and `PI_PACKAGE_DIR`.
Plugins are enabled. `SUPERPI_PI_COMMAND` and `SUPERPI_COMPANION_PATH` point
Superpi at those copied resources.

For Superpi testing, remove the copied `plexus-pi` package entry from this
disposable environment's `pi-agent/settings.json`: its `/service-tier` command
is a competing owner. The live tests made that change explicitly; production
configuration was untouched. The model still uses the staging configuration in
`models.json`. Keep the copied Plexus source available for conflict tests.

The listener is loopback-only, relay is disabled, and voice/dictation downloads
are disabled. No production Paseo config or Pi auth/session files are copied.
Use the test workspace, not the production repository, for model/tool work.
`GIT_CEILING_DIRECTORIES` prevents accidentally treating the enclosing repository
as the test project.

Extension sources are copies, not links into working repositories. Their npm
runtime dependencies are installed locally. Only the three listed extensions
are included initially; this isn't a complete clone of every personal resource.
Additional extensions or the future companion can be copied into this directory
and added to its `pi-agent/settings.json` as needed.

This isolates state/configuration, not operating-system permissions. Trusted
extensions and shell tools can still access files outside the test directory.

## Credentials and model

Use the dedicated staging key, not production credentials. The existing key is
stored privately at `superpi/.test-env/live/staging-credential.json`; the script
uses it without printing its value. It expires seven days after creation and is
restricted server-side to `deepseek-v4.1-flash`, with raw passthrough disabled.

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
node superpi/testing/start.mjs --cli agent run \
  'Reply with exactly LAB_DEEPSEEK_OK. Do not call tools.' \
  --provider pi --model superpi-test/deepseek-v4.1-flash \
  --cwd "$PWD/superpi/.test-env/simple/workspace" \
  --title 'DeepSeek isolated smoke' --wait-timeout 60s --json

node superpi/testing/start.mjs --cli plugin install "$PWD/colorful-agent-activity"
node superpi/testing/start.mjs --cli plugin reload colorful-agent-activity
node superpi/testing/start.mjs --cli plugin ls colorful-agent-activity
node superpi/testing/start.mjs --cli plugin logs colorful-agent-activity
node superpi/testing/start.mjs --cli daemon stop
```

Only install plugins whose external integrations are appropriate for the test
environment. An isolated home doesn't neutralize a plugin's hardcoded external
paths/services. Don't pass `--home` or `--host` through this helper.

Overrides:

- `SUPERPI_TEST_DIR`: another test root; use a new directory for a clean setup.
- `SUPERPI_TEST_PORT`: another non-production loopback port (default 6899).
- `SUPERPI_PI_DIST`: source Pi distribution to copy during initial setup.
- `PLEXUS_STAGING_URL`: staging inference endpoint during initial setup.

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

## Verified so far

- Actual npm beta daemon starts with the bundled web UI and separate state.
- Copied current Pi and copied extensions load.
- A Paseo agent completes a real DeepSeek staging request.
- `agent-browser` opens the isolated UI, locates the agent in History, and verifies
  `LAB_DEEPSEEK_OK` in its conversation. A screenshot is saved locally.
- The dedicated key rejects models other than DeepSeek server-side.
- Superpi completes a real tool-reading request and reopens its persisted Pi
  session. Native tier/context controls apply and persist across reload.
- A browser-uploaded text file is handled by the conversation.
- A real Pi editor dialog displays seeded text in the **Pi dialogs** screen;
  submitting it completes the extension command without model work.
- A real owned child completes through DeepSeek and appears in a native
  read-only child tab.
- A synthetic 520-row, multi-megabyte child history reaches row 259 in the native
  view. This is a no-model contract probe, not claimed child execution.
- OMP-style rewind leaves a durable Pi branch pin, excludes the abandoned child
  request from active ancestry, and leaves the fixture file unchanged.

Paseo's visible history can still retain abandoned rows, including after reload.
Do not count the successful Pi navigation as proof that the original in-place
UI-replacement requirement passes. See [the provider README](../README.md) for
the current implementation and limits.

Screenshots and small temporary Pi smoke commands are stored only under the
ignored test directory. No fixture server or custom browser framework was added.
