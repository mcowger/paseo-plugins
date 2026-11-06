# poly-repo-workspaces

A Paseo plugin (targeting Paseo 0.12+, SDK `0.12.0`) that manages virtual
workspaces spanning multiple git repos. See [DESIGN.md](./DESIGN.md) for the
full design.

One virtual workspace is one native Paseo directory workspace whose root holds
a git worktree per repo plus shared context files:

```text
<virtual-root>/uber-project-featureA/
  frontend_featureA/
  app_featureA/
  mobile_featureA/
  AGENTS.md
  REPOMAP.md
  .polyrepo.json
```

Each repo worktree is also registered as its own Paseo directory workspace in
the virtual root's project, so the sidebar shows one section per virtual
workspace with a real repo row inside it. Those rows are ordinary checkouts:
native changes/diff, branch state, commits, push, PR status. Only the grouping
is virtual.

## Configure

Open **Poly-repo** from the sidebar or command center and choose **Configuration**.
Add an uber-project (repo sources, branch and directory templates, agents template
file). The default virtual root is
`$PASEO_HOME/poly-workspaces/` and can be overridden to any absolute path that
is not under the daemon's worktrees root.

Each repository can have an optional init script. After all worktrees exist,
the plugin registers the root and repo workspaces before running the scripts
in repository order, each with its worktree as the current directory. On Unix
it uses `$SHELL -lc` (or `/bin/sh` if `SHELL`
is unset), so login startup files can load environment settings. It is
non-interactive, not a Paseo terminal: prompts cannot be answered and
interactive-only shell configuration may not be loaded. On Windows it uses
`%ComSpec% /d /s /c`. Scripts run with the daemon user's permissions and
environment; only configure commands you trust. Output is not displayed.

An init failure leaves the workspace in creating state. Fix the script or its
environment and use **Resume** to retry the failed script; scripts that already
succeeded are not repeated. A script interrupted before success was recorded
may run again, so scripts should tolerate retries. Setup also runs for imported
workspaces. It does not run when reopening or repairing an existing worktree.

## Use

- The Poly-repo sidebar entry opens the workspace screen, even when there are
  no workspaces yet. The screen creates and lists managed workspaces.
  The screen scrolls on smaller displays and keeps the create form and workspace
  list in separate sections.
- Feature names can be descriptive, like `SIG: ABSCD - Fix My Stuff`. The
  visible name stays as entered; branches and folder templates use
  `sig-abscd-fix-my-stuff`. Existing Git-safe names stay unchanged, including
  their case. The create form previews the branch before you submit.

- To import a common branch, choose it from the management screen's branch list.
  Discovery considers branches already available locally and `origin`
  remote-tracking branches; it does not fetch from the network. Existing checked-
  out branches cannot be imported. The selected branch is checked out in the new
  worktrees, while the workspace feature/display name remains independently
  editable (initially populated from the chosen branch).

- Select **Create from default branches** to create a workspace from each repo's
  default. The feature name defaults to `default` if left blank. Discovery uses
  the configured branch first, then local `origin/HEAD`.
  If that ref is missing, it may query `git ls-remote --symref origin HEAD`
  for GitHub HTTPS/SSH origins only. It does not fetch refs or modify the
  checkout, and the reported branch must already exist locally or as an
  `origin` remote-tracking ref. Configure a per-repo base branch if lookup is
  unavailable. If a default branch is already checked out elsewhere, the new
  worktree uses detached HEAD. Create a branch there to keep commits reachable.
- Creation and resume run in the background. The workspace page and panel show
  per-repo checkout and init status. Registered workspaces can be opened while
  scripts run; setup is not complete until they finish. The form stays disabled
  during creation. After a plugin reload, use Resume for a workspace left in
  the creating state.
- The Poly-repo workspace panel groups each repo's setup and Git status in a
  scrollable card with terminal, open, and copy-path actions. It also regenerates
  `REPOMAP.md` and archives with a dirty/ahead preflight.
- In the sidebar's project grouping mode, every virtual workspace is one
  collapsible project section named after its root directory. Rows are titled
  `<feature> / Root` and `<feature> / <repo>`, so a row always names the feature
  it belongs to; a title you set by hand is left alone. Row order is Paseo's
  per-user persisted order (new rows land on top), so the root's position is
  whatever you last dragged it to. Open a repo row to review or land that repo's
  changes with Paseo's own git surface; the agent keeps working at the virtual
  root across all of them. Rows archived by hand come back on Resync while the
  worktree still exists.
- Archiving removes the constituent worktrees and the root directory.
  Branches are never deleted. Dirty or ahead repos block removal until
  resolved or explicitly forced.
  Archiving runs in the background, so large worktree removals can finish
  without holding a single RPC open. After a plugin reload, use Resync to
  continue an interrupted archive.
  When the plugin created the Paseo project, it also removes that project if
  it has no active workspaces. This uses `paseo project delete`, which also
  removes archived workspace records; a workspace added between the check and
  deletion can be removed too. Shared projects and older projects without
  recorded ownership are left in place.
- If archiving fails, the management screen's **Force delete** action retries
  teardown after confirmation. It removes dirty worktrees, including uncommitted
  changes, and keeps branches. If Git cannot remove a worktree, it deletes the
  directory, including nested paths from branch names containing `/`, and checks
  that Git pruned its metadata. Prune or filesystem errors
  block cleanup and can be retried. Paseo workspace rows can remain if their
  archive fails; remove those rows separately.

Push and PR orchestration are out of scope by design.
