# skill-picker

Composer pill (Sparkles icon) with a popover pick list of the current agent's
known skills (`kind === "skill"` from `agents.ref(id).commands()`).

Selecting a skill sends `/name` immediately via `agents.ref(agentId).send()`.
Paseo has no composer-draft insertion API, so this submits rather than
pre-filling editable text.

## Usage recency

Each successful invocation is recorded in a host-scoped `usage` settings
document (`shared/usage.ts`, registered in `index.server.ts`) tracking
`count` and `lastUsedAt` per skill, capped at the 50 most recently used.
The picker sorts most-recently-used first (ties by count, then name);
untracked skills stay alphabetical below. Writes are best-effort with
revision-conflict retries and never block sending. Usage is shared by every
client of the host.
