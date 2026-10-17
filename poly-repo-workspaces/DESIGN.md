# Poly-repo virtual workspaces

Status: design only. No implementation yet.
Target: Paseo 0.11+. Plugin id (proposed): `poly-repo-workspaces`.
SDK pin (Phase 0 confirmed): `@getpaseo/client`, `@getpaseo/plugin`,
`@getpaseo/protocol` at exactly `0.11.4` (latest 0.11 patch, tag `v0.11.4`).

## Problem

Some projects are several repos that can't be merged. Coordinated work still
happens across all of them:

- `frontend` (React + TypeScript)
- `app` (Bun + TypeScript)
- `mobile` (Swift)

A feature often needs matching changes in two or three repos at once. Today that
means juggling separate Paseo workspaces, separate worktrees, and agents that
can only see one repo.

The fix is a virtual workspace. One directory holds a git worktree per repo,
plus shared context files at the root:

```text
<virtual-root>/uber-project-featureA/
  frontend_featureA/
  app_featureA/
  mobile_featureA/
  AGENTS.md
  REPOMAP.md
  .polyrepo.json
```

Agents and terminals start at `uber-project-featureA/`. On archive, the
constituent worktrees go away with it. Branches stay.

Push and PR orchestration are out of scope. The plugin reports dirty/ahead
state and stops there.

## Decisions

These are settled. Implementation should not re-open them without a reason.

| Topic | Decision |
| --- | --- |
| Workspace shape | One native Paseo directory workspace per virtual workspace. The plugin makes the directory tree, then registers it. |
| Branch policy | Same branch name on every repo, cut from each repo's base branch. Fail before creating anything if the branch exists or is checked out anywhere. |
| Root files | `AGENTS.md` comes from a configured template file (token substitution). `REPOMAP.md` is generated from the repo list and repo contents. |
| Failure handling | Repair-first. A failed create leaves worktrees and manifest in place for resume or manual teardown. No auto-rollback. |
| Archive policy | Plugin archive action preflights each repo. Dirty or ahead-of-upstream constituents block worktree removal and leave the tree marked `teardown-blocked`. Branches are never deleted. |
| Virtual root location | Default `$PASEO_HOME/poly-workspaces/`. Host setting can override it to any absolute path. Per-uber-project override wins over the host setting. Never under `worktrees.root`. |
| Platform target | Paseo 0.11+. `paseo-plugin.json` declares `requirements: { "paseo": ">=0.11.0" }`. SDK pins at exactly `0.11.4` (this deviates from the repo-wide 0.10.0 baseline on purpose). |

## Why this shape

Paseo's workspace model drives everything here. Three facts, all verified in
the local Paseo checkout (`~/workspace/paseo`, checked at 0.12.0-beta.2 and
against the `v0.11.0` tag for the load-bearing parts):

1. A workspace is one directory in one project. There is no multi-root
   workspace type, and the create API only accepts a `directory` or `worktree`
   source (`WorkspaceCreateRequestSchema`, `packages/protocol/src/messages.ts`).
   Plugins can't add a new workspace shape.
2. Git detection runs `git rev-parse --show-toplevel` from the workspace cwd
   (`packages/server/src/utils/checkout-git.ts`). It walks up, never down. A
   directory of sibling repos reads as `non_git` at the root. So the virtual
   root gets a working file explorer and no native git panel. Per-repo git
   state is the plugin's job.
3. A plugin server gets a full `PaseoApi` (`PluginHandlerContext.paseo`,
   `packages/plugin/src/server/contracts.ts`). Handlers can create, open, and
   archive workspaces, and create agents and terminals. That is the supported
   path. No CLI subprocess, no raw protocol, no daemon core changes.

Given those facts, the directory workspace is not a workaround. It's the only
shape that puts agent cwd at the virtual root, which is the main thing we want.
In current Paseo, an agent created with a `workspaceId` has its cwd forced to
the workspace root, so agents land in the right place by default. Terminals
take an explicit cwd, so per-repo terminals work too.

### Alternatives considered

- One native worktree workspace per repo, grouped only in plugin UI. Native git
  per repo, but agent cwd is a single repo and the sidebar fills up with
  constituents. This misses the point.
- A meta-repo plus `paseo.json` `worktree.setup` scripts that create the
  sub-worktrees. Indirect, hard to error-handle, needs a repo that only exists
  to hold scripts.
- DOM injection to group native sidebar rows (the `paseo-plugin-clusters`
  technique). Desktop/web only, depends on `data-testid` attributes, breaks
  when the sidebar changes. Maybe later as an optional extra. Not the base.

Prior art check: as of this writing, no plugin in the paseo.cafe catalog (246
entries) does poly-repo grouping. Closest references worth reading before
building:

- `paseo-plugin-clusters` for grouping UX and server-side persistence
- `paseo-workspace-snippets` for workspace/terminal orchestration
- `firstmate` and `paseo-agent-todos` for `workspaces.open(...).agents.create(...)`
- `plugin-examples/lifecycle-actions` in the Paseo repo for lifecycle hooks
- `branch-garden` for a per-workspace branch/worktree panel

## The worktrees-root trap

One decision deserves its own section because it changed during design.

Paseo treats any path of the form `<worktrees-root>/<anything>/<anything>`
as a Paseo-owned worktree. `isPaseoOwnedWorktreeCwd`
(`packages/server/src/utils/worktree.ts`, identical in `v0.11.0`) says so in
its own comment: the path shape alone is proof of ownership, and it never
validates the hash segment. It also truncates the owned path to the first two
segments, so a constituent at `<root>/poly/uber-project-featureA/frontend_featureA`
resolves as owned path `<root>/poly/uber-project-featureA`.

The normal workspace archive path is safe anyway. A directory workspace
persists `kind: "directory"` and `isPaseoOwnedWorktree: false`, and
`resolveWorkspaceBackingDirectory`
(`packages/server/src/server/workspace-archive-service.ts`) skips deletion for
non-worktree records. But two hazards stay live for anything under
`worktrees.root`:

- Worktree-scoped archive (`archiveCommand` with `scope: "worktree"`,
  `packages/server/src/server/worktree/commands.ts`) checks only the raw path
  function. Pointed at a virtual root, it would recursively delete the whole
  tree, constituents included.
- Opening a constituent as its own workspace persists it as a Paseo-owned
  worktree (its cwd contains a `/worktrees/` segment). Archiving that
  workspace later would force-remove the constituent out from under the
  virtual workspace.

So virtual roots stay out of `worktrees.root` entirely, and creation enforces
it (see validation below). This is also why the default is a plain
`$PASEO_HOME/poly-workspaces/` and the override can be any absolute path
except that namespace.

## Layout

Default:

```text
$PASEO_HOME/poly-workspaces/
  uber-project-featureA/
    frontend_featureA/
    app_featureA/
    mobile_featureA/
    AGENTS.md
    REPOMAP.md
    .polyrepo.json
```

Root resolution order:

1. Per-uber-project `virtualRootBase`
2. Host setting `virtualRootBase`
3. `$PASEO_HOME/poly-workspaces`

Directory naming comes from templates in the uber-project config. Defaults:

- Root: `{uberProject}-{feature}` → `uber-project-featureA`
- Constituent: `{repo}_{branch}` → `frontend_featureA`

The rendered names get stored in the manifest. Nothing re-derives paths from
templates after creation.

### Root validation

The server validates the resolved root before creating anything:

1. Expand tilde, resolve to an absolute, normalized path.
2. Reject if it equals or sits under the current `worktrees.root` (read live
   from daemon config at create time, since users can move it).
3. Reject if it sits inside any constituent's source repo.
4. Create it if missing; fail with a surfaced error if it isn't writable.

If the setting changes later, existing virtual workspaces keep working. Their
absolute roots are recorded in the manifest and the server index at creation
time. Discovery and reconciliation read those records, not the current
setting. The new base only applies to new workspaces.

## Data model

Three kinds of state, all server-side. Clients pass stable IDs over RPC, never
paths. The server re-resolves and authorizes every path from its own records.

### Uber-project config

What the user defines once per project group. Stored as versioned,
Zod-validated JSON under the plugin's data directory
(`$PASEO_HOME/plugin-data/poly-repo-workspaces/`), written with serialized
read-modify-write and atomic temp-file rename.

```ts
UberProject {
  id: string                    // "uber-project"
  displayName: string
  virtualRootBase?: string      // absolute path override
  branchTemplate: string        // default "{feature}"
  rootDirTemplate: string       // default "{uberProject}-{feature}"
  repos: RepoConfig[]
  agentsTemplatePath: string    // source file for root AGENTS.md
}

RepoConfig {
  id: string                    // "frontend"
  sourcePath: string            // canonical main checkout, server-side only
  dirTemplate: string           // default "{repo}_{branch}"
  baseBranch?: string           // default: detect from origin/HEAD
}
```

### Instance manifest

One per virtual workspace, at `<root>/.polyrepo.json`. This is the durable
record that makes repair and reconciliation possible.

```ts
Manifest {
  version: 1
  virtualId: string
  uberProjectId: string
  feature: string               // "featureA"
  branch: string                // rendered branch name, same on all repos
  rootPath: string              // absolute
  workspaceId: string | null    // Paseo workspace, set after registration
  state: "creating" | "ready" | "archiving" | "teardown-blocked" | "archived"
  constituents: [{
    repoId: string
    sourcePath: string
    worktreePath: string        // absolute
    branch: string
    baseBranch: string
    state: "pending" | "created" | "removed"
  }]
  createdAt: string
  updatedAt: string
}
```

### Server index

A small index file in the plugin data directory mapping
`virtualId → { rootPath, workspaceId, uberProjectId }`. It exists so the
server can find managed roots without scanning the filesystem, and so it can
match `workspace.archived` events to manifests by workspaceId and cwd.

## Components

Standard plugin layout. `client/`, `server/`, `shared/`, nothing else.

### Shared

- Zod schemas for uber-project config, manifest, and RPC inputs/outputs
- `defineRpc` contracts (names below)
- Pure helpers: directory/branch template rendering, REPOMAP text building,
  git status parsing, presentation models (labels, grouping, sorting)

### Server

Owns everything with side effects:

- RPC handlers (details below)
- Git operations through `execCommand`/`spawnProcess` from
  `@getpaseo/plugin/server`, always argument arrays, never shell strings
- Filesystem work: mkdir, template reads, manifest writes
- Workspace/agent/terminal creation through `context.paseo`
- Lifecycle hooks:
  - `server.on("workspace.archived")` for the teardown cascade
  - `server.on("workspace.created")` to adopt a workspace a user created by
    hand over a managed root
  - `server.before("workspace.create")` is available but not needed for the
    MVP

### Client

0.11+ contribution points:

- `addSidebarHeaderItem` or `addSidebarFooterItem`: one row per virtual
  workspace, grouped under its uber-project, aggregate status dot (any repo
  dirty or ahead). Click opens the native workspace.
- `addScreen`: full list of virtual workspaces grouped by uber-project, with
  create, archive, repair, and teardown-blocked states.
- `addWorkspacePanel` (`locations: ["workspace", "explorer"]`): the poly-repo
  tab inside a virtual workspace. Constituent table with branch, dirty,
  ahead/behind, diffstat, and per-repo actions.
- `addSettingsScreen`: uber-project config editing, virtual root override.
- `addCommandCenterItem`: "New poly-repo workspace" (global), "Archive
  poly-repo workspace" (workspace context).
- Navigation is limited to what Paseo exposes: `openWorkspace`, `openAgent`,
  `openScreen`. There is no way to group, hide, or relabel native sidebar
  rows, and the design doesn't try. The virtual workspace shows up in the
  native list as one normal workspace. That's fine.

RPC contracts (names are proposals):

```text
polyrepo.list-virtual-workspaces
polyrepo.get-virtual-workspace
polyrepo.create-virtual-workspace
polyrepo.archive-virtual-workspace
polyrepo.repair-virtual-workspace
polyrepo.list-uber-projects
polyrepo.save-uber-project
polyrepo.delete-uber-project
polyrepo.get-repo-statuses
polyrepo.regenerate-repomap
```

## Creation flow

Triggered from the command center, the screen, or the sidebar. One RPC,
`create-virtual-workspace`, with `{ uberProjectId, feature, baseBranchOverrides? }`.

1. Load the uber-project. Render branch, root dir, and constituent dir names.
2. Preflight everything, change nothing:
   - Root validates (see above) and doesn't already exist as a managed root.
   - Each `sourcePath` exists and is a git repo.
   - Base branch resolves per repo (`baseBranch` config, else `origin/HEAD`).
   - Target branch does not exist in any repo and is not checked out
     anywhere. Any failure aborts with a per-repo report.
3. Create the root directory. Write the manifest with `state: "creating"`,
   all constituents `pending`.
4. Per repo, in config order:
   `git -C <sourcePath> worktree add -b <branch> <worktreePath> <baseBranch>`.
   Mark the constituent `created` in the manifest after each success. This is
   what makes a mid-flow failure resumable: repair re-runs only the pending
   constituents, after re-running preflight for them.
5. Render `AGENTS.md` from the template file. Generate `REPOMAP.md`.
6. Register the workspace:
   `paseo.workspaces.create({ source: { kind: "directory", path: rootPath }, title })`.
   Store the returned workspace id in the manifest and index. Set
   `state: "ready"`.
7. Optional, behind create-form checkboxes: create the first agent
   (`workspace.agents.create(...)`, cwd lands at the root) and one terminal
   per repo (explicit per-repo cwd).

If step 4 fails halfway, the manifest says exactly where it stopped. The
screen offers Resume and Tear down (the teardown path from the archive flow,
minus the workspace archive step). Nothing deletes work silently.

### AGENTS.md template

Plain file copy with token substitution. Tokens:

- `{{feature}}`, `{{branch}}`, `{{uberProject}}`
- `{{repos}}`: rendered list of constituent dirs and what each repo is

The generated file should tell agents the one thing they can't infer: the
root is not a git repo, each subdirectory is, and git commands need a
subdirectory cwd.

### REPOMAP.md generation

Built server-side at create time, regenerated on demand from the panel:

- One section per repo: id, source path, branch, base branch
- Bounded top-level tree per repo (depth and entry caps)
- Contents of a per-repo `REPOMAP.md` if one exists, else a short readme
  excerpt
- Total size cap; truncate with a note rather than fail

No watcher. It goes stale as repos change, and the panel shows when it was
generated. Manual regenerate is enough.

## Repo status aggregation

The panel's data comes from `get-repo-statuses`, server-side, per constituent:

- `git status --porcelain` for dirty state and changed-file count
- Current branch and upstream ahead/behind
- `git diff --stat` summary for uncommitted work

All paths come from the manifest, output is size-capped, and each repo fails
independently. One broken repo shows an error row; the rest of the table
still renders.

## Archive flow

Two entry points, because Paseo has `workspace.archived` but no
`before("workspace.archive")` hook. Plugins can react to archive. They can't
veto it.

### Plugin archive action (the normal path)

1. `archive-virtual-workspace` RPC preflights every constituent: dirty?
   ahead of upstream?
2. If anything is dirty or ahead, the client shows the list and stops. The
   user commits/pushes themselves (out of scope for the plugin) or confirms
   per-repo force removal knowing uncommitted work would be lost. Default is
   stop.
3. Clean (or confirmed): mark manifest `archiving`, then
   `paseo.workspaces.archive(workspaceId)`. Paseo archives the agents and
   kills the terminals. It will not delete the directory (directory
   workspace, not Paseo-owned).
4. The `workspace.archived` hook fires and runs the cascade below.

### Cascade (hook, also the native-archive path)

On `workspace.archived`, look up the manifest by workspaceId/cwd. If it's a
managed root:

1. Re-check each constituent. A native archive skipped preflight, so this
   check is the safety net.
2. Clean constituents: `git -C <sourcePath> worktree remove <worktreePath>`,
   then `worktree prune`. Branches are left alone.
3. Dirty constituents: skip removal, mark the manifest `teardown-blocked`,
   keep the root directory. The screen lists it with what's dirty and offers
   Open (re-register the root as a workspace) and Force clean.
4. If all constituents are removed, delete the root directory, mark the
   manifest `archived`, and drop the index entry.

The cascade is idempotent. Running it twice, or running it after a partial
manual cleanup, lands in the same place. Constituent states in the manifest
drive what's left to do.

One related case: a constituent opened as its own workspace (the panel's
escape hatch) and then archived. Because roots live outside `worktrees.root`,
Paseo won't delete that directory on archive. The workspace record goes away,
the worktree stays, and reconciliation (below) notices the mismatch only if
we recorded that extra workspace id. MVP stance: the escape hatch opens the
workspace but the plugin doesn't track it. If the user deletes the worktree
by hand, the panel shows that constituent as missing with a repair action.

## Reconciliation

On server start, and on a slow periodic backstop while running:

- Load the index. For each entry, read the manifest at the recorded root.
- Root missing: mark the entry orphaned, surface it, offer Clean up (prune
  any surviving git worktree registrations with `worktree prune` per source
  repo) and Forget.
- Manifest present but workspace id archived or unknown: state shows as
  detached; Offer Reopen (`workspaces.open(rootPath)`).
- Workspace exists at a managed root with no index entry (user created it by
  hand): adopt it via the `workspace.created` hook if a manifest is present,
  ignore it if not.
- Constituent worktree missing on disk: panel-level missing state with
  repair (re-run the `worktree add` for that constituent, checkout mode
  since the branch should already exist).

Live updates ride on `workspaces.subscribe` plus query invalidation after
mutations. The periodic pass is a recovery backstop, not the main mechanism.

## Security and safety rules

- Repo source paths and worktree paths live server-side only. RPC inputs use
  IDs (`uberProjectId`, `virtualId`, `repoId`). The server re-resolves every
  path from config/manifest records.
- Git runs with argument arrays via `execCommand`/`spawnProcess`. No shell
  interpolation of branch names, features, or paths. Branch and feature names
  still get validated against a conservative pattern before use.
- Every git output that feeds the UI is size-capped and parsed defensively.
- The plugin never pushes, fetches for mutation, or deletes branches. Fetch
  for ahead/behind display is a read-only question; MVP computes ahead/behind
  from local upstream refs without fetching.
- Manifest writes are atomic (temp file + rename) and serialized per root.
- No credentials are involved. Source repos are local paths the user already
  has access to.

## Non-goals

- Push, PR creation, or any cross-repo release orchestration
- Merging or replacing the constituent repos
- Native sidebar regrouping or hiding (not possible via supported APIs)
- Aggregated native git UI at the root (Paseo renders git per workspace;
  the root is `non_git` and stays that way)
- DOM injection into the sidebar (possible later, desktop-only, off by
  default)
- Changing Paseo core. Everything here uses documented plugin APIs.

## Implementation phases

Each phase ends with lint, typecheck, and tests green, per repo rules. Test
on an isolated daemon, not the one hosting the dev conversation.

### Phase 0: verification spike

Code-level verification done against tag `v0.11.4` (all confirmed, see
Phase 0 exit note below). Live spike against an isolated daemon still open.

- [x] Exact 0.11.x SDK version to pin: `0.11.4` (latest 0.11 patch).
- Plugin handler can call `paseo.workspaces.create` with a directory source
  over a pre-made non-git directory.
- Agent created in that workspace runs with cwd at the root and picks up the
  root `AGENTS.md`.
- `terminals.create({ workspaceId, cwd })` honors a subdirectory cwd.
- `workspace.archived` hook fires with enough info (id, cwd) to match the
  manifest.
- Sidebar header/footer component API and `workspaces.subscribe` behave as
  documented.

Exit: list of confirmed API shapes, SDK pin chosen. If agent cwd or archive
hooks don't behave, the design changes here, not later.

Phase 0 exit note (code verification, tag `v0.11.4`): all items below
confirmed from source. No design changes needed. Live behavior (agent cwd
at root, hook delivery timing) still needs one run against an isolated
daemon, never the daemon hosting the dev session.

- `PluginHandlerContext.paseo: PaseoApi` and `PluginHookContext.paseo`
  present (`packages/plugin/src/server/contracts.ts`, `lifecycle.ts`).
- `source: { kind: "directory", path }` requires only that the directory
  exists (`directory_not_found` otherwise); non-git dirs fine
  (`session.ts` `handleWorkspaceCreateLocal`).
- Agent with `workspaceId` gets cwd forced to `workspace.cwd`
  (`resolveSessionCreateAgentIntent`); without `workspaceId` an arbitrary
  cwd mints its own directory workspace. Virtual-root default confirmed.
- `PaseoTerminalCreateOptions.cwd` is explicit and optional (defaults to
  workspace dir); per-repo terminal cwd confirmed
  (`packages/client/src/terminals/index.ts`).
- `workspace.archived` carries `{ id, projectId, cwd, name, archivedAt }`.
  Enough to match the manifest by id and cwd.
- Sidebar is component-based: `addSidebarHeaderItem` / `addSidebarFooterItem`
  plus `addScreen`. Old `addSidebarItem` / `addSurface` exist only as
  deprecated aliases (`COMPAT(pluginSidebarAliases)`).
- `workspaces.list({ subscribe: {} })`, per-handle `subscribe`, and project
  list/subscribe all present.
- `spawnProcess` / `execCommand` / `terminateProcess` exported from
  `@getpaseo/plugin/server`.
- Daemon config key is `worktrees.root` (`WorktreesConfigSchema`,
  `persisted-config.ts`); readable via `paseo.config.get()`. Default
  resolves to `$PASEO_HOME/worktrees`.
- Worktree ownership check byte-identical to 0.12: no hash validation,
  two-segment truncation. The stay-out-of-`worktrees.root` rule stands.

### Phase 1: MVP

- Plugin skeleton: `paseo-plugin.json` (`requirements.paseo: ">=0.11.0"`),
  0.11.x SDK pins, strict `client/`/`server/`/`shared/` layout.
- Uber-project config: settings screen with repo list, template paths,
  virtual root override. Persistence in plugin data dir.
- Create RPC with preflight, materialization, manifest, workspace
  registration.
- Screen listing virtual workspaces with Open and Archive.
- Archive: plugin action with preflight, hook cascade, teardown-blocked
  state.

Exit: create a three-repo virtual workspace, work in it, archive it, all
from the plugin UI. Branches survive archive.

### Phase 2: daily use

- Workspace panel with per-repo status aggregation and per-repo terminals.
- Sidebar rows with aggregate status, refresh on workspace/agent events.
- Command center items. First-agent/per-repo-terminal options on create.
- REPOMAP regenerate action.

### Phase 3: robustness

- Startup reconciliation and orphan handling.
- Resume/teardown for failed creates.
- Periodic resync backstop. Missing-constituent repair.

### Phase 4: optional extras

- Web-only sidebar grouping via DOM injection (clusters technique), off by
  default, clearly marked as fragile.
- Per-repo PR status via `gh`.
- "Make this a poly-repo workspace" interception via
  `before("workspace.create")`.

## Testing plan

- Unit tests for template rendering, branch/feature name validation, manifest
  schema round-trips and legacy/malformed manifest handling, git status
  parsers. Fixtures, deterministic, no live repos needed for parsers.
- Integration tests with three temp git repos: full create, per-repo status,
  archive clean, archive with a dirty repo (blocked), archive via native path
  with a dirty repo (teardown-blocked, tree intact), resume after a forced
  mid-create failure, orphan cleanup.
- Client bundle test, following `colorful-agent-activity/client/bundle.test.ts`:
  esbuild with the daemon's config, no `class` in output, size under 300 KB,
  `hermesc` bytecode check. Mobile smoke test on a real device before
  calling any phase done.
- Boundary check: no `node:*` imports reachable from client code, no
  server imports in `shared/` beyond Zod and types.

## Risks and open items

- Root git UX is empty by design. Mitigation is the panel plus a generated
  `AGENTS.md` that teaches agents the layout. If users live in the native git
  view, this will feel thin. Nothing to do about it inside the plugin API.
- Agents that run `git` at the root will fail. Same mitigation as above.
- Branch already checked out in the source repo or another worktree is the
  most common create failure. Preflight reports it per repo. Actual checkout
  conflicts are git's call, not ours.
- `worktrees.root` can move. The under-root check must run against the live
  config every create, not a cached value.
- Symlinked paths (macOS `/tmp`, home aliases) can make recorded paths and
  event cwds differ textually. Normalize with realpath at write and compare
  time.
- Version drift: research verified 0.10.0 and 0.12.0-beta.2 agree on the
  load-bearing APIs, and 0.11.0 matches on worktree ownership. Phase 0 still
  re-verifies everything against the pinned 0.11.x.
- Unknown until Phase 0: whether a directory workspace over a plain directory
  keeps a stable `projectId` grouping across restarts. Only matters for how
  the native list groups things. Not blocking.

## Code references

All paths relative to `~/workspace/paseo`.

- `packages/protocol/src/messages.ts` — `WorkspaceCreateRequestSchema`
  (`directory | worktree` sources), `WorkspaceDescriptorPayloadSchema`
- `packages/plugin/src/server/contracts.ts` — `PluginServerContext`,
  `PluginHandlerContext.paseo`
- `packages/plugin/src/server/lifecycle.ts` — lifecycle events and
  `before("workspace.create")`
- `packages/plugin/src/server/process.ts` — `spawnProcess`, `execCommand`,
  `terminateProcess`
- `packages/client/src/index.ts` — `PaseoApi`, `PaseoWorkspaceActions`,
  workspace handles (`agents.create`, `terminals.create`, `archive`)
- `packages/server/src/utils/worktree.ts` — `isPaseoOwnedWorktreeCwd`,
  `deletePaseoWorktree`, worktree path layout
- `packages/server/src/utils/checkout-git.ts` — upward-only git detection
- `packages/server/src/server/workspace-archive-service.ts` — archive
  semantics, backing-directory resolution
- `packages/server/src/server/workspace-registry-model.ts` —
  `initialWorkspacePlacement` (why directory workspaces persist as
  non-Paseo-owned)
- `packages/server/src/server/worktree/commands.ts` — worktree-scoped archive
  path that bypasses the registry gate
- `public-docs/plugins/reference.md` — sidebar items, workspace panels, SDK
  usage
