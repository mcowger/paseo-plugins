# Plexus activity

Live Plexus request activity, as a workspace tab or docked in the Paseo **Explorer**.

The panel mirrors the columns an operator actually reads on Plexus's admin Logs page — API, model,
tokens, cost, and performance — and updates as requests stream, so a busy Plexus can be watched without
leaving Paseo. Scope it to a single API key from the panel header when you only care about one client.

Paseo 0.12.0+. [Scope and design rationale](./docs/SCOPE.md).

## Setup

1. In Plexus, create or copy an **admin** key. `x-admin-key` is the only accepted header for the
   management endpoints, and `/v0/management/events` is where the live feed comes from.
2. Open **Settings → Plugins → Plexus activity** and fill in:
   - **Plexus URL** — where *this daemon* reaches Plexus, e.g. `http://localhost:4000`. A path prefix
     like `https://example.com/plexus` is supported.
   - **Admin key** — verified against `GET /v0/management/auth/verify` before it is stored.
3. Open it:
   - **Mobile: the sidebar row.** Open the sidebar (☰) and tap **Plexus activity**. On a compact layout
     Paseo's tab switcher only offers *New agent* / *New terminal*, so the sidebar is the entry point
     that exists there. It opens the full-screen view.
   - **Desktop: a tab or the dock.** *Open Plexus activity* opens a workspace tab, *Open Plexus activity
     in Explorer* docks it on the right, and the Explorer's own new-tab menu lists it.

   The compact Explorer overlay does not slide in for the dock command, so on a phone use the sidebar
   row instead.

The key is stored server-side in `$PASEO_HOME/plugin-settings/plexus-activity/config.json` (mode
`0600`). The settings screen never renders it back and no RPC returns it.

## What a row shows

```
chat→messages · stream
gpt-5.4 · High · Priority
↑1.2k (c0/w0) ↓340 (r0) · $0.004200
2.3s · TTFT 410ms · 148.4 t/s · E2E 152.0 t/s
```

Line 1: incoming→outgoing API type plus `stream` / `raw` / `passthrough` / `vision` flags.
Line 2: model slug, reasoning effort, service tier (`Flex→Priority` when the provider reported a
different tier than requested).
Line 3: input, cached and cache-write tokens, output and reasoning tokens (`*` when token counts were
estimated), and the request cost in USD.
Line 4: duration, time to first token, provider tokens/sec, and end-to-end tokens/sec. While a request
is in flight the duration ticks and the line shows an estimated `~N t/s` from the stream byte rate.

Deliberately **not** shown: Plexus's META column (`messageCount`, `toolCallsCount`, `toolsDefined`,
`finishReason`), provider names, model aliases, attribution, source IP, and the per-row status/date/key
columns. Status, date, and key are still carried internally so in-flight requests, ordering, and key
scoping behave correctly.

## How it works

```
Plexus  ──SSE──►  plugin server (owns the socket, folds rows, keeps a delta journal)
                        ▲
                        └── poll every 1.5–5 s ── plugin client (Explorer panel)
```

Paseo 0.12.0 has no server-to-client push channel, so the panel polls a delta snapshot. The server keeps
the SSE connection open regardless of whether the panel is mounted, backfills from
`GET /v0/management/usage` on every (re)connect, and falls back to REST polling when a proxy buffers the
event stream. In-flight durations are ticked locally at 4 Hz between polls.

## Behaviour worth knowing

- **Proxy buffering.** Plexus sends no `X-Accel-Buffering: no`, so an nginx-style proxy can hold the
  stream. After 15 s without bytes the panel switches to *Polling* (usage re-read every 10 s); after 45 s
  it aborts and reconnects. The pill shows which mode is active.
- **Key scoping is exact.** Plexus's REST `apiKey` filter is a substring match, so the plugin filters by
  exact key name itself and never sends a scoped query.
- **Rejected keys do not retry.** A 401/403 halts the connection until the settings change.
- **USD only.** Plexus converts costs to a display currency client-side; this plugin always shows USD.
- **Limited keys.** Any configured API key works, but Plexus then scopes the stream to that key and
  refuses `GET /v0/management/keys`; the scope picker switches to a free-text key name.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm test          # includes an esbuild + Hermes bytecode check of the client bundle
```

```sh
paseo plugin install ./plexus-activity
paseo plugin reload plexus-activity
paseo plugin logs plexus-activity
```

`npm test` includes `client/bundle.test.ts`, which reproduces Paseo's client compile (esbuild `es2020`,
CJS, host modules external), asserts no ES6 classes, enforces a 320 KB budget, and runs `hermesc` when
the host prebuilt is available. Changes still need a device smoke test: Settings → Plugins on iOS should
show no evaluation error.
