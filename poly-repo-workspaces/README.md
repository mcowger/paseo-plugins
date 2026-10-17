# poly-repo-workspaces

A Paseo plugin (targeting Paseo 0.11+, SDK `0.11.4`) that manages virtual
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

## Configure

Settings → Poly-repo: add an uber-project (repo sources, branch and directory
templates, agents template file). The default virtual root is
`$PASEO_HOME/poly-workspaces/` and can be overridden to any absolute path that
is not under the daemon's worktrees root.

## Use

- Sidebar rows and the Poly-repo screen list managed workspaces; the screen
  also creates them (feature name + uber-project).
- The Poly-repo workspace panel shows per-repo branch/dirty/ahead status,
  regenerates `REPOMAP.md`, and archives with a dirty/ahead preflight.
- Archiving removes the constituent worktrees and the root directory.
  Branches are never deleted. Dirty or ahead repos block removal until
  resolved or explicitly forced.

Push and PR orchestration are out of scope by design.
