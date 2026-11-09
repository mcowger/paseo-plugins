Vivid Activity redraws an agent's thinking and tool-call rows in the chat as compact, color-coded activity rows. Every kind of step has its own color and icon, from violet thinking and blue reads to green edits and orange commands. Every row also shows its state: a blue spinner while it runs (or a sparkle, orb or dot grid), an amber pulse while it waits for your approval or your answer, red when it fails (with the exit code for commands), and a short green flash when it finishes.

A finished run of thinking and tool steps folds into one summary row with the number of steps, a count per kind, failures, the total time and what it changed, such as `3 files +12 −4` with a five-block diffstat; tap it to list each file and failed command, then the steps. While the agent is still working, only the running, waiting and failed steps and the two most recent ones stay visible. Under the last summary of a turn you watched, the turn's input, cached and output tokens appear. Every row shows its step's time, counting up live while it runs. In a long turn, your question stays pinned above the newest stretch of activity.

Based on Colorful Agent Activity by Matt Cowger; the change summary adapts code from paseo-chat-polish by Hieu Le.

## What the rows show

Expanding a row shows highlighted commands with output and exit code, file reads with line numbers, colored diffs, previews of images the agent read, and dedicated views for OMP search, eval and batched agent tasks, Paseo's tools, and GitHub and Exa results. Command output hides terminal escape codes but keeps its colors. Background-task notices from Claude Code and notices from Pi extensions become short localized rows colored by outcome. Times in schedule details use your device's time zone. Plan cards, task lists, permission prompts and other plugins' cards (such as Bots proposals) are left alone and end a fold.

## Settings

No setup is needed. Requires Paseo 0.11.1 or later. Open the Vivid Activity settings page from Paseo's
Settings → Plugins, from the Vivid Activity row in the app's sidebar, or from "Open Vivid Activity settings"
in the Command Center — all three show the same page:

- Language: the device language by default, English, Simplified Chinese, or your own translation in `~/.paseo/plugin-data/vivid-activity/locales/`.
- Takeover: all rows (default), thinking rows only, or off.
- Fold finished thinking and tool steps: on by default.
- Row density: compact (default, 4 px gaps) or standard (10 px).
- Strength: full (default), 65%, 45% or 30% — finished rows sit back at that opacity until you hover, focus or expand them; rows with nothing to expand stay at full strength. Finished fold summaries dim too; expand or hover one to restore it.
- Pin this turn's question: on by default.
- Palette: vivid (default), follow the theme accent, soft, or high contrast.
- Running animation: spinner (default), sparkle, orb, or a dot grid as a snake or a twinkle, with live previews.
- Code font: family (web, desktop), size, line spacing.
- Command colors: when open (default) or always — the shell command in a row's title carries the theme's syntax colors.
- Wrap diff lines: off by default (long diff lines scroll sideways); on wraps them to the width.
- Thinking rows: follow the output live (default off) with a 5–500 line window (default 20); the per-row Expand all still shows everything.
- Follow new output: one switch per area (command output, worktree and sub-agent logs, task lists, browser), on by default. While a row is still running, its open details stay at the newest output and long output shows its latest 20 lines; finished rows open at the top.
- Expansion for each kind of row: always, newest only, failed only, or collapsed. A fold summary with failures starts expanded.

A preview card at the top of the settings page shows sample rows that follow the strength, palette and wrap settings live.

Settings live on the daemon and apply to every connected device; settings saved by earlier versions carry over when you upgrade. Agent output, prompts and paths keep their original text.

## Data and permissions

- To fold and time rows, the plugin's server part reads the timeline of the agent you are viewing inside the daemon and sends the app a compact index: each row's position, end time, kind, status and category, tool call and turn ids, text lengths, a short hash of thinking text, lines added and removed with a short hash of each file's path, failed commands' exit codes, and the token figures of turns you watched. No text, path, command or tool output is part of it. For the pinned question it sends that message's text.
- Token figures come from the agent record Paseo keeps. To read them by provider, the server part reads the daemon's `config.json`, keeping only each custom provider's `extends`, and while a Codex-based turn runs it subscribes inside the daemon to running agents' updates to add up every request.
- To preview an image the agent read, it reads only a regular file of at most 3 MB inside that agent's working directory or the system temp directory, resolving links first. A file that is not an image is not read past its first 32 bytes.
- For Paseo's create agent row, the server part sends three short rows from the new agent's last 8 timeline entries while the app is in front and the row on screen, asking another connected host for an agent running there; a closed or archived agent is read only when you press Show activity, since reading loads it.
- While a running row is on screen and the app is in front, it subscribes to running agents' updates, so a row turns amber when approval is requested.
- It makes no network requests of its own, starts no processes and reads no credentials; it writes only language templates and state in its plugin data folder. Of the environment it uses PASEO_HOME and HOME for that folder and the daemon config, and TMPDIR and HOME for image checks.
- Installing from Git runs a preparation step that installs two packages from the public npm registry, pinned by the lockfile: Paseo's protocol package and Prism for highlighting.

## Known limits

- Paseo gives each timeline row to the first plugin, in id order, that returns a result: plugins that also redraw these rows, such as Beautiful Chat or Colorful Agent Activity, take them, so use only one.
- While tool rows are taken over, Paseo's summary mode no longer groups tool calls, file paths cannot be tapped open, and on phones tool details expand in the row; set takeover to thinking rows only or off to get these back.
- Paseo records only when each step ended, so a row's time starts at the previous step's end.
- Only exact line counts are shown. Writes, deletions, cut-short diffs and Codex patches (Paseo keeps only their first file) count as changes without line counts.
- Turn tokens show only for Claude-, Codex- and ACP-based providers and turns watched while they ran, and not after a plugin reload or daemon restart.
- Folded and expanded rows are remembered for this session only.
- A sub-agent's own chat view is not folded or timed.
