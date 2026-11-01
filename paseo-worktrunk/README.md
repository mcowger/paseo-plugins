# Paseo Worktrunk

Experimental server-only integration between Paseo worktrees and [Worktrunk](https://worktrunk.dev/).
Paseo remains responsible for creating, owning, restoring, and removing worktrees.

## Requirements

- `wt` on the Paseo daemon's `PATH`. Tested with Worktrunk 0.81.0.
- Paseo 0.15.0-beta.1 or later.

Install the local directory using `paseo plugin install /absolute/path/to/paseo-worktrunk`.
The plugin does not require a client bundle, shell integration, or plugin-specific settings. The
Paseo daemon, not the app, must be able to find `wt`.

## Behavior

When `wt` is installed, the plugin asks `wt step eval` for the expected path for the requested
branch, using Worktrunk's own user configuration and path template. Even without a config file,
Worktrunk has a default sibling-directory layout; installing `wt` therefore opts into that layout.
For example, configure a personal layout in `~/.config/worktrunk/config.toml`:

```toml
worktree-path = "{{ repo_path }}/../{{ branch | sanitize }}"
```

If `wt` is missing, the path calculation fails, or the resulting path is invalid or already exists,
the plugin logs a warning and Paseo uses its original path. Paseo performs its own final path
validation; a concurrent path collision can still cause creation to fail. Git may choose a different
final branch name after the path was calculated, leaving the path named for the requested branch.

After Paseo creates the worktree, the plugin runs `wt hook pre-start` and then `wt hook post-start`
in the new worktree. Worktrunk reads its user configuration and the new checkout's
`.config/wt.toml`, for example:

```toml
[pre-start]
setup = "npm ci"

[post-start]
copy = "wt step copy-ignored"
```

Worktrunk project hooks require approval. From the new worktree, inspect `wt config approvals list`
and approve the commands separately with `wt config approvals add` after reviewing them. The plugin
never passes `--yes` and cannot answer prompts. Worktrunk can skip unapproved commands or fail in a
non-interactive session.

Missing `wt`, path calculation errors, and hook errors or timeouts are reported in
`paseo plugin logs paseo-worktrunk` without command output or error text, which may contain secrets.
They **do not abort Paseo creation**; a failing pre-start skips post-start. Check Worktrunk approvals
and logs when a setup warning appears. Pre-start has a 15-second timeout and post-start has an
8-second invocation timeout. Worktrunk normally starts post-start tasks in the background, so they
can still be running when the first agent starts, and later background failures are not reported by
the plugin. A timeout does not guarantee that a hook's child processes have stopped.

This is not a full `wt switch`: switch hooks and operation-specific context are not reproduced.
For example, with Worktrunk 0.81.0 the standalone start hooks resolve `base` and
`base_worktree_path` to the new worktree, not the source checkout.
Paseo may also copy `.worktreeinclude` files and run its own setup; avoid conflicting duplicate
operations. Recovery uses the recorded path without running these hooks, and Paseo archive does not
run Worktrunk's remove hooks. Avoid removing a Paseo-owned worktree independently with `wt remove`.

## Development

From this directory, run `npm install`, `npm run lint`, `npm run typecheck`, and `npm test`.
The tests include a real Git/Worktrunk integration check when `wt` is installed (skipped on Windows).
