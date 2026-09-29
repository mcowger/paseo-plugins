# skill-picker

Composer pill (Sparkles icon) with a popover pick list of the current agent's
known skills (`kind === "skill"` from `agents.ref(id).commands()`).

Selecting a skill sends `/name` immediately via `agents.ref(agentId).send()`.
Paseo has no composer-draft insertion API, so this submits rather than
pre-filling editable text.
