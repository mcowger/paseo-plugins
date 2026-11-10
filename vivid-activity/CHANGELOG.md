# Changelog

## Unreleased

- Add OMP grep, glob, eval and web search details. Show OMP batched agent tasks separately from OpenCode task calls.
- Show MCP text results from direct output and content-block envelopes.
- Recover missing OMP MCP result text from the agent's local session when Paseo omits it from the timeline.
- Recover missing OMP grep search output and executed `xd://` device results from the agent's local session.

## 0.11.0 (2026-11-02)

- **Thought tail-follow**: a new "Thinking rows" section. With "Follow the output live" on, an expanded thinking
  row shows the latest lines and follows the output as it streams, instead of freezing on its first 20 lines
  (up to 4,000 characters);
  the window holds 5–500 lines (steps in the step view) and defaults to 20. The per-row Expand all still shows
  everything, and a segment you collapsed yourself stays collapsed.
- **Follow new output**: one switch per area — command output, worktree and sub-agent logs (which also covers the
  other tool details), task lists and browser tools — all on by default. While a row is still running, its open
  details stay at the newest output, and long command output and logs show their latest 20 lines (up to 4,000
  characters, colors kept) instead of the first 20; scrolling up pauses the follow, and Expand all still shows
  everything. Finished rows open at the top with the first lines, as before.
- **Live preview**: the settings page is split — controls on the left, a live preview panel on the right (above
  the controls on phones). The preview draws a full mock turn with the plugin's own styles: pinned question,
  an expanded thinking row with the tail window, tool rows (read, shell with diff, failed, running), a fold
  summary with failures auto-expanded, and the turn's tokens — all following the strength, palette, density,
  wrap, expansion and animation settings live. Takeover off shows a note instead.
- **Expand failed rows**: a new "Expand failed rows" choice in Expansion lets only failed rows start open; a running
  row opens once it fails (thinking rows and task lists treat the choice like collapsed).
- **Failed folds open themselves**: a fold summary whose steps include failures now starts expanded, so the failed
  rows and the red failure count are visible without a tap; a segment you collapsed yourself stays collapsed.
- **Command colors**: the shell command in a row's title gets the theme's syntax colors — while the row is open
  (default) or always. The colorizer lives in the lazy `fx` chunk; until it arrives the command reads as plain text.
- **Wrap diff lines**: a new "Code and diffs" section in settings; off (default) keeps long diff lines on one row
  with horizontal scrolling, on wraps them to the available width.
- **Strength**: a new setting under Folding, spacing, and prompts lets finished thinking and tool rows sit at
  65%, 45% or 30% opacity until you hover, focus or expand them; full strength (no fading) stays the default.
  Finished fold summaries fade too: expanding or hovering one restores it, and a running segment's header
  (「N earlier steps」) stays full. Running, waiting and asking rows keep their full color, the newest row of a
  run stays bright, and rows without expandable content stay at full strength, since hovering them restores
  nothing. Hidden from the settings page while takeover is off.
- **Settings from the sidebar**: the settings page now also opens from a Vivid Activity row in the app's sidebar
  and from "Open Vivid Activity settings" in the Command Center, next to the existing Settings → Plugins page;
  all three show the same settings. Screen and sidebar titles follow the chosen language without reloading.
- **Upgrading**: settings saved by 0.10.x and earlier carry over unchanged — the stored settings stay at schema
  version 1 and every new setting starts at its default. Settings saved by a 0.11.0 pre-release build (stored as
  version 2) show as invalid once; press Reset on the settings page. Going back to 0.10.x keeps the settings,
  unless a row kind was set to "Expand failed rows", which 0.10.x reports as invalid.
- Maintainers: the client-chunk build script ships with the package now — `npm run build:chunks` rebuilds the
  served chunks after any client-side change, and `npm run check` rejects stale artifacts. The `fx` chunk grew
  (to ~97 KiB — it now carries the shared highlight module, Prism core and the language grammars) for Command
  colors, and downloads only when one of its features is used.

## 0.10.0 (2026-10-28)

- **A sub-agent that waits for you or failed says so**: the live activity card of a sub-agent shows "Waiting for you" or "Asking you" in amber (with a breathing dot) and a line saying to open its chat; a sub-agent that stopped with an error shows the first line of the error in red (at most 150 characters, common token shapes masked first: `sk-`, `ghp_` and friends, `glpat-`, `xox?-`, JWTs, and values after `Bearer`, `token=`, `api_key=`). Read from the pending requests and error Paseo already reports, with no extra session reads; older servers send neither and the card is unchanged.

## 0.9.1 (2026-10-25)

- **Paseo 0.13 support** (0.12 keeps working):
  - Paseo's own agent messages (a sub-agent's report or finish notice) are left to Paseo, which shows who sent them and why (finished, errored, waiting for approval, closed) instead of a row of raw text. 0.13 delivers several together, re-sends them after a daemon restart and adds a `Server:` paragraph to finish notices. They split segments like messages.
  - Notification rows also end a segment from 0.13 (getpaseo/paseo#7582), so the tool rows before one fold right away; 0.12 rejects that item type and nothing changes there.
  - Motion overlays spell out absolute positioning: the 0.13 phone app's React Native 0.86 removed `StyleSheet.absoluteFillObject`.
  - Connected hosts: a child created on another host is read on that host, so its live activity card works as for a local child and names the host it runs on (it used to say the child is missing from the agent list). The plugin's server borrows that host's API through Paseo's host connection and reads by the same rules (loaded children only; status checks load nothing), returning the connection after a minute without reads. That host sends no updates here, so while the card is on screen a running child is read every 10 seconds and an idle or closed one has its status checked every 30 seconds; when the host cannot be reached the card says so and reads again once it is back.
- Chinese listing for the plugin registry (Paseo 0.13): the manifest carries `translations.zh-CN` (name and description) and the package ships `OVERVIEW.zh-CN.md`; older daemons ignore the field.

## 0.9.0 (2026-10-18)

- **Code font** (issue #3): a new Code font section in settings changes
  everything the rows draw in the code font: summaries, paths, commands, code, diffs, tool output and thinking text.
  - Font family (web and desktop): fonts installed on the device that shows Paseo, separated by commas, saved with
    Apply. A font the device does not have falls back to the default stack. Only letters, digits, spaces and
    `. _ + -` are accepted, since the value goes into a stylesheet; anything else shows a hint and is not saved.
  - Text size: small, standard (default), large or larger (11, 12, 14 or 16 px). Line spacing: compact, standard
    (default) or relaxed. The phone app follows size and spacing and keeps its system monospace font.
  - A live preview sits under the controls. Titles, labels and notes keep their typography, and the defaults change
    nothing.
- The resident bundle's test budget moves from 368 to 372 KiB for the setting every row reads.

## 0.8.0 (2026-10-15)

- **What a run changed**: fold rows end with `3 files +12 −4` and a five-block diffstat (green added, red removed; phones
  leave out the file count). Expanded, they list each file with its lines added and removed and each failed command
  with its first line and exit code before the steps. Only exact line counts are shown: writes, edits without a diff,
  diffs Paseo cut short or too large to compare, deleted files of a patch, patches cut short or too long, and Codex
  patches (Paseo keeps only their first file, so other files cannot be ruled out) count as changes without line
  counts, shown as `1 more uncounted` and never added in or guessed. Whole patch texts are read strictly, section by
  section (at most 200,000 characters, no regular expressions). Rows show their own `+N / −M` only when exact too. The
  fold index adds only numbers (a short hash of each file's path, line counts, uncounted changes, exit codes); file
  names and commands come from rows this device drew.
  Adapted from `changeSummary` and `Diffstat` in [paseo-chat-polish](https://github.com/lthieu96/paseo-chat-polish)
  by Hieu Le (MIT, see NOTICE).
- **Turn tokens**: the last fold row of a turn shows the turn's input, cached and output tokens, read by the
  provider's base (`extends` in the daemon config). Claude- and ACP-based providers show the turn's total when it
  ends. Codex-based providers replace the figures after every request, so while such a turn runs the server part
  subscribes inside the daemon to running agents' updates and adds up each request (the coin breathes until the turn
  ends); cache hits are split out of the input. Pi, OpenCode and OMP show nothing. Only turns watched while they ran
  show figures; they come with the fold index, with no extra request. Thanks to
  [Beautiful Chat](https://github.com/ABorakati/beautiful-chat) and [TokenLedger](https://github.com/stv1024/token-ledger)
  for the idea.
- **Running animations**: a new Running animation setting next to Palette offers the spinner (default, unchanged),
  a Claude Code style sparkle (· ✢ ✳ ✶ ✻ ✽), a breathing orb and a 3×3 dot grid as a snake or a twinkle, with live
  previews. Web uses CSS keyframes and mobile uses native-driver `Animated` values; they pause in the background and
  hold still under reduced motion. The idea comes from paseo-chat-polish; nothing is injected into the page.
- The animations and the expanded change list are a third lazily loaded chunk, `fx` (49,304 bytes), fetched the
  first time one is needed; the settings preview borrows the resident mark instead of carrying its own copy. The
  resident bundle grows from 355,685 to 372,729 bytes; its test budget moves from 360 to 368 KiB.
- A reloaded session counts its turns from the start again (`foreground-turn-1`, `codex-turn-0`, ...): a new history
  drops the token figures of its old turn ids, and the server forgets a turn id's figures when that id starts again.

## 0.7.1 (2026-10-15)

- Shared language layer update: one fewer duplicate catalog check on connect. Rows need the full catalog, so it still loads at once.

## 0.7.0 (2026-10-15)

- Add English and Simplified Chinese with Follow system as the default and a Language section in settings.
- Translate rows, folds, times, tool details, Claude/Pi notices and server-generated subagent summaries. Open views update when the language changes.
- Support custom language files in `~/.paseo/plugin-data/vivid-activity/locales/`, with templates, coverage, placeholder checks and English fallback.
- Wait for text before taking over timeline rows, and share the selected language with both lazy chunks.


## 0.6.2 (2026-10-14)

Documentation only; the code is unchanged.

- The fold index also holds tool call and turn ids, text lengths and a short hash of thinking text, besides each row's position, end time, kind, status and category. It never holds text or tool output.
- The plugin reads no credentials; of the environment it uses only `TMPDIR` and `HOME`, to check the temp directory for image previews.

## 0.6.1 (2026-10-14)

- The server now splits the UI chunks on their first request instead of at startup, and slices the source text instead of building strings character by character. This cuts startup CPU and resident memory; the RPC part budget and the interface stay the same.

## 0.6.0 (2026-10-12)

Fixes after a review of 0.5.0, two additions, and lighter loading on phones.

**Notices and questions**

- Claude Code 2.1 writes background agent notices as `Agent "<description>" finished`, `… failed: <error>`,
  `… was stopped by user` and `… stopped at its N-turn limit`, and monitor events as `Monitor event: "…"`. These
  were taken for repeats of a foreground call and hidden. They now show as rows such as 后台 Agent「审查登录模块」已完成
  (green), …失败：Unknown error (red) or …被你停止 (gray); a monitor event carries no state. Repeats of a foreground
  call (`The Bash call finished; …`) still merge into that call's row, and failed notices count as failures in a
  fold summary.
- A failed, killed or stopped notice keeps that state even when its error quotes words such as `finished`
  (`Agent "审查" failed: Hook "validate" finished with exit code 1`); only a completed one is read for a stop such
  as the turn limit. Claude Code leaves quotes in a description unescaped, so the name ends where one of its own
  endings, read from the end and picked by the state the host reports, says: `Agent "Investigate why "job" finished
  early" stopped at its 30-turn limit (…)` is the turn limit, not a finished agent. A description of any length is
  read this way and shortened only for display; when none of these endings is found, the state the host reports
  stands, whatever words the description holds. An empty description (the Agent tool accepts one) is read the same
  way and shows as 后台 Agent ("background agent") with its ending.
- In non-interactive sessions Claude Code moves a foreground call that is still running to the background; its row
  keeps a placeholder and the real result arrives in a notice. Such a notice now gets its own row
  (前台调用「Bash」结果已送达, "result delivered") that expands to the result, instead of being merged away. When the
  call's row already shows the same result (both say `built in 4.2s`; color codes, line endings, spaces at line ends
  and blank lines at either end aside), the notice still merges, so it is not shown twice. A row that holds only the
  placeholder, or says anything more or different, keeps the notice; so does a result over 200,000 characters.
- Claude's AskUserQuestion, Codex's request_user_input and every request of kind `question` now turn their row amber
  with 等你回答 ("waiting for your answer") and a question mark icon, apart from 等你批准 (approval, hand icon).
  Expanding the row lists the questions, the options and what you picked.
- Codex approvals and questions carry only `metadata.itemId`, which is the row's call id; such rows now turn amber too.

**Sub-agent card**

- The card shows three short activity rows that the plugin's server reads for it (see Mobile loading and traffic
  below). The server reads only an agent whose record shows it is loaded (the daemon adds `activeTurn` only to loaded
  agents), so a status of "running" saved before the daemon went down no longer counts. When the status check fails
  it reads nothing; the card says it could not confirm the agent is loaded and asks again on the next update. The
  show activity button still reads at once.

**Layout on phones**

- In the iOS and Android apps, text that shares a line with something else no longer runs past the card's edge and
  gets clipped (React Native text does not shrink by default): list items in thinking details, the Pi sub-agent usage
  line, long tool and file names, server names in the code mode catalog, raw tool names in sub-agent activity, field
  names and browser log sources in Paseo tool views. Measured with Yoga 3 and React Native's defaults: 7 to 142 px
  past the edge before, none after.
- On a narrow phone row the title and summary now share one area that gives way, the summary first; the state pill,
  timing, state icon and chevron keep their width. A 320 px row waiting for approval or showing a failure ran 32 px
  and 10 px past the card before, none after.

**Details**

- Times in Paseo tool views (a schedule's next run, last run, expiry, and other ISO times with a zone) show in the
  device's time zone, such as 明天 05:00（9 小时后） ("tomorrow 05:00, in 9 hours"); tap one to see the original. The
  schedule list always shows the next run.
- Plain-text results show the first 20 lines (4,000 characters) and a show all button, so the newest row of an
  ACP agent no longer fills a phone screen.

**New: pinned question**

- In a long turn, the question you asked is pinned above the newest stretch of activity: three lines, tap to read it
  all, with a copy button. A turn the agent started by itself shows your latest question instead. Nothing is pinned
  while the question is still within about a screen. Drawn with React Native, so it works the same on iOS, Android
  and the web; a setting turns it off. The idea comes from [chat-view](https://github.com/lyhu/paseo-plugin-chat-view)
  by lyhu; the code is our own. The server gives up looking for the question after 10 seconds and the app asks again
  later. While the agent runs, the pin moves with the fold index, so about two seconds after the activity does.

**New: Pi extension notices**

- Notices from Pi extensions (background tasks, sub-agents, sub-agent requests and supervisor warnings, web search,
  goals) used to show as a gray row holding the XML written for the model. They now read like
  后台任务「构建」失败（退出码 1） and expand to fields in Chinese (task, state, exit code, error, output file…) and the
  result text; instructions meant for the model are left out. Unknown types show as Pi 通知. The list of message
  formats follows paseo-pi-kit in [springkill/paseo-plugins](https://github.com/springkill/paseo-plugins); the parser
  is our own.
- A notice is bounded before it is parsed (the first 64 KiB of text; in the details, 8 KiB per string and 64 KiB in
  all, 200 entries per list or object, 4,000 values, 8 levels) and parsed in linear time, also when it is tens of
  thousands of blank lines, so a crafted notice cannot stall the timeline or the daemon.

**Hostile input**

- Every regular expression that runs on what agents send (output, commands, paths, notices) was tried against
  inputs crafted to make it backtrack. 31 of them took quadratic time (seconds on tens of kilobytes) and are now
  linear scans or patterns without overlapping repeats, with the same results, checked against the old ones on
  random input. One difference is on purpose: in a shell command, a quote escaped with a backslash no longer opens a
  string, while strings right next to each other (`"one""two"`) are each colored.
- Some of Prism's own grammar patterns backtrack the same way. Code over 4,000 characters is now highlighted in
  chunks of whole lines for about 100 ms at most; the rest, and any single line over 4,000 characters, shows plain.

**Mobile loading and traffic**

- Timeline transforms, row headers and fold state are ready at once; tool details, thinking text, syntax highlighting
  and settings load the first time they are needed, and the first expansion shows plain text meanwhile. Prism comes
  from its official `.min.js` files.
- The parser for Pi extension notices is a second chunk of its own (about 48 KB), loaded when the first such notice
  appears. Until it arrives, such rows read Pi 通知 正在读取… ("reading") without a state, so a failed task does not
  look done for that moment; they are redrawn once the parser is there. If the load fails they stay without a state
  (Paseo marks every Pi custom message completed, so a failed task would otherwise show as done) and read
  没能读取，点开看原文 ("could not read, open for the original"); expanded, they show the message as sent and a
  重新读取 ("read again") button. The load is also tried again after 30 seconds, 1, 2 and then every 5 minutes. Fold
  summaries are not affected: the server reads these notices itself.
- Loaded code is cached by content hash for the app session, so reconnecting does not download it again; each
  registration evaluates it afresh, and settings reach the resident part through a callback. Chunks come in
  sequential replies under 128 KB; a failed load can be retried, and an incompatible version asks you to reconnect.
- The sub-agent card gets three short rows (about 500 bytes) instead of subscribing to the agent's timeline: at most
  every five seconds while the agent keeps changing, and at once when its state changes. Paseo reports a running
  agent's progress only with some events (a model call's usage, a state change), and an ACP agent that reports no
  usage sends none until its turn ends, so a running agent the card has heard nothing about for ten seconds is read
  once more. That read is no news about the agent: an answer still on its way, such as a slow "not loaded", still
  counts, and it adds nothing while a read is on its way.
- Fold indexes are read again only when a boundary first appears or finishes, at most every two seconds while the
  agent runs and not during a retry backoff; virtual `provider:` agents send no requests.

## 0.5.0 (2026-10-11)

Fixes and additions after a review of 0.4.1.

**Terminal output**

- ANSI escape sequences in command output, terminal captures, plain-text results and errors (colors, cursor moves,
  line clearing, window titles, OSC 8 links) no longer show up as `[0m`, `[2K` or `]8;;https://…`; colored output is
  still colored. The preview and "show all" both come from the whole cleaned output, and the line and character counts
  are of the cleaned text. Copy copies the cleaned text; when the output does contain escape sequences, a second
  button copies the original. User messages are left as they are.
- The stripping is a single linear pass with no regular expressions to backtrack. A sequence cut off at the end of the
  output is dropped; an unterminated OSC string ends at the line break, so one broken sequence cannot swallow the
  following lines. The approach follows the `stripAnsi` of [Tidy Timeline](https://github.com/jegork/paseo-tidy-timeline)
  by Jegor Kitskerkin (MIT); the code is our own.

**Sub-agent card**

- Expanding a row for Paseo's create agent tool shows the new agent's latest activity. The card now reads the last
  8 timeline entries instead of 100, and only while the app is in the foreground and the card is on screen (on the web
  it watches the card's position; the iOS and Android apps go by foreground only). Changes it may have missed while
  paused are read once when it resumes, and a burst of live events makes one read.
- Reading the timeline of an agent that is not loaded (status "closed" since Paseo 0.11) makes the daemon load it.
  Before every read it starts by itself, the card asks the daemon for the agent's stored status, which loads nothing.
  For an agent that is closed, archived or no longer in the agent list, the card says so and reads only when you
  press its 查看动态 ("show activity") button. Before, the card of an archived sub-agent kept showing it as running
  and read it again on its last events.

**Approval state**

- A row turns amber the moment the agent asks for your approval. Before, a request that arrived after the chat was
  opened left the row blue until the chat was opened again, because Paseo's SDK forwards agent updates to a plugin
  only once that plugin subscribes to the agent list. While a running row is on screen and the app is in the
  foreground, the plugin now keeps one agent list subscription per host, shared by all rows, limited to running and
  starting agents and with a one-entry snapshot. It is released when no running row needs it or the app goes to the
  background. After a reconnect or a return to the foreground, each watched agent's state is read again, without
  loading any agent. On an isolated daemon the row turned amber 0.1 to 0.2 s after the request and back to blue
  about 0.1 s after approval.

**Folding**

- Bots proposal cards (`propose_skill`, `propose_routine`, `propose_changes`) and app sign-in cards (Composio) now
  end a run of steps in the server's fold index as well, using the same rules as Bots 0.2 and every spelling of the
  tool names (Claude, Codex and others). Before, the tool rows above and below such a card could be folded into one
  summary above it. Without Bots installed, Paseo draws these calls.
- A tool row that another plugin draws between rows of this plugin ends the run too, and a running run's "two most
  recent steps" count only rows this plugin drew.

**Other**

- Pi sub-agent rows are fully in Chinese: titles, statuses and the plugin's own notes. Pi's error texts stay as sent.
- The vivid palette's sub-agent tint is magenta like its icon (it was green). Added diff lines use the "finished"
  green in every palette; they borrowed the sub-agent tint before, which was gray in the soft and high contrast
  palettes. A command's exit code badge, error output and error details, and Pi sub-agent errors use the palette's
  state colors: the vivid palette's red and green instead of the theme's duller ones; other palettes are unchanged.
- Expand and collapse buttons (prompts, show all, image zoom, the code mode catalog, row headers) report
  `aria-expanded`.
- Memory stays bounded in sessions left open for days: what the app keeps per agent beyond its fold index (rows seen
  running, turn starts, expanded folds, keys it could not find, the time of its newest rows) and the keys two agents disagree on are capped, drop
  their older half when full, and are dropped with the agent. Streaming reasoning no longer records a key per chunk.
  The server forgets an agent's turn starts when Paseo closes the agent (archive, delete, restore, daemon shutdown).

## 0.4.1 (2026-10-10)

Security hardening after an outside review of 0.4.0. Image previews, folding and timing work as before.

**Image previews**

- A preview request must name the agent whose chat shows the image, and the daemon must know that agent; otherwise
  nothing is read, not even the temp directory. A sub-agent's own view (`provider:<agent>:<subagent>`) uses its parent
  agent's working directory.
- The temp directory is `os.tmpdir()` alone. `/tmp` is added only on macOS, where agents and browser tools save
  screenshots and `os.tmpdir()` is a per-user folder. A `TMPDIR` that is `/` or contains the home directory is ignored.
- Files are read in 64 KB pieces and never past 3 MB plus one byte, even when a file grows after its size was checked.
  A file that does not start like a supported image is not read past its first 32 bytes, and its size is no longer
  reported.
- After opening, the plugin checks the file it actually opened. On Linux it reads the real path from `/proc/self/fd`,
  so a directory swapped for a link between the checks and the open is refused; elsewhere the checked path must still
  name the same device and inode, which narrows that window.
- A BMP needs a file size field that matches the file, a known DIB header size and a pixel data offset inside the file,
  not just `BM`.

**Parsing limits**

- Looking for JSON after a prefix in MCP and command output tries at most 8 `{`/`[` positions and only text up to
  100,000 characters. Crafted output with nested brackets could keep the app or the daemon busy for minutes.
- The fold index counts a tool call holding more than a million characters as "other" without parsing it, and keys
  reasoning longer than 64 K characters by its length and its first and last 32 K characters.

**Memory**

- The fold index, timings and pending-approval state of an agent none of whose rows has been on screen for 10 minutes
  are dropped, and read again when you come back.

**Tests**

- The Hermes bundle test writes into a private `mkdtemp` directory. The host fixture's agent and message ids are
  synthetic and its timestamps shifted to 2026-01-01.

## 0.4.0 (2026-10-10)

First public release, based on Colorful Agent Activity 0.3.0
([mcowger/paseo-plugins@e65409b](https://github.com/mcowger/paseo-plugins/tree/e65409bbccf6d07c1bbe24dc8eddd902ee10a769/colorful-agent-activity))
by Matt Cowger. Changes from that version:

**Packaging**

- New plugin id `vivid-activity`, so it is offered rows after plugins such as Bots (`paseo-bots`) that turn some tool
  calls into their own cards.
- `@getpaseo/protocol` and `prismjs` are runtime dependencies installed by the manifest's `npm ci --omit=dev`
  preparation step. Without them the original does not compile on Paseo 0.11.1 Git installs. The agent types that
  came from `@getpaseo/client` are now taken from the host SDK, so that package stays a development dependency.
- Requires Paseo 0.11.1.

**Look and states**

- Simplified Chinese interface, including names for 61 Paseo tools.
- New default "vivid" palette: one color and icon per kind of step; running blue with a spinner, waiting for approval
  amber, failed red with the exit code, finished green. The original palette remains as "follow theme".
- The row that waits for your approval is matched to its permission request.
- Motion listeners only on rows that move; a slightly stronger state tint in the light theme.

**Folding, density and timing**

- Finished runs of thinking and tool steps fold into one summary row; running runs keep only active, waiting, failed
  and the two latest steps open.
- Compact row density (4 px between rows) by default.
- Per-step durations estimated from the projected timeline and bounded by the agent's turn; live counters for
  running rows.

**Detail cards**

- Layered cards; command boxes with a program badge, exit code and copy buttons; file boxes with a language badge,
  line numbers and copy; a step rail for multi-step thinking.

**Behavior**

- A "takeover" setting: all rows, thinking rows only, or off.
- Plan cards and task lists are left to Paseo; the Activity Summary panel was removed.
- Claude Code failures show the error text instead of the raw tool result; MCP results wrapped as `{ output }` reach
  the GitHub, Exa and Paseo views; the task notice Claude Code adds after a command with a timeout merges into that
  command's row, and background command notices get a row of their own.
- Image previews only read files inside the agent's working directory or the system temp directory.
