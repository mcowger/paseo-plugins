# OpenCodeReview for Paseo

Workspace panel that runs OpenCodeReview against the current Paseo workspace,
shows severity-sorted findings, and hands a user-selected subset to an agent.

Target: **Paseo >=0.10.0**. SDK pins are exact `0.10.0` in `package.json`;
`paseo-plugin.json` declares `"requirements": { "paseo": ">=0.10.0" }`.

## Setup

1. Install an OCR executable on the **Paseo daemon host** as `opencodereview`
   (or set `OCR_BIN` in the daemon environment to an absolute path).
   Verify with `opencodereview --version`, `opencodereview review --help`,
   and `opencodereview session list --help`.
2. Configure OCR itself (`~/.opencodereview/config.json`, providers/models).
   Reviews send diffs and retrieved source context to the configured LLM and
   incur cost. Never paste OCR credentials into Paseo, logs, or issues.
3. From this directory: `npm install`, `npm run lint`, `npm run typecheck`,
   `npm test`.
4. Install with `paseo plugin install <this-directory>` (run
   `paseo plugin <subcommand> --help` before each subcommand), then
   `paseo plugin reload open-code-review`, `paseo plugin ls open-code-review`,
   and `paseo plugin logs open-code-review`.

## Use

- **Uncommitted** reviews staged, unstaged, and untracked changes together.
- **Branch vs base** (`--from <base> --to <target>`) reviews commits the
  target introduced since its merge-base with base. It does not include
  uncommitted edits.
- Findings have no stable OCR id; the plugin derives deterministic display
  ids per session. Severity `unspecified` means OCR left it blank.
- **Save selection for chat** stores one immutable batch (newest 20 kept,
  host-wide visible). In the target agent composer choose
  **Add attachment → OpenCodeReview selections → your batch**. Paseo adds one
  pill whose text holds all selected findings.
- **Start new agent** shows the full prompt and model first. Confirming
  creates an agent in the same workspace and starts it immediately.
- Settings (host-scoped, visible to all clients of the host) hold
  new-agent instructions and an optional default `provider/model`.

## Privacy

OCR sessions live under the daemon user's OCR home. Saved batches persist
selected finding text in Paseo host settings. The attachment picker is
host-wide by Paseo design; labels always show workspace, scope, and run.
