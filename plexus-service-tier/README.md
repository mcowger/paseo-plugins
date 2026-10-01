# plexus-service-tier

Composer pill (Zap icon) that selects the provider **service tier** for models
running under Paseo's `pi` provider through the **Plexus** proxy:

- **GPT / OpenAI** — `service_tier` (`fast`/priority, `flex`, `ultrafast`)
- **Claude / Anthropic** — Fast mode (`speed: "fast"` + `fast-mode-2026-02-01`)

The pill only appears for agents where all of these hold:

- the Paseo provider is `pi`
- the selected model id carries the `plexus/` prefix
- the model has selectable tiers:
  - GPT 5.5 or newer (`gpt-5.5`, `gpt-5.6-*`, `gpt-6*`, `gpt-6.1-*`, …)
  - Claude Opus 5.5 (`claude-opus-5-5`), Claude Opus 5 (`claude-opus-5`), or
    Claude Opus 4.8 (`claude-opus-4-8`)

Selecting a tier sends `/service-tier <arg>` to the live pi session. The picker
renders only the tiers the current model supports.

## Threading

Paseo's Pi provider drives the `pi` CLI, and a Paseo plugin cannot inject a pi
extension or set provider features. The pill therefore relies on the
**plexus-pi** extension owning the request-side change:

**Command** `/service-tier <arg>` with `default` (aliases `off`, `none`),
`fast` (alias `priority`), `flex`, `ultrafast`, and `status`.

**Injection** — in `before_provider_request`, when `ctx.model.provider ===
"plexus"`:

- `ctx.model.api` is `openai-responses`/`openai-codex-responses` and the slug
  is GPT 5.5+ → set `payload.service_tier` to `"priority"` | `"flex"` |
  `"ultrafast"`.
- `ctx.model.api` is `anthropic-messages` and the slug is `claude-opus-5-5`,
  `claude-opus-5`, or `claude-opus-4-8` → add `speed: "fast"` and the
  `fast-mode-2026-02-01` beta (the priority tier).

**Eligibility** — `fast`/`priority` and `flex`: any GPT 5.5+ Responses model
(the GPT-6 flagship pages all price Flex, and `gpt-5.5`/`gpt-5.6` are shown
with Flex); `ultrafast`: `gpt-6-astra` and `gpt-5.6-sol`. Claude exposes
`default` and `fast` only, and only on Opus 5.5 / Opus 5 / Opus 4.8 — Fast mode
is an Anthropic research preview on the first-party Claude API (not Bedrock,
Google Cloud, or Foundry), per the choosing-a-model doc. Opus 4.7 hard-errors
and Opus 4.6 silently runs standard.

**Notification** — `ctx.ui.notify` a JSON string so Paseo surfaces a timeline
notification:

```json
{"type":"plexus.serviceTier","command":"service-tier","success":true,
 "tier":"default|priority|flex|ultrafast","supported":true,
 "provider":"plexus","model":"gpt-6-luna"}
```

The pill verifies the command with `agents.ref(id).commands()` and shows a
retryable notice when the session does not expose it.

## Notes

The selected tier is tracked per agent on the client so the pill label reflects
the last choice. pi owns the authoritative per-session state and resets it when
a session starts, so the label is best-effort after a session restart.
