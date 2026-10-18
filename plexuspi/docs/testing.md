# Independent testing environment

One directory and one setup/start script:

```bash
node plexuspi/testing/start.mjs --setup
node plexuspi/testing/start.mjs --sync-resources
node plexuspi/testing/start.mjs
```

The first command copies the current Pi distribution and selected extension
sources, installs `@getpaseo/cli@0.11.0-beta.3` from npm, and writes isolated Pi
and Paseo config files. Subsequent starts reuse them without overwriting state.
The final command runs the test daemon in the foreground. Ctrl-C stops it.
`--sync-resources` refreshes the copied extension sources (`pi-subagents`,
`pi-control`, and `plexus-pi`) without overwriting the test settings, transcripts,
or credentials. PlexusPi has no separate control copy to sync.

Default directory: `plexuspi/.test-env/simple` (gitignored).
Web interface: `http://127.0.0.1:6899/`.

When developing through PlexusPi, use this separate daemon for runtime changes.
Do not stop/reload the daemon/provider hosting the development conversation.
The launcher writes explicit Paseo configuration; pointing at a copied Pi
directory alone does not register its executable or load PlexusPi.

## Automated checks

From the repository root:

```bash
npm --prefix plexuspi run lint
npm --prefix plexuspi run typecheck
npm --prefix plexuspi test
npm run sdk:check
```

The Pi-side `plexus-pi` extension lives in
`~/workspace/pi-stuff/plexus-agent-plugins/packages/plexus-pi`, outside this
repository. Its control protocol and tier/context logic are covered by its own
`src/**/*.test.ts` files; run them from that package.

Provider tests include client size/classes/Hermes and runtime-boundary checks.
The rewind host-contract probe runs against the installed isolated host; it
skips when that host is absent. Install the test host or set `PASEO_HOST_ROOT`
before claiming the host contract was checked. Mobile device smoke is separate;
iOS passed (2026-10-04), Android remains unverified.

## Layout and configuration

```text
simple/
  pi/                  copied binary and its shipped resources
  extensions/          copied Pi extensions, including plexus-pi
  node_modules/        npm Paseo beta and extension runtime dependencies
  pi-agent/            isolated settings, model config, agent definitions
  sessions/            default isolated Pi transcript directory
  paseo/config.json    explicit provider command, listener, web UI configuration
  paseo/plugins/plexuspi/state/  PlexusPi-owned manifests, native transcripts, journals
  workspace/           disposable test working directory
  home/                separate HOME/XDG state
```

The generated Paseo config explicitly enables Pi and points its command at
`simple/pi/pi`. Provider environment overrides pin the copied package, agent,
and session directories. The launcher also sets `PASEO_HOME`,
`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and `PI_PACKAGE_DIR`.
Plugins are enabled. `PLEXUSPI_PI_COMMAND` points PlexusPi at the copied Pi
binary. The copied `plexus-pi` package is loaded by Pi through the `packages`
entry in `pi-agent/settings.json`; PlexusPi does not receive an extension path.

Keep the copied `plexus-pi` package loaded for context/service-tier policy tests;
its root control supplies the policy state. If a known competing owner (for
example `pi-microgpt`'s `/fast`, `/flex`, or `/long-context`) is also loaded, the
`hello` handshake fails and names the owner and resolution. Resolve ownership
explicitly in the disposable configuration; do not remove `plexus-pi` as the
normal setup or silently change production configuration. Conflict tests
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
private key file is `plexuspi/.test-env/live/staging-credential.json`; it reads the
value without printing it. The original smoke key was restricted to
`deepseek-v4.1-flash`, with raw passthrough disabled and a seven-day lifetime.
Do not assume that key is still valid or that later test keys have the same scope.

For another dedicated key, set `PLEXUSPI_STAGING_API_KEY` in the invoking
environment or point `PLEXUSPI_TEST_KEY_FILE` at a private JSON file containing a
`secret` field. Don't put key values in shell commands, docs, or committed files.
Only the inference key is passed into the daemon; staging admin credentials and
unrelated shell credentials aren't inherited.

The isolated Pi model uses provider ID `plexuspi-test` and model ID
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
node plexuspi/testing/start.mjs --cli plugin install "$PWD/plexuspi"
node plexuspi/testing/start.mjs --cli plugin reload plexuspi
node plexuspi/testing/start.mjs --cli plugin ls plexuspi
node plexuspi/testing/start.mjs --cli plugin logs plexuspi

node plexuspi/testing/start.mjs --cli agent run \
  'Reply with exactly LAB_DEEPSEEK_OK. Do not call tools.' \
  --provider plexuspi --model plexuspi-test/deepseek-v4.1-flash \
  --cwd "$PWD/plexuspi/.test-env/simple/workspace" \
  --title 'DeepSeek isolated smoke' --wait-timeout 60s --json

node plexuspi/testing/start.mjs --cli daemon stop
```

The daemon must already be running. `--provider pi` tests the built-in provider,
not PlexusPi. After `plexus-pi` or other extension edits, run `--sync-resources`
and open a fresh conversation to load the new extension. The sync command exits
after copying; it doesn't restart Pi or the daemon.

Only install plugins whose external integrations are appropriate for the test
environment. An isolated home doesn't neutralize a plugin's hardcoded external
paths/services. Don't pass `--home` or `--host` through this helper.

Overrides:

- `PLEXUSPI_TEST_DIR`: another test root; use a new directory for a clean setup.
- `PLEXUSPI_TEST_PORT`: another non-production loopback port (default 6899).
- `PLEXUSPI_PI_DIST`: source Pi distribution to copy during initial setup.
- `PLEXUS_STAGING_URL`: staging inference endpoint during initial setup.

## Policy discovery checks

The generated `plexuspi-test` model is an isolated inference fixture. It is not
the `plexus` provider and does not receive Plexus tier injection; it is not a
valid test of the current policy selectors. To check those, keep `plexus-pi`
loaded, run `/plexus refresh` while idle, and select an actual `plexus/<model>`
from its catalog. Use a key authorized for that model before doing inference.
Catalog/state discovery alone isn't an upstream tier-acceptance or billing test.

Check the actual composer after refresh/model changes: advertised `default`,
`auto`, and `standard` tiers appear as one `default` choice; other tier names
stay unchanged. Models with no tiers have no tier selector, and distinct
short/max budgets show token-length options. Saved selections should restore
and live `plexuspi:state:v1:` updates should refresh the controls without a model turn.
At the latest live check, Luna advertised `auto`, `standard`, `flex`, `priority`
and 272,000 / 1,050,000 tokens (`272K` / `1M`). Astra discovery and `flex`
selection also passed. These are observed catalog values, not fixed policy.

## Active-turn context checks

`server/session.test.ts` covers unknown consumption after compaction, recovery
after an assistant response while tools remain active, successive consumption
updates, active-only polling and stats-error recovery, coalesced slow requests,
new turns overtaking old requests, stale snapshots across compaction/configuration,
per-message token/cost preservation, and Stop/close cleanup.

The 2026-10-13 isolated check used the actual npm beta host and copied Pi with a
disposable no-network model and custom native compaction summary. After `/compact`,
the host snapshot correctly omitted consumed tokens. The next assistant response
started a 45-second bash call; during that call, the host reported 4,032 / 128,000
tokens. `agent-browser` opened the context details while **Stop agent** was still
visible and showed **3% used**, **4k / 128k tokens**. The final snapshot advanced
to 6,032 consumed tokens after the tool finished. This checks the actual
post-compaction lifecycle and desktop UI, not upstream inference or iOS/Android.
The fixture, active/final snapshots, and screenshot are in ignored test storage.

## Steering checks

`server/steering.test.ts` covers active-turn IDs, distinct user echo bindings,
images, slash-command refusal, skill/template expansion, requested permission
clearing, Stop/close, transport timeout, settlement before send/admission,
undelivered-steer cleanup, extension-owned user echoes, and replacement prompts
waiting behind cleanup.
`server/provider.test.ts` covers capability negotiation and connection routing.

The 2026-10-13 isolated check used the actual npm beta host and copied Pi with a
disposable no-network model extension. Its first response called `bash` with a
15-second sleep. Sending another message with `activeTurnBehavior: "steer"`
during that tool kept the same turn ID, let the tool finish, and produced the
assistant response requested by the steer. The host history contained two user
rows, one started/completed turn, and no cancellation or duplicate native echo.
`agent-browser` also opened the completed conversation and checked its displayed
history, including both user prompts, the shell tool, and the assistant response.
The fixture, captured timeline, and screenshot are in ignored test storage. This
checks the Pi/Paseo lifecycle and desktop history rendering, not upstream model
behavior or mobile UI.

The dedicated staging inference credential returned HTTP 401 during this check.
Real upstream inference needs a renewed staging credential; no production key
was used.

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
export AGENT_BROWSER_SESSION=plexuspi-simple
export AGENT_BROWSER_SOCKET_DIR=/tmp/plexuspi-simple-browser
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.agent-browser/browsers/chrome-154.0.8037.92/chrome"
export HOME="$PWD/plexuspi/.test-env/simple/home"
export TMPDIR=/tmp

agent-browser open http://127.0.0.1:6899/
agent-browser wait --text History
agent-browser snapshot -i
agent-browser find role button click --name History
agent-browser snapshot -i
# Click the relevant history-row ref from the fresh snapshot.
agent-browser wait --text LAB_DEEPSEEK_OK
agent-browser screenshot "$PWD/plexuspi/.test-env/simple/web-check.png"
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
- PlexusPi completes a real tool-reading request and reopens its persisted Pi
  session. Current policy controls have separate live/automated checks described
  above; the `plexuspi-test` inference fixture doesn't establish those controls.
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
- Both package suites passed 292 tests at implementation baseline `1c13cae`
  (under the earlier Superpi name, with the companion as a separate package),
  along with lint/typecheck, SDK, client boundaries, and Hermes bytecode checks.
- At this rename commit, `plexuspi` lint, typecheck, 290/290 tests, and root
  `sdk:check` pass (2026-10-18). Continued development through PlexusPi itself on
  the active host is verified: real inference, streaming, and Pi subprocess
  handshake outside the isolated daemon. Isolated staging inference still needs a
  renewed credential (401 at the last isolated check).

Paseo's visible history can still retain abandoned rows, including after reload.
Do not count the successful Pi navigation as proof that the original in-place
UI-replacement requirement passes. See [the provider README](../README.md) for
the current implementation and limits.

Screenshots and small temporary Pi smoke commands are stored only under the
ignored test directory. No fixture server or custom browser framework was added.
