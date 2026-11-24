# Release process

How to ship a new version of this plugin and keep the three listings in sync.

## Listings

| Where | Source of truth | How it updates |
| --- | --- | --- |
| GitHub | `main` + version tags | push |
| npm [`paseo-turn-speed`](https://www.npmjs.com/package/paseo-turn-speed) | `npm publish` | manual |
| Official [paseo.sh/plugins](https://paseo.sh/plugins) | npm artifact ([submission #475](https://github.com/getpaseo/plugins/issues/475), merged via PR #476) | bot opens a bump PR on each npm release; a reviewer merges |

Local development stays on the directory source (`paseo plugin install "$(pwd)"`);
public installs use `npm:paseo-turn-speed`. The listing's display metadata (icon,
media, name, description, overview) is read from the pinned artifact, so a
metadata-only change still ships as a release and appears once the bump PR merges.

## Cutting a release

1. Bump `version` in `package.json` (semver; the npm version is the update
   identity both registries track).
2. `npm run verify` (typecheck + unit tests + client-bundle check), and confirm
   every declared manifest asset ships:
   `npm pack --dry-run --ignore-scripts | grep -E "paseo-plugin.json|assets/"`.
3. `git commit` then `git tag vX.Y.Z`.
4. `git push origin main --follow-tags` — tags are lightweight, so also run
   `git push origin vX.Y.Z` (`--follow-tags` only pushes annotated tags).
5. Publish (see npm gotchas below): `npm publish`.
6. Wait for the staged publish to finish: `npm view paseo-turn-speed@latest version`
   returns `0.0.0-stage` for a couple of minutes, then the new version.
7. Smoke-test both install sources and remove the temporary instances:
   ```bash
   paseo plugin add npm:paseo-turn-speed --id turn-speed-smoke   # expect: running
   paseo plugin remove turn-speed-smoke
   paseo plugin add github:Drenalol/paseo-turn-speed --id turn-speed-smoke-git
   paseo plugin remove turn-speed-smoke-git
   ```
8. Once the bump PR merges, confirm the listing resolved the metadata from the
   new pin (`[None]` means the manifest field or the file inside the tarball is
   missing):
   ```bash
   curl -s https://plugins.paseo.sh/index.json | python3 -c 'import json,sys;print([p.get("icon") for p in json.load(sys.stdin)["plugins"] if p["id"]=="drenalol/turn-speed"])'
   ```

## npm gotchas (learned the hard way)

- **Publishing requires 2FA.** The account uses a passkey. The passkey CLI flow
  only exists in npm 11+; the npm first in `PATH` (`~/.local/bin/npm`, hermes
  bundle) is 10.9.8 and fails with `EOTP`. Use `/usr/local/bin/npm publish`.
- The web session in `~/.npmrc` expires; then `npm publish` fails with a
  misleading `404 PUT` (not 401) before any prompt appears. Check with
  `npm whoami` and refresh via `npm login --auth-type=web` first. Both login
  and publish print their own one-time URL (`/login/cli/…`, `/auth/cli/…`)
  that needs a browser passkey confirmation within minutes — in a
  non-interactive shell, drive each via `expect` and scrape the URL from the
  expect `log_file`.
- npm is deprecating 2FA-bypassing automation tokens for direct publishing
  (banner: "npm tokens that bypass 2FA are being restricted"), so per-release
  web confirmation is the expected future flow, not a regression.
- The publish command prints `https://www.npmjs.com/auth/cli/<id>` and waits for
  the browser passkey confirmation. The CLI session expires in minutes — open
  the link promptly. Without a TTY, wrap it in a PTY (`expect`) so the
  "Press ENTER to open in the browser..." prompt gets answered.

## Registry conventions

`paseo-plugin.json` carries `id`, `description`, `icon`, `requirements`. These
are official listing-metadata fields
([icons and screenshots](https://paseo.sh/docs/plugins/publishing#icons-and-screenshots))
and a manifest declaring them needs Paseo 0.11.0 or later, which is already the
required version. History: paseo.cafe — the community registry this plugin was
listed on until it shut down — had a scanner that only allowed the keys `id`,
`description`, `requirements`, `build`, so the manifest was trimmed to that
allow-list; nothing trims it now.

`name` and `media` stay out of the manifest deliberately:

- The listing title comes from the humanized plugin id (`Turn Speed`), and a
  manifest `name` would replace that string literally.
- The record `plugins/drenalol/turn-speed.json` already carries `listing.media`
  with the three screenshots, and a `listing` override wins over the manifest
  **per field** — so manifest `media` would change nothing on the listing while
  forcing `images/` into the published package (+370 kB per install).

What `icon` requires:

- A package-relative PNG path, forward slashes, inside the plugin directory.
  SVG is not accepted.
- The file must be inside the published tarball. The registry turns the path
  into a URL pointing at the pinned version
  (`https://cdn.jsdelivr.net/npm/paseo-turn-speed@<version>/assets/icon.png`),
  so an icon missing from `files` becomes a broken listing image, not a
  missing one. `assets/` is in `files`, and the icon is already published with
  every release — declaring the field is all the listing was waiting for.
- A manifest change only reaches the listing through a new npm release: the
  registry reads metadata from the pinned tarball, and the bot's bump PR is
  what re-pins it.

Validation rules the registries enforce (worth keeping either way):

- `OVERVIEW.md` must not contain the strings `paseo plugin add`,
  `npm install`, `npm i` (registry docs belong in the README).
- The README keeps an `## Install` section and a `## Known limitations`
  section — the registries detect those headings and pull them into the
  listing — plus an `images/` folder for screenshots.

## History

- 2026-10-15 — v1.0.0 published; approved and merged in the official registry
  (PR getpaseo/plugins#476) the same day.
- v1.0.1 — manifest trimmed to the scanner allow-list; cafe admission passed
  after re-submission (paseo-cafe#380/#381 merged).
- 2026-10-23 — v1.1.0 published: subagent awareness (delegated-time exclusion,
  team badge, per-child popover via `paseo.parent-agent-id` labels). npm web
  session had expired — republished after `npm login --auth-type=web` plus a
  separate `/auth/cli/` confirmation for the publish itself (see gotchas).
  Registry bump PR is opened by the bot after the staged publish resolves;
  cafe re-scans automatically.
- 2026-10-25 — v1.2.0 published: thinking-token accounting (exclusion
  detection, reasoning-specific 3.7 chars/token estimate, per-model verdict
  with revocation rules), unattributed-token retention, open-step decode
  windows, plausibility-capped displayed rates. Same expired-session login
  flow as v1.1.0; both smoke installs passed.
- 2026-10-25 — v1.2.1 published (docs-only): README links the upstream
  `AgentUsage.reasoningTokens` request (getpaseo/paseo discussion #7863) from
  Known limitations, so registry listings carry the upvote target. Session
  still warm from v1.2.0; publish still required its own `/auth/cli/` passkey.
- 2026-11-02 — paseo.cafe shut down: community listing dropped from the
  release process and from the listings table; its scanner-specific manifest
  restrictions are kept only as history (see Registry conventions).
- 2026-11-02 — v1.3.0 published: prompt cache hit rate in the pill and
  popover (PR #1: `showCacheInPill` and `cacheCounting` preferences,
  auto/inclusive/separate detection), and turn-window reconciliation
  (PR #2: the clock anchors to the `turn_started` event timestamp, mid-turn
  attach seeds only after the subscription is ready, and a snapshot closes a
  turn whose terminal event was lost provisionally). Both PRs were external
  contributions; the combined tree verified at 98 tests.
- 2026-11-21 — v1.4.0 published: idle pills go silent (PR #3, external
  contribution: the 500 ms heartbeat runs only while a turn runs and
  `registration.update()` is skipped when nothing in the pill changed — measured
  ~68% → ~2.6% Renderer CPU with ~330 loaded agents), waits are parked (PR #6:
  tool calls and subagent delegation now leave the decode windows as well as the
  whole-turn rate; a parent's step whose window had grown to 1 185 159 ms and
  read 0.17 tok/s went back to the seconds the model actually generated), and a
  usage window under 100 ms no longer buys a denominator (measured junk: 3
  tokens over 8 ms printed 375 tok/s, under the 400 cap). `samePreferences()`
  derives its compared keys from the settings schema (#4). Verified at 115
  tests; publish needed the usual `/login/cli/` plus `/auth/cli/` passkey pair,
  and both smoke installs came back `running` (npm at 1.4.0, git at the tag).
- 2026-11-22 — v1.4.1 published (listing metadata only, no behavior change):
  `paseo-plugin.json` declares `icon: assets/icon.png`, so the store card gets
  an icon. `assets/icon.png` had shipped in every tarball since v1.0.0 — the
  listing was missing only because the manifest never pointed at it, a leftover
  of the paseo.cafe scanner allow-list. The registry resolves the path against
  the pinned version
  (`https://cdn.jsdelivr.net/npm/paseo-turn-speed@<version>/assets/icon.png`),
  so the field only reaches the listing through this release and its bump PR;
  `plugins/drenalol/turn-speed.json` is expected to gain `icon` while its
  `listing.media` screenshots keep winning that field. Verified: `npm pack`
  ships `assets/icon.png` (18 files, 82 kB), the local daemon 0.17.1 reloads the
  manifest with the new key (`Plugin ready`), and both smoke installs came back
  `running` with the declared icon in the installed manifest (npm at 1.4.1, git
  at 9e1d013). Publish again needed `/login/cli/` plus `/auth/cli/`: the web
  session had expired (`npm whoami` → 401), and the browser tab reports `Token
  expired` on a CLI code that is already spent, which is harmless once
  `npm whoami` answers.
