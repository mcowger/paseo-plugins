# OpenCodeReview panel for Paseo: implementation plan

Status: agreed design; implementation not started. This document is the handoff for building a **new, standalone** plugin in `ocr/`. Do not modify Paseo or the existing `colorful-agent-activity` plugin to make this work.

## Product contract

The plugin lets a user run OpenCodeReview (OCR) against the current Paseo workspace, read findings sorted by severity, select findings, and hand a selection to an agent in one of two ways:

1. **Existing conversation:** save selected findings as one immutable, named batch. From the existing agent's composer, choose the plugin attachment source and pick that batch. Paseo adds **one editable-draft attachment pill** whose text contains all selected findings. The user writes or edits their message and sends normally.
2. **New conversation:** confirm a model and assembled prompt, then create a new agent **in the same workspace** with the findings as its initial user prompt. Creating with an initial prompt starts the agent immediately; it does not populate an editable draft. Navigate to the newly created agent.

There is no one-click panel-to-existing-composer insertion. Paseo's built-in editor can do that through an internal draft store, but Paseo 0.10.x does not expose that operation to plugins. Do not import app internals, manipulate the DOM, or simulate composer input. The supported picker and agent-creation SDK APIs cover the two flows above.

The target is **Paseo 0.10.0 and newer**. Pin `@getpaseo/client`, `@getpaseo/plugin`, and `@getpaseo/protocol` to `0.10.0` in this plugin; put `"requirements": { "paseo": ">=0.10.0" }` in `ocr/paseo-plugin.json`. The local Paseo checkout is currently at 0.10.1; check the 0.10.0 tag for any implementation detail before using it. This plugin is a deliberate exception to the older 0.9.0 baseline in the root `AGENTS.md`, as explicitly requested for OCR. Follow the other repository guardrails.

## User experience

### Review panel

Register a workspace-context panel titled **OpenCodeReview** with `locations: ["workspace", "explorer"]`. It works on web, iOS, and Android. Show the workspace name and actual Git worktree/root so the review scope is unambiguous. Do not expose OCR credentials in the client.

The scope control has exactly two modes in v1:

- **Uncommitted:** staged, unstaged, and untracked changes together. Invoke `opencodereview review` without range flags. There is no staged-only or unstaged-only option.
- **Branch vs base:** two Git-ref selectors labeled **Target** and **Base**. The default target is the current local branch if attached. For Base, choose the first existing ref in this order: local `main`, `origin/main`, local `master`, `origin/master`; if none exists require explicit selection. The user can always change either ref. The panel must explain that this reviews commits introduced by the target since its merge-base with the base. It does **not** include uncommitted work, even when target is the checked-out branch. Passing `--from <base> --to <target>` implements this mode. Never change the checkout, fetch remotes automatically, stage files, or mutate the index.

Present eligible local and remote **branch** refs from Git (not tags, arbitrary revisions, or commits in v1); allow a typed branch ref only after server validation against those refs. Reject nonexistent refs, identical effective heads, leading-dash values, refs without a merge-base, and refs for which OCR cannot compute the range. If the checkout is detached, leave Target unset until chosen. Display the resolved refs/commit IDs in run details. If the workspace is not a Git worktree/repository, disable Run with an explanation. An unavailable OCR executable or missing OCR configuration is an actionable capability state, not a crash.

**Run review** is explicit. OCR sends diff and retrieved source context to its configured LLM endpoint, incurs cost, and stores sessions under the daemon user's OCR home. Do not auto-run on mount, ref changes, or after an agent fixes code. Show progress as running plus elapsed time (OCR JSON is a final document, not structured incremental findings); allow Cancel. Disable duplicate Run while a review for that workspace is active. Keep stdout as one JSON document and stderr as bounded diagnostic/progress text; never print credentials. A canceled run is labeled canceled/incomplete, not clean.

Show the newest review and a recent-history chooser for the **same worktree**, including OCR sessions produced outside the plugin if available. Display mode, requested refs, timestamp, status, reviewed/selected/failed counts, warnings, and session ID where present. Refresh history after completion; offer a manual refresh. A legacy session with incomplete metadata should be marked **coverage unknown**, not silently treated as complete. Distinguish: running, canceled, fatal error, no eligible files (`skipped`), completed with zero findings, complete with findings, and partial/failed coverage with or without findings. Exit code zero is not evidence of full coverage.

Group findings by **critical → high → medium → low → unspecified**. Within a group, use a deterministic file-path/line/order sort. Show severity, category, repository-relative path, start/end line, finding explanation, and optional existing/suggested code (collapsible). OCR comments have no stable finding ID and severity/category can be absent. Provide explicit loading/empty/error states and readable compact/native layouts; make selection controls accessible. Code suggestions are advisory, never applied automatically.

### Finding selection

Selection is per displayed review session, not silently carried to a different session. Presets **replace** the current selection:

- **Critical** = critical only (OCR has no severity above critical).
- **High+** = critical and high.
- **Medium+** = critical, high, medium.
- **All** = all findings, including low and unspecified.
- Also provide **Clear** and independent checkboxes for each finding.

Show the selected count. Disable handoff for zero selected findings. For partial reviews, warn about incomplete coverage while allowing the user to act on available findings. Do **not** add a plugin-defined cap or silently truncate the selected finding text; one attachment limits pill count, not model input size. Render potentially long detail lists incrementally/with appropriate React Native list primitives so the UI stays usable.

### Existing-agent handoff: one batch, one picker item

**Save selection for chat** creates an immutable snapshot with a unique opaque ID, creation time, workspace ID/name, worktree identity, OCR session ID, mode and refs, count/severity summary, selected finding identities, and fully assembled attachment text. A saved batch does not change when the checkbox selection or repository later changes. Show a success message that explicitly says **open the desired agent's composer → Add attachment → OpenCodeReview selections → choose this batch**. Do not claim the panel attached anything to a draft yet.

Register one plugin attachment source named **OpenCodeReview selections**. Its search RPC lists recent saved batches on the same Paseo host, searches by workspace name, session, file, or batch label, and returns **one attachment item per batch**, not one per finding. Each item clearly includes workspace, scope, run timestamp, finding count, and batch creation time so the user cannot mistake one worktree's finding for another. The picker has no workspace, agent, or user identity: host-wide visibility is intentional for this plugin, and should be disclosed in the UI. Do not maintain a singleton “last selection” that another workspace can overwrite. Keep a bounded **20 most recent** batches per host and support explicit deletion in the panel. Retention limits the *number of batches*, not the size or completeness of their text; do not truncate a batch.

Paseo's attachment source requires `{ id, identifier, title, subtitle?, url, text, resourceType }`. Use a unique batch ID for `id` so the host's toggle/dedupe logic does not merge distinct snapshots. Put the selected findings and context in `text`, because Paseo renders text—not `externalResource.url`—into the agent prompt. For a local-only batch, use a truthful absolute `file://` URL generated from a validated worktree file path as metadata; do not invent a clickable HTTPS link. Paseo accepts absolute non-HTTP(S) URLs here, but does not open `file://` via its external URL API; label it as local and never offer “Open link.” If a batch has no trustworthy local finding path, use a truthful URL to the worktree directory instead. The selected draft pill survives normal Paseo draft persistence and retains the exact snapshot that was chosen.

The picker search query is only `{ query: string }`; it does not receive a workspace ID or panel selection. The panel therefore **persists the snapshot before the picker opens**. Picker query results are cached for roughly 30 seconds by Paseo; after saving a batch, do not promise instant cache invalidation or imply the panel can open/prefill the picker. In the panel, display the saved batch ID/label and instruct the user to reopen the picker or search by its unique short label if the default list is temporarily stale. Make search filtering server-side and limit result *count* for picker responsiveness without altering any attachment's text.

### New-agent handoff

**Start new agent with selection** opens a confirmation modal; it does not immediately create an agent. Show workspace, count/severity breakdown, selected finding titles/paths, full assembled prompt (scrollable), model, and a warning that confirming starts work immediately. The default instructions are editable via plugin settings, not inline only. Always append the full selected findings and run/scope context after the instructions. A custom instruction cannot remove the findings. Suggested default instruction:

> Review the selected OpenCodeReview findings below against the current repository. Verify each finding before changing code. Fix valid selected issues, keep changes focused, and run relevant tests. Summarize fixes and any findings you did not address. Do not commit unless asked.

Host-level settings contain `newAgentInstructions` (a nonempty text value with that default) and optional `defaultProviderModel` (`provider/model`). Provide a dedicated settings screen reachable from the panel. Save against the settings revision, show save/conflict/invalid states, and let the user reset to defaults. The setting changes only new runs; it does not mutate existing saved batches or existing agents.

Model selection precedence in the confirmation modal:

1. A saved default, **only if currently available** in this workspace.
2. Otherwise, suggest the model of the **most recently updated non-archived agent in this workspace** with a known model, **only if currently available**. Label the source agent and make clear this is a suggestion, not necessarily the focused chat; the workspace panel cannot see focused-agent state.
3. Otherwise require an explicit provider/model selection from Paseo's available, selectable models.

Always display and allow changing the model before confirmation. Offer **Save as default** as an explicit action; merely running an agent does not change settings. Refresh availability when opening the modal; if the saved/suggested model is unavailable, show why and require another choice. SDK `config.provider` requires the combined `provider/model` format; never pass a bare provider. Use `paseo.providers.waitForReady({ cwd })` or `snapshot({ cwd })`, filter ready/enabled providers and selectable models, and use `paseo.agents.list` filtered client-side by `workspaceId` (page through results when necessary) to find the recent-agent suggestion. Sort by `updatedAt` with deterministic tie-breaking. Do not claim to know the UI-focused agent.

On confirmation, use `paseo.workspaces.ref(workspaceId).agents.create({ config: { provider: chosenProviderModel }, prompt: assembledPrompt, title: ... })`, **not** `paseo.agents.create`, which can create a different workspace for a cwd. Re-resolve the live workspace and validate the model before creation. Guard double-clicks, show creating/error state, and navigate with the panel's `navigation?.openAgent({ agentId })` after success. Initial-prompt creation is not safely idempotent; on an uncertain network outcome, check whether an agent was created before inviting a retry, and do not auto-retry. If navigation is unavailable, show the new agent ID and a success state instead of reporting failure.

## Technical design and file layout

Everything in `ocr/` is self-contained. Keep runtime code only in `client/`, `server/`, and `shared/`; root modules are the explicit entries `index.client.tsx` and `index.server.ts`. No DOM lib in `tsconfig.json`, no `node:*` in client/shared, and no client imports of server code. Use React Native primitives and host UI components; derive text colors/styles from Paseo's theme/layout. Keep the client Hermes-safe and small. Suggested files (names can differ, responsibilities cannot):

```
ocr/
  paseo-plugin.json                 # id: open-code-review; >=0.10.0
  package.json / package-lock.json  # exact Paseo SDK pins; lint/typecheck/test scripts
  tsconfig.json
  README.md                         # install OCR/configuration, review/privacy, handoff steps
  index.client.tsx                  # panel, attachment source, settings screen registrations + cleanup
  index.server.ts                   # RPC/settings registrations + job cleanup
  shared/contracts.ts               # Zod RPC contracts/view-model schemas
  shared/settings.ts                # host settings definitions and defaults
  shared/presentation.ts            # severity order, stable sorting, prompt/attachment text formatting
  client/review-panel.tsx           # scopes, runs, history, findings, selection, handoff
  client/settings.tsx               # prompt/default model editor
  client/bundle.test.ts             # esbuild/Hermes/size/boundary checks
  server/git.ts                     # workspace resolution, Git capabilities, refs/merge-base validation
  server/ocr.ts                     # OCR subprocess adapter, JSON normalization, session history
  server/jobs.ts                    # one active job per workspace, status/cancel/cleanup
  server/selections.ts              # finding resolution, immutable snapshot creation, picker search
```

Define explicit Zod RPCs for `capabilities`, `listRefs`, `startReview`, `getReview`, `cancelReview`, `listHistory`, `loadSession`, `prepareSelection`, and `searchSelections` (the last is the attachment source's search contract). `prepareSelection` accepts workspace ID, OCR session ID, and selected finding IDs, re-loads and validates those findings server-side, then returns an immutable batch snapshot with a server-generated ID and full text. The client persists/deletes batches using Paseo's generated settings read/write RPCs (not custom server mutation handlers). Include a workspace ID in every workspace-specific input; on the server re-resolve via `context.paseo.workspaces.ref(id).refresh()`, and use its actual directory, never an arbitrary client-provided cwd/path. The server context has `{ paseo }` only, not a client/user identity. Return typed unavailable/error states for missing OCR/Git/disconnected workspaces. Give job IDs and batch IDs server-generated opaque values; do not use a comment's path alone as an identifier.

**Storage:** use Paseo `defineSettings`/`server.registerSettings` for two host-scoped documents: `preferences` (instructions/default model) and `selections` (versioned recent immutable batch snapshots). This gets atomic writes, revision-based optimistic concurrency, schema validation, migration support, and host cleanup without guessing at `$PASEO_HOME` or writing into OCR's session files. The `registerSettings` server handle is **read/subscribe only**; it has no write method. Therefore `prepareSelection` produces a validated snapshot but does not persist it; the panel reads the current `selections` settings document, merges in the returned snapshot, retains the newest 20, and writes via the generated settings write RPC or `useSettings().save(values, revision)`. On a revision conflict, re-read, re-merge by unique ID, and retry a small finite number of times; only report success when a write succeeds. Delete uses the same optimistic merge/retry path. The attachment-search server handler reads the registered `selections` settings handle, which reflects successful client writes. Keep the selection document's Zod schema strict and do not trust a client-supplied snapshot as authoritative when preparing findings. Never reset the entire selections document merely to update one batch. On migration, preserve saved batches or surface an explicit invalid state; do not silently discard them. Since settings are host-scoped, all clients of the same host can see batches and preferences, and selected source snippets are persisted there: mention this in the README and UI. Settings are not a credential vault.

**OCR adapter:** resolve the installed `opencodereview` executable server-side from the daemon's PATH (or the versioned shim it resolves to), not an arbitrary client-provided path; check `--version` and use the installed 1.12.10 CLI contract as the development/test baseline. If an older/incompatible OCR cannot provide the required JSON/session contract, show an installation/upgrade hint. Use `node:child_process.spawn` with an argument array and explicit `cwd`/`--repo`; do not use shell interpolation, a Paseo terminal capture, or an interactive viewer. Run `review --format json --audience agent` plus the selected mode flags. Capture stdout to parse **one final JSON document** and stderr for bounded diagnostics. OCR sessions are local to the daemon host; do not log config/token/session bodies. Start/cancel/job-state RPCs avoid a single long-running UI RPC, allow navigation away and back, and terminate children on plugin unload (graceful signal followed by forced termination if necessary). Poll only while a job is active; stop timers/subscriptions on unmount. No LLM invocation for preview, history, or capability checks. Do not run the same review automatically twice.

Read `session list --repo <worktree> --json` for history (normalize JSON `null` to `[]`), `session show --repo <worktree> --json <id>` for run metadata/coverage, and `session comments --repo <worktree> --json <id>` for findings. Keep `--repo` on every lookup, validate a selected session belongs to the worktree, and reject session IDs that are not returned for it. Historical runs may be workspace/range/commit/scan; label modes accurately, and never present a scan or a foreign session as the panel's just-run branch comparison. Use OCR's manifest/summary when available to distinguish complete/partial/failed/skipped and to show selected/completed/failed counts; for older sessions display unknown coverage explicitly. OCR JSON `comments[]` includes path, content, start/end lines, optional existing/suggestion code, optional category/severity, but no stable comment ID. Derive a deterministic display/selection ID from session ID + canonical finding fields + duplicate occurrence index (keep the occurrence index deterministic). Normalize unknown severities to unspecified, not high/low by guess. Preserve warnings and status/exit/stderr separately.

Git adapter should run only read-only Git commands (`rev-parse`, `symbolic-ref`, `for-each-ref`, `merge-base`, and status only where needed), with fixed argument arrays, `--end-of-options` where applicable, and bounded execution time. Check that the resolved repository top level matches the Paseo workspace worktree directory before reviewing so a nested or unrelated repository cannot be reviewed by accident; if not, show the actual resolved root and an unsupported-scope explanation. Do not follow a user-provided filesystem path, fetch refs, write Git config, or modify the index.

**Security and trust:** OCR sends diffs and retrieved file content to the configured provider. Never read/print `~/.opencodereview/config.json` or log keys. Validate OCR JSON and session outputs as untrusted, including path traversal/absolute paths, invalid lines, huge display strings, and unsupported statuses. Use normalized workspace-relative paths in the UI and batch text; create any local metadata URL only from an authorized worktree path. Use the workspace identity and session ID throughout to prevent accidental cross-worktree selection. No code is applied automatically. A host-wide batch picker is not per-user authorization; do not claim otherwise.

## Verification and acceptance

Implement in this order so each milestone can be verified without starting a paid OCR review or a real agent:

1. Scaffold `ocr/`, exact SDK pins, manifests, client/server entries, Zod contracts, settings, and bundle-boundary test. Prove it builds against Paseo 0.10.0.
2. Implement/test workspace and Git capability/ref resolution. Add OCR subprocess adapter with a fake executable, job lifecycle/cancellation, history reconstruction, and status normalization.
3. Implement/test panel scope selection, history, severity sorting, checkboxes, and replace-style presets against fixtures.
4. Implement/test snapshot preparation, host settings persistence with conflict handling, attachment-source search, and one aggregated picker item. Verify that a saved batch remains unchanged after a new review or a different checkbox selection.
5. Implement/test settings screen and new-agent confirmation: provider discovery, saved default/recent-agent suggestion, full prompt, workspace-scoped create, and navigation. Use a fake SDK/agent for automation.
6. Run all checks, then do the authorized host/mobile smoke tests and update `ocr/README.md` with actual installed-version behavior and setup instructions.

- Unit tests: Git ref/base/target validation and no shell interpolation; OCR success, skipped, no-findings, partial, fatal, warnings, malformed JSON, cancel, and history `null`; stable duplicate finding identities; severity presets/replacement and unspecified; prompt instruction override always retaining selected findings; immutable one-item batch serialization; preference/selection defaults, migration, optimistic-concurrency merge, and 20-batch retention; cross-worktree/session isolation and path normalization.
- Integration tests with a fake OCR executable and temporary Git worktrees: server RPC start/status/cancel, cleanup killing jobs, scope arguments and `cwd`, history reconstruction, and one attachment-source result containing all selected findings without truncation. Fake provider snapshots/agents for saved-default, recent-agent-suggestion, unavailable-model, and creation confirmation flows. Tests must not invoke a real LLM or a real OCR review.
- Client bundle test: esbuild config matching Paseo's client compiler, no unlowered class syntax, practical bundle size regression guard, `hermesc` bytecode compile where available, and no server/Node imports in the client. Smoke-test picker and panel on desktop and a connected mobile device/emulator; bytecode compilation alone is insufficient.
- In `ocr/`, run `npm run lint`, `npm run typecheck`, and `npm test`; fix every failure or warning. Check repo-level SDK pin validation. Before using each Paseo plugin CLI subcommand, run `paseo plugin <subcommand> --help`; then install/reload/check status and plugin logs on a suitable Paseo >=0.10.0 host, without leaking review content. No OCR review should be run without explicit user authorization because it calls a configured LLM.
- Acceptance demo: with explicit approval to invoke OCR and the selected agent/provider, run uncommitted and branch/base reviews on a test repo; show a skipped run and a partial-coverage fixture; choose High+ then adjust one finding; save a batch; attach exactly one item to an existing agent's unsent draft and confirm its complete snapshot is delivered; edit the saved instructions/default model; create a new workspace agent from the same selection and confirm it starts once with the selected model and full prompt; navigate back and load the historical session and saved batch. Without that approval, demonstrate review and agent-creation flows using fakes only.

## Source-of-truth references for implementation

- Paseo checkout: `/home/matt.cowger/workspace/paseo` (inspect tag `v0.10.0`); plugin panel/commands in `packages/plugin/src/client/contracts.ts`; attachments in `packages/plugin/src/attachments.ts`, `packages/plugin/src/client/host.ts`, `packages/app/src/plugins/attachments/picker.tsx`, and `packages/app/src/plugins/attachments/model.ts`; SDK agent/provider/workspace handles in `packages/client/src/index.ts`; settings in `packages/plugin/src/settings.ts` and `packages/server/src/server/plugins/settings/index.ts`.
- Official examples: `plugin-examples/local-plugin` (workspace panel/RPC), `plugin-examples/linear` (attachment search), and `plugin-examples/settings` (host settings). Repository's `colorful-agent-activity/client/bundle.test.ts` shows the Hermes regression test pattern.
- OCR installed at research time: `opencodereview` v1.12.10. Check `opencodereview --version`, `review --help`, and `session {list,show,comments} --help` before coding flag assumptions. This planning phase did not execute an OCR review or touch OCR credentials.
