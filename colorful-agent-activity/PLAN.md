# Polish plan (completed)

Goal: bring Colorful agent activity up to the refinement of `paseo-chat-polish` in five areas, while
keeping full iOS and Android support. The original review compared the two plugins side by side.

Scope decisions taken before implementation:

- **Settings UI**: match chat-polish's shape — a full dashboard screen registered with `addScreen`,
  reachable from a sidebar row and the command center, with a live preview. Not a settings sub-screen.
- **Reply inline code and fenced blocks**: desktop and web only. Paseo exposes no markdown hook, so a
  plugin cannot render assistant replies itself without re-implementing markdown. The web layer
  degrades to a no-op on native instead of risking the mobile runtime.
- **Dimming**: a real setting (**Quiet rows**: dim, faded, soft, full), not an automatic rule.
- **SDK**: bumped from 0.10.0 to 0.11.4 (latest stable) so the dashboard can use `addScreen` and
  `addSidebarHeaderItem`. `plexuspi` and the other plugins stay on 0.10.0 through the
  `pluginVersions` override in `.paseo-sdk.json`.

## Workstreams

### 1. Dimmed colors — done

- `shared/color.ts` (new, tested in `shared/color.test.ts`): `alpha`, `mix`, `darken`, `sunken`,
  `rule`, `tint`, `luminance`, `parseHex`. Non-hex colors pass through untouched.
- `useActivityStyles` now derives its structural colors: code surfaces are `sunken(surface0)`, rails
  and borders are `rule(border)`, gutters are `alpha(foregroundMuted, 0.6)`, changed diff lines get
  `tint(status, 0.12)` washes.
- Quiet rows: `quietOpacity` + `useQuietRow` in `client/prefs.ts` and `client/activity.tsx`. Finished
  rows step back; running, failed, hovered, pressed, and expanded rows stay at full strength (hover
  restores on desktop and web; press and expand restore everywhere).

### 2. Sub-card indentation — done

- `LABEL_INSET` (26 px) and `NEST_INSET` (12 px) are exported from `client/activity.tsx`.
- Expanded detail content starts at the label column instead of the card edge, so code, diffs, and
  result lists line up under the row's label; one guide sits 9 px to the left.
- Subagent progress and child timelines no longer add a redundant margin on top of their rail.

### 3. Shell command color — done

- New setting `commandColor` (expanded, always, off).
- `HighlightedCommand` colors the command in the row summary with the bundle's bash grammar, using
  theme-derived syntax colors, once the row is expanded (or always).
- `ShellCommandBlock` merges the command and its output into one card: `$`, the highlighted command,
  the working directory's last segment, and copy in the header; muted ANSI output below; exit code in
  the danger color when nonzero.

### 4. Inline code and code blocks — done

- `HighlightedCodeBlock` is now a code card with a `codeChrome` setting (header bar, bare, header +
  line-number gutter), a sunken surface, a 6 px radius, and a shared `CopyCodeButton`.
- Reasoning inline code chips use the theme's surface, a 3 px radius, and mono text.
- `client/web.ts` gained `replyCodeCss` and `installReplyCodeStyles` (web-only, idempotent, removable)
  plus the `replyCode` setting; `client/dashboard/sidebar.tsx` keeps it in step with the host theme.
  Selectors key on Paseo's `data-paseo-markdown-tag` marks, scoped to `[data-testid="assistant-message"]`.

### 5. Settings dashboard — done

- `client/dashboard/`: `index.tsx` (shell, navigation, save queue), `controls.tsx` (style system and
  primitives), `pages.tsx` (Activity, Rows, Code & commands, Replies), `preview.tsx` (live preview),
  `samples.ts` (samples built through the real transforms), `sidebar.tsx` (sidebar row + web restyle).
- `client/prefs.ts` (new): `useActivityPrefs`, `PrefsOverride`, and the quiet/command/reply helpers.
  Renderers read settings through it, so the preview can show unsaved values.
- Settings schema is version 2 with a migration; `client/settings.tsx` was deleted.

## Explicitly not adopted from chat-polish

Merged step runs and their timeline following, theme contributions and presets, whole-chat DOM
restyling (composer, permission cards, diagrams), host font and appearance mutation, the image
pipeline, turn recaps, user-message clamping, the model-selector rail, and the selection copy popup.
None were part of the five asks, and the merged-run engine is the piece most likely to fight Paseo's
virtualized list.

## Review findings and fixes

An independent review pass over the finished work found two blockers and several smaller issues; all
are fixed:

- **Second save with a stale revision was dropped.** The dashboard originally looped pending writes
  immediately, but the host hands the new revision back a tick later, so the second write conflicted
  and the user's second tap disappeared. The dashboard now writes one change at a time and lets the
  revision change trigger the next queued write.
- **Multi-line shell commands lost every line after the first** in the expanded card once the bash
  grammar finished tokenizing. `HighlightedCommand` now renders every line.
- **Running task lists were dimmed** by quiet rows; a checklist with `in_progress` items now stays at
  full strength until it is complete.
- **Controls were live before settings loaded**, which could write defaults over stored values. They
  are inert until the first read completes, and **Defaults** stays available as the recovery path
  (including when stored settings are invalid, where saving is refused).
- **Save failures were hidden**: the draft no longer reloads over a failed write, so `saveError` is
  what the header shows.
- **The web restyle depended on the sidebar row being visible.** It is now synced from the activity
  renderers as well, keyed by palette so the stylesheet is written once per theme.
- **Gutter line numbers** appear even when a language has no grammar to highlight, the copy control
  gets `pointer-events: auto` so it can be clicked before hover, and the copy selector's English-only
  `aria-label` is documented.
- **Opening the dashboard crashed with "Plugin state hooks must run inside a workspace panel".** Paseo
  mounts its agent/workspace state provider for timelines, popovers, and workspace panels, but not for
  plugin screens, and `useAgent` throws without it. The preview rendered the real tool row, which
  looked up the agent's working directory. The lookup now lives in an `AgentCwd` boundary that only
  mounts in the timeline, the card takes `cwd` as a prop, `SearchDetail` receives it instead of
  looking it up again, and the preview opts out via `preview`. `client/dashboard/provider-safety.test.ts`
  guards the rule.
- Drafts no longer flash the old value after a save: they clear when the saved values actually render.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test` (20 files, 248 tests; includes the bundle gate: no
  ES6 classes and `hermesc -emit-binary`).
- Client bundle: 491 KB, asserted under 512 KB in `client/bundle.test.ts`.
- Plugin installed and reloaded on a Paseo 0.11.4 daemon: `paseo plugin ls` reports `running`, and
  `paseo plugin logs` shows load/ready with no errors.
- Not verified here: a real iOS or Android device (no device available). The Hermes gates pass, but
  the dashboard, quiet rows, and code cards still need an on-device smoke test.

## Post-review fixes
- **"Show all" was category-green** (`palette.categoryColors.agent`), which read as a status next to muted
  metadata. It is now muted foreground text, in every code, diff, and reasoning surface.
- **Long thinking blocks froze on their opening lines.** Reasoning was cut with the code-preview
  truncation (20 lines / 4,000 chars), so once a block grew past that the newest text was never
  rendered, the block stopped following the stream, and it read as "not pinned to the bottom".
  Reasoning now renders whole while it streams; the 420 px scroll region caps the height instead.
  Above 32,000 chars only the tail is rendered, so a runaway block cannot stall layout.
- **Following the stream now works on web.** Auto-scroll rode on `onContentSizeChange`, which
  react-native-web does not report reliably. It is driven by the revealed text instead (one frame
  later, via `requestAnimationFrame`), only while streaming, and only while the reader is near the
  bottom. A finished block opens at its start rather than jumping to its end.

## Reconnect cost: loader, payload cache, minification

Paseo ships every plugin's whole client bundle inside the catalog, on every connect and every
`plugin_catalog_changed`, with no compression and no "I already have it" negotiation. On a train that
repeated transfer dominated startup, so the client entry was split in two:

- `index.client.tsx` is a ~3 KB loader. It embeds the payload hash; a reconnect with a warm
  `globalThis` cache registers synchronously with zero requests, a cold cache fetches the payload
  once over the `client.payload` RPC. Registration from cache happens inside `contribute`, so it is
  as synchronous as a normal plugin entry; only the cold path defers (Paseo publishes late
  contributions, and a late transformer invalidates the projection cache, so rows re-transform).
- `client/entry.tsx` holds the real contributions and is built by `scripts/build-client.ts` into a
  minified payload, mirroring Paseo's compile options exactly (externals, `cjs`, `neutral`, `es2020`,
  `async-await` lowering, and the `makeHermesInteropEager` rewrite). Minification alone is 491 →
  232 KB; every Prism grammar is kept.
- `server/payload.ts` serves the payload out of the server bundle, because a plugin server module is
  evaluated from a string and has no reliable directory.
- The generated modules are committed: Paseo installs npm/git sources with `--ignore-scripts
  --omit=dev`, so the build cannot run there. `client/bundle.test.ts` fails when they drift from a
  fresh build, and `client/loader.test.ts` covers the cache, fetch, dispose-during-fetch, and failure
  paths.

Measured against a live 0.11.4 daemon: the catalog entry for this plugin went from 513.5 KB to
3.4 KB, the payload RPC returns 241 KB (232 KB of code), and a warm reconnect sends neither.

## Dashboard fidelity fixes

Three settings looked inert in the dashboard; all three were real bugs:

- **High contrast and soft rendered identically.** `resolveActivityPalette` computed a `borderWidth`
  that nothing consumed, and guides came from the theme border regardless of mode. Palettes now carry
  `railAlpha` and `borderWidth`, `useActivityStyles` applies both to every guide, and the palette
  tiles draw the guide and status dot that differ.
- **Wrap/Scroll looked like it did nothing** because every sample diff line was short enough to fit.
  The sample edit now includes a line long enough to wrap.
- **Restyle reply code changed nothing in the preview**, which renders the plugin's own components
  rather than host markdown. The preview now shows the plain rendering when the setting is off and
  the styled chips and code card when it is on, captioned with which is which.

## Thinking-block follow fixes

- **The follow gave up partway.** It stopped when the distance to the bottom exceeded 32 px, but
  text can arrive faster than the scroll lands, so one lagging frame read as "the reader scrolled
  away" and the tail was unreachable without scrolling. Only upward movement now stops the follow;
  reaching the bottom resumes it.
- **A live block reset to its start.** Following was gated on `phase === "streaming"`, so a block that
  finished (or remounted after a reload) opened at step 1. Following is now gated on the block being
  the newest one (`streaming || isLatest`), which keeps a just-finished block at its end; older
  blocks still open at their start, where reading begins.

## Follow-ups

- Refresh `README.md` screenshots; they predate the dashboard, code cards, and quiet rows.
- The plugin has no entry under Settings → Plugins any more: registration moved to a dashboard screen
  with a sidebar row and a command center item. Add a settings screen again if that discoverability
  matters more than matching chat-polish's shape.
- Add Command Center toggles for quiet strength and command colors if wanted. They would need a saver
  that is always mounted; the activity renderers are always mounted when a chat is open.
- Mobile smoke test on a device or emulator.
