# Plexus Activity — scope

A Paseo plugin that shows Plexus request activity, live, in the workspace **Explorer** dock
(right side), mirroring the Plexus admin dashboard's `/ui/logs` page.

Status: **implemented** — see §15 for what is verified and what still needs a live Plexus and a device.

---

## 1. Purpose

Show a live, newest-first feed of Plexus inference requests in the Explorer dock, scoped optionally
to one API key, fed by Plexus's SSE event stream.

### In scope

- Panel available as a workspace tab and in the Explorer dock (`locations: ["workspace", "explorer"]`)
  with stacked request cards, plus a full-screen surface reachable from the sidebar (the only entry
  point that exists on compact layouts).
- Live updates from `GET /v0/management/events` (SSE), consumed **server-side**.
- Optional scope to a single API key name, chosen in the panel and defaulted in settings.
- Plugin settings screen holding the Plexus base URL and admin key.
- All values shown by Plexus's **API, Model, Tokens, Cost and Perf cells** (see §6).
- Theme-derived colors only; runs on iOS (Hermes), Android and web.

### Out of scope

- Per-row delete / reset logs, pagination controls, date-range and text filters (Plexus has them; we don't).
- Plexus `META` column (`messageCount`, `toolCallsCount`, `toolsDefined`, `finishReason`).
- Underlying provider names, `attribution`, `sourceIp`, `retryHistory`, debug/error drill-downs.
- Currency conversion (Plexus converts USD client-side via `frankfurter.dev`; we show USD only).
- Row detail views (decision: no detail view, see §4).
- Timeline rendering into agent transcripts, notifications, slash commands.

---

## 2. Verified host constraints (Paseo SDK **0.10.0**)

All claims below were checked against the packages actually pinned in this repo
(`skill-picker/node_modules/@getpaseo/plugin@0.10.0/dist/**`), not against `~/workspace/paseo`
(which is at `v0.12.0` and has newer names).

| Fact | Evidence |
|---|---|
| Panels take `locations?: readonly ("workspace" \| "explorer")[]`; default `["workspace"]` | `dist/client/contracts.d.ts:45,53`; `v0.10.0:packages/app/src/plugins/workspace-panels/locations.ts:9` |
| Explorer placement is honored at 0.10.0 | `v0.10.0:packages/app/src/plugins/workspace-panels/locations.ts:14-24`; `v0.10.0:packages/app/e2e/support/helpers/explorer-plugin-menu.ts` |
| Panels receive only `theme`, `host`, `layout`, `navigation?`, `context`, `workspaceId` — no params, no data props | `dist/client/contracts.d.ts:8-20,55-59` |
| Settings are the **only** persistence API (`registerSettings` / `useSettings` / `settingsRpc`) | `dist/server/contracts.d.ts:16-36`; `dist/settings.d.ts` |
| Settings files: `$PASEO_HOME/plugin-settings/<pluginId>/<id>.json`, mode `0o600`, temp+rename, sha256 revision | `v0.10.0:packages/server/src/server/plugins/settings/index.ts` (write path) |
| Settings are "ordinary host-side JSON, **not a credential vault**" | `public-docs/plugins/reference.md` (settings section) |
| **RPC is strictly request/response — there is no server→client push** | only `plugin.rpc.invoke.request` / `.response` exist: `@getpaseo/protocol@0.10.0/dist/messages.d.ts:1634,20990`; `server.handle` returns a single value: `dist/server/contracts.d.ts:33-36` |
| No `onStart`/`onStop`: the `contribute(server)` body is startup, the returned cleanup is shutdown | `dist/server/contracts.d.ts:38` |
| Theme is exactly 11 tokens (`surface0/1/2`, `border`, `foreground`, `foregroundMuted`, `accent`, `accentForeground`, `statusSuccess`, `statusWarning`, `statusDanger`) | `dist/contracts.d.ts:4-17` |
| Host UI: `Icon`, `Modal`, `useToast`, `copyText`, `FlatList`, `ScrollView`, `TextInput` | `dist/client/react-native.d.ts` |
| Settings UI: `SettingsSection`, `SettingsRow`, `SettingsInput` (with `secureTextEntry`), `SettingsSelect`, `SettingsAction` | `dist/client/ui.d.ts:2-58` |
| `openSettings(screenId)` exists on the client context | `dist/client/contracts.d.ts` (`PluginCommandCapabilities`) |
| Client bundle: esbuild `es2020`/CJS, `async-await` downleveled, `@getpaseo/*`, `react`, `react-native`, `zod`, `@tanstack/react-query` external; **no ES6 classes**; evaluated via `eval()` on Hermes | `v0.10.0:packages/server/src/server/plugins/compiler.ts`; repo `AGENTS.md` |

**Consequence (drives the whole design):** the server module owns the Plexus SSE connection and a
bounded in-memory store; the panel polls a snapshot RPC. There is no supported push channel at 0.10.0.

---

## 3. Verified Plexus API contract

Source of truth: `~/workspace/plexus/docs/openapi.yaml` plus the implementation, which disagree in two
places (noted in §13).

### 3.1 Auth

- Header `x-admin-key: <ADMIN_KEY>`. There is **no** `Authorization: Bearer` path for management routes.
  `AdminKey` security scheme: `docs/openapi.yaml:12332-12338`;
  implementation `packages/backend/src/routes/management/_principal.ts:71-75`.
- A configured API key's secret is also accepted, but yields a **limited** principal; the user asked
  for an admin key, so we always assume admin (all keys visible, all events visible).
- Validation endpoint: `GET /v0/management/auth/verify` → `{ ok: true, role: "admin" }`, or
  `{ ok: true, role: "limited", keyName, ...scope fields }` (`docs/openapi.yaml` management auth;
  `packages/backend/src/routes/management.ts:58-76`). Note an admin principal gets **no** `keyName`.
- Usage rows are attributed to the key **name**, not the secret (`docs/openapi.yaml:3953-3957`), which is
  what makes name-based scoping stable across key rotation.

### 3.2 SSE stream — `GET /v0/management/events`

`docs/openapi.yaml:8044-8200`; implementation `packages/backend/src/routes/management/usage.ts:839-925`.

- `text/event-stream`, UTF-8, frames separated by `\n\n`, each frame has `event:`, `data:` (one JSON
  line, except `ping` whose data is the literal `pong`) and an informational `id:` (epoch ms).
- `id` is **not** a resume cursor; the server does not replay history. Every (re)connect must backfill.
- Event types:
  - `started` — partial `UsageRecord`, `responseStatus: "pending"`.
  - `updated` — **sparse** partial record; always has `requestId`, may carry only changed fields → shallow merge.
  - `progress` — `ProgressUpdate` (`requestId`, `apiKey`, `isStreamed`, `bytesReceived`, `bytesPerSec`,
    `semanticBytesReceived`, `semanticBytesPerSec`, `state`, `elapsedMs`); transient, never persisted.
  - `completed` — full `UsageRecord` with final status/tokens/cost/timing.
  - `ping` — every 10 s.
- `progress` fires ~1/s per in-flight request; `ping` every 10 s.
- No `X-Accel-Buffering: no` header, so an nginx-style proxy may buffer the stream (risk, see §13).
- CORS: route writes `Access-Control-Allow-Origin: *` on the raw socket; a cross-origin `OPTIONS`
  preflight for this GET-only raw-write route is **unverified**. Irrelevant to us — the request comes
  from Node, not a browser.

### 3.3 Backfill — `GET /v0/management/usage`

`docs/openapi.yaml:4984`; implementation `packages/backend/src/routes/management/usage.ts:331-410`.

- Params: `limit` (default 50), `offset`, `sortBy` ∈ {`date`,`apiKey`,`provider`,`incomingModelAlias`,
  `costTotal`,`durationMs`}, `sortDir`, `fields`, plus filters `apiKey`, `provider`,
  `incomingModelAlias`, `responseStatus`, `startDate`, `endDate`, …
- Response: `{ data: UsageRecord[], total, limit, offset }`.
- `apiKey` filtering is substring `LIKE '%v%'` for admins (`usage-storage.ts:718-764`), so it is **not**
  reliable for exact key scoping → we scope locally by exact match (§8.3).
- Documented `limit` cap of 500 is not enforced in the handler; we stay ≤ 200.

### 3.4 Key list — `GET /v0/management/keys`

`docs/openapi.yaml:3941-3976`; `packages/backend/src/routes/management/config.ts:367-374`.

- Returns `Record<keyName, KeyConfig>` — the **name is the id**; there is no separate `id` field.
- ⚠️ **Each entry contains the decrypted plaintext `secret`.** We must project names only, never
  include `secret` in any RPC output, and never log the response.
- 403 for limited principals → the dropdown degrades to a free-text key-name input (§11.2).

### 3.5 Record fields we consume

From `packages/backend/src/types/usage.ts` and the DDL
`packages/backend/drizzle/schema/sqlite/request-usage.ts:4-71`.

| Field | Type | Use |
|---|---|---|
| `requestId` | string (unique) | merge key / row id |
| `startTime` | epoch ms (required) | ordering, live duration |
| `date` | ISO string (required) | ordering tiebreak |
| `responseStatus` | `success`/`error`/`pending`/`cancelled`/`timeout`/`stall`/`HTTP n`/null | internal only: in-flight detection (§4.4) |
| `apiKey` | string (key **name**) | internal only: scope filter |
| `incomingApiType`, `outgoingApiType` | string \| null | API cell |
| `isStreamed`, `isRaw`, `isPassthrough` | boolean | API cell flags |
| `isVisionFallthrough` | boolean | API cell flag |
| `selectedModelName`, `finalAttemptModel` | string \| null | model slug |
| `reasoningEffort` | string \| null | model line |
| `serviceTier`, `requestedServiceTier` | string \| null | tier (`serviceTierRaw`/`requestedServiceTierRaw` decoded, unrendered) |
| `tokensInput`, `tokensCached`, `tokensCacheWrite`, `tokensOutput`, `tokensReasoning` | int \| null | tokens |
| `tokensEstimated` | 0/1 | `*` marker |
| `costTotal` | real \| null | cost cell |
| `costInput`, `costOutput`, `costCached`, `costCacheWrite`, `costSource`, `costMetadata`, `providerReportedCost` | — | decoded, unrendered (no detail view) |
| `durationMs`, `ttftMs`, `tokensPerSec` | number \| null | perf cell |
| `isDescriptorRequest` | boolean | decoded, unrendered (Plexus-internal, not in its API cell) |

Not consumed at all: `provider`, `finalAttemptProvider`, `upstreamModel`, `canonicalModelName`,
`attribution`, `sourceIp`, `retryHistory`, `attemptCount`, `allAttemptedProviders`, `messageCount`,
`toolCallsCount`, `toolsDefined`, `finishReason`, `visionFallthroughModel`, `kwhUsed`, plus `hasDebug`
and `hasError` (both are query-time `EXISTS` subqueries and are absent from SSE payloads anyway).

---

## 4. Decisions

| # | Decision | Source |
|---|---|---|
| 4.1 | **Always stacked cards**, one presentation at every width. No grid, no horizontal scroll. | user |
| 4.2 | **Key scope = in-panel dropdown (All keys + key names) plus a persisted settings default.** | user |
| 4.3 | **No row detail view.** Only the values Plexus renders in its cells; tooltip-only data stays unrendered. | user |
| 4.4 | **`status`, `date`, `apiKey` are carried for correctness but never rendered on a card.** Status drives in-flight treatment and error handling; date drives ordering; apiKey drives the scope filter. | user |
| 4.5 | Panel registered for **both** hosts (`locations: ["workspace", "explorer"]`), **plus** a surface and sidebar item. The original explorer-only registration was unreachable on compact layouts: the compact tab switcher offers only new agent and new terminal, the compact Explorer overlay has no panel launcher, and a plugin `openPanel(..., { location: "explorer" })` does not reveal the overlay. The sidebar row is the one host-wide entry that exists on every layout. Data stays host-global. | user request + mobile findings |
| 4.6 | Admin key + base URL stored in one plugin settings document; no env-var override. | user + SDK constraint |

### 4.4 — visible consequence to accept

With no status badge, an `error` request renders as a card with `-` tokens, `-` cost and a short
duration, indistinguishable from a request that has not yet reported usage. In-flight requests are
identifiable because their `Dur` ticks and their perf line shows an estimated `~N t/s` (§7.3).
If that proves confusing in use, the minimal fix is a single `statusDanger`-tinted cost value for
non-`success` rows — **not implemented unless requested.**

---

## 5. Architecture

```
 Plexus daemon                Paseo daemon (plugin server module)        Paseo app (plugin client)
┌──────────────┐  SSE   ┌─────────────────────────────────────┐        ┌──────────────────────┐
│ /v0/management│──────►│ sse.ts  (parse frames)              │        │ panel.tsx            │
│   /events    │        │ live-store.ts (merge, cap, journal) │◄──RPC──│  useActivity() poll  │
│ /v0/management│──────►│ service.ts (connect, backoff,       │  delta │  card.tsx            │
│   /usage     │  REST  │   backfill, degraded mode)          │        │  scope-select.tsx    │
│ /v0/management│──────►│                                     │        │  settings-screen.tsx │
│   /keys      │        └─────────────────────────────────────┘        └──────────────────────┘
└──────────────┘           settings document (admin key, baseUrl)          polls every 1.5–5 s
```

- One SSE connection per plugin subprocess, independent of panel mount/unmount.
- The server keeps ≤ 250 records; the panel renders what the snapshot returns.
- Updates reach the panel by polling (only supported path at 0.10.0). Worst-case visual latency ≈ poll
  interval (1.5 s with in-flight rows, 5 s idle). In-flight durations tick locally at 4 Hz, so the feed
  still looks continuous.

### 5.1 Why not consume SSE in the client

- `AGENTS.md`: external integrations belong behind server-only adapters; credentials stay server-side.
- RN `fetch` streaming bodies and `TextDecoder` under Hermes are unverified, and `EventSource` cannot
  set the `x-admin-key` header (same reason Plexus's own UI uses `fetch` + `getReader()`).

---

## 6. Data mapping — Plexus cell → card field

Plexus desktop column order is `Status | Date | Key | API | Model | Tokens | Cost | Perf | Meta`
(`packages/frontend/src/pages/Logs.tsx:925-1040`; per-cell rendering in
`packages/frontend/src/components/logs/DesktopLogRow.tsx:470-700`). Mapping for our card:

| Plexus cell | Field(s) | Card rendering |
|---|---|---|
| API | `incomingApiType` → `outgoingApiType`, `isStreamed`, `isRaw`, `isPassthrough`, `isVisionFallthrough` | Line 1: `chat→messages · stream · raw · vision` (flags only when true) |
| Model (line 2) | `finalAttemptModel ?? selectedModelName` | Line 2: `gpt-5.4` |
| Model (line 3) | `reasoningEffort` | Line 2: `· high` (capitalized) |
| Model (line 3) | `serviceTier` / `requestedServiceTier` | Line 2: `· priority`, `· flex→priority` when requested ≠ reported |
| Tokens | `tokensInput`, `tokensCached`, `tokensCacheWrite`, `tokensOutput`, `tokensReasoning`, `tokensEstimated` | Line 3: `↑1.2k (c0/w0) ↓340 (r0)` + `*` when estimated |
| Cost | `costTotal` | Line 3: `$0.004200` |
| Perf | `durationMs`, `ttftMs`, `tokensPerSec`, derived E2E | Line 4: `2.3s · TTFT 410ms · 148 t/s · E2E 152 t/s` |
| Status / Date / Key | — | **not rendered** (decision 4.4) |
| Meta | — | **excluded** (user) |
| Model (line 1) | `incomingModelAlias` | **excluded** — user asked for the slug only; add as a prefix if wanted later |
| Model (line 2) | `provider` prefix / `upstreamModel` rewrite | **excluded** — "no underlying provider needed" |
| Model (line 4) | `visionFallthroughModel` | **excluded** (redundant with the `vision` flag) |

The mapping, merge and formatting live in `shared/` and are unit-tested; components only render.

---

## 7. Formatting rules (ported from Plexus, then tested)

Reference: `packages/frontend/src/lib/format.ts:127-350` (`formatNumber:127`, `formatCostIn:167`,
`formatMs:224`, `formatTPS:243`, `getEstimatedBytesPerToken:312`) and
`packages/frontend/src/components/logs/helpers.ts:13-103`.

1. **Counts** — humanized with ≤1 decimal and no thousands separator: `1.2k`, `340`. `0` and `null`
   render `-`. `tokensEstimated` appends `*`.
2. **Cost** — USD. `formatCostIn(costTotal, { currency: "USD", symbol: "$", decimals: 6 })`: `$0.004200`,
   and `$<0.000001` for a non-zero value below `10^-6`. The row cell then applies Plexus's cell rules:
   `0` → `-`, `null`/absent → `-` (`format.ts:167-199`; cell logic in `DesktopLogRow.tsx`).
3. **Perf** — duration: `0` → `∅`, `<1000` → `410ms`, else `2.3s` (1 dp). TTFT same, absent → `-`.
   TPS and E2E: 1 dp. E2E = `(tokensOutput + tokensReasoning) / (durationMs / 1000)`.
4. **Live rows** (`responseStatus === "pending"` or `durationMs == null`): duration = `now - startTime`,
   and an estimated throughput `~N t/s` derived from the latest `progress` event
   (`semanticBytesPerSec ?? bytesPerSec ?? semanticBytesReceived/elapsedMs*1000`) divided by a
   per-API bytes-per-token heuristic (`messages`/`gemini`/generic streaming 140, `chat` 215,
   `responses` 200, non-streamed 4.5 — `packages/frontend/src/lib/format.ts:312-350`, tests at
   `format.test.ts:4-41`). Always labelled `~`.
5. **Reasoning effort** — first letter uppercased (`high` → `High`).
6. **Service tier** — show when `serviceTier ?? requestedServiceTier` is non-null. Label the reported
   tier; when both exist and differ, `requested→reported`. Raw provider spellings decoded but not
   rendered.
7. **API labels** — base type before `:`, lowercased; unknown types render verbatim rather than `?`.

Clock skew: Plexus timestamps are server-side, so live durations compare against the client clock. The
snapshot returns `serverNow`; the client keeps `offset = serverNow - receivedAt` and uses
`now + offset` for in-flight math, clamped to `>= startTime`.

---

## 8. Server design

### 8.1 Modules

| File | Responsibility | Testable in isolation |
|---|---|---|
| `server/sse.ts` | incremental UTF-8 SSE frame parser (`TextDecoder{stream:true}`, handles split frames, CRLF, multi-`data`, unknown events) | yes, pure |
| `server/records.ts` | normalisation of untrusted SSE/REST payloads; names-only key projection | yes, pure |
| `server/http.ts` | `getJson()` and `openStream()` over `node:http`/`node:https`, with abort and connect timeouts | yes |
| `server/plexus-port.ts` | the four Plexus endpoints behind a `PlexusPort` interface | yes, against a local `http` fixture server |
| `server/live-store.ts` | merge/dedupe/cap/journal; per-scope projections; `snapshot(since, scope)` | yes, pure + injected clock |
| `server/service.ts` | settings subscription, connect/backoff/watchdog, backfill schedule, degraded mode, cleanup | yes, with a scripted `PlexusPort` and fake timers |

No third-party HTTP or SSE dependency: the server bundle is `platform: node`, so `node:http(s)` is
available, and the plugin subprocess's ability to resolve its own `node_modules` is unverified — the
parser is ~80 lines.

### 8.2 Connection state machine

```
unconfigured ──settings(key+url)──► connecting ──200──► live
      ▲                                  │                │
      │                           401/403│                │ 15s quiet → degraded (poll)
      │                                  ▼                │ 45s quiet → abort + reconnect
      └──settings changed── unauthorized ◄────────────────┘
                                         │ other status / error → retrying (backoff)
                            retrying ◄───┘
```

- Backoff: 1, 2, 4, 8, 16, 30 s (cap), reset to 1 s after a successful connect.
- Watchdog (heartbeat tick every 5 s): 15 s without bytes → `degraded` with 10 s REST polling;
  45 s without bytes (4 missed pings) → abort and reconnect.
- `unauthorized` stops retrying until the settings document changes (a bad key must not hammer Plexus).
- Every (re)connect triggers a backfill; the store dedupes by `requestId` and merges.

### 8.3 Scope filtering

Applied in the store's projection, **exact match** on `apiKey`:
`rows.filter(r => scope === null || r.apiKey === scope)`. Backfill requests stay unscoped
(`limit=100&sortBy=date&sortDir=desc`) because Plexus's `apiKey` filter is substring `LIKE`, which would
both over-match (`team-a` matches `team-a2`) and under-fill the 100-row window.

### 8.4 Store and delta protocol

- `Map<requestId, UsageRow>`, ordered view newest-first by `startTime desc, date desc, requestId desc`.
- Cap `MAX_ROWS = 250` (drop oldest by `startTime`), `BACKFILL_LIMIT = 100`, `JOURNAL_MAX = 400`.
- Every mutation bumps `seq` and pushes `{ seq, requestId }` to a bounded journal.
- `snapshot({ since, scope })`:
  - `since == null`, `since > seq` (cursor from a previous daemon), or `since` older than the journal →
    `reset: true` + full matching rows.
  - otherwise → only rows whose `seq > since` (a row may appear once per update; the client merges).
  - Scope changes are handled by the **client** resetting its cursor; the server keeps no per-client
    state, because one daemon can serve several Explorer docks.
- `progress` data is stored per `requestId` and projected into in-flight rows; it is dropped on
  `completed` (mirrors Plexus, which deletes the progress entry on completion).
- Periodic safety backfill every 60 s (recovers anything a buffering proxy swallowed — Plexus's own UI
  does not do this and silently misses events after a reconnect).

### 8.5 Degraded mode (proxy buffering)

If the socket stays open but no frame arrives for 15 s (Plexus pings every 10 s), switch to `degraded`:
poll `GET /v0/management/usage` every 10 s, keep the SSE socket open, and return to `live` on the next
received frame. At 45 s (four missed pings) abort and reconnect, which also re-backfills. The panel shows
a distinct pill (§11.4). Without this, a buffered proxy would freeze the panel at "Live" with stale data.

### 8.6 Cleanup

`return async () => {...}` from `contribute(server)`: abort the stream and any in-flight request,
clear timers, unsubscribe from settings, and make double-invocation a no-op.

---

## 9. RPC contracts (`shared/rpc.ts`)

Three contracts, all zod-validated on both sides. No contract ever returns the admin key, a full key
config, or `costMetadata`.

```ts
// 1. delta snapshot, the polling workhorse
plexusActivity.snapshot
  in : { scope: string | null; since: number | null }
  out: {
    status: {
      configured: boolean;
      connection: "unconfigured" | "connecting" | "live" | "degraded" | "retrying" | "unauthorized" | "error";
      lastEventAt: number | null;
      lastError: string | null;      // redacted, no key material, no URLs with credentials
      retryInMs: number | null;
    };
    cursor: number;                  // server seq
    serverNow: number;               // epoch ms, for clock-skew correction
    reset: boolean;
    rows: UsageRow[];                // <= MAX_ROWS
  }

// 2. key names for the scope dropdown
plexusActivity.keys
  in : { refresh?: boolean }   // refresh re-reads Plexus instead of the server cache
  out: { status: "ok" | "unavailable" | "unauthorized"; role: "admin" | "limited" | null;
         keys: { name: string; disabled: boolean }[] }   // names only, never secrets

// 3. validate a candidate credential without saving it
plexusActivity.verify
  in : { baseUrl: string; adminKey: string }
  out: { ok: boolean; role: "admin" | "limited" | null; keyName: string | null; error: string | null }
```

Deliberate omissions: no `secret`, no `KeyConfig`, no raw error objects (only a message string).

---

## 10. Settings (`shared/settings.ts`)

```ts
defineSettings({
  id: "config", scope: "host", version: 1,
  schema: z.object({
    baseUrl: z.string().trim().default("http://localhost:4000"),
    adminKey: z.string().trim().default(""),                     // write-only in the UI
    defaultScope: z.string().trim().nullable().default(null),    // key name or null = All keys
  }),
});
```

- `baseUrl` is deliberately a plain string: a URL-validated schema would invalidate the whole document
  (including the stored key) on a typo. It is normalised where it is used instead — trim, strip a
  trailing `/`, require `http:`/`https:`, reject embedded credentials or query strings — and a bad value
  surfaces as the `error` connection state with a CTA back to the settings screen.
- Empty `adminKey` ⇒ `unconfigured`; the panel shows a CTA that calls `client.openSettings("settings")`.
- The settings screen verifies a new key with `plexus.activity.verify` before saving, so a typo never
  replaces a working credential.
- The base URL is required in practice (the daemon need not share a host with Plexus); it is not
  explicitly requested by the user but the plugin cannot work without it.
- **Platform limitation to accept:** settings JSON is not a vault and `useSettings` hands values to the
  plugin client. Mitigations: the key field is write-only (empty with a `••••••••` placeholder), no RPC
  returns it, it is never logged, and it only ever reaches the outbound `x-admin-key` header.

---

## 11. Client design

### 11.1 Registration (`index.client.tsx`)

```ts
client.addWorkspacePanel({
  id: "activity", title: "Plexus activity", icon: "Activity",
  context: "workspace", locations: ["workspace", "explorer"], Component: ActivityPanel,
});
client.addSurface("activity", ActivitySurface);          // full-screen view
client.addSidebarItem({ id: "activity", title: "Plexus activity", icon: "Activity", surface: "activity" });
client.addSettingsScreen({ id: "settings", title: "Plexus activity", icon: "SlidersHorizontal", Component: SettingsScreen });
client.addCommandCenterItem({ id: "open-plexus-activity", title: "Open Plexus activity", icon: "Activity",
  context: "workspace", onSelect: ({ openPanel }) => openPanel("activity") });
client.addCommandCenterItem({ id: "open-plexus-activity-explorer", title: "Open Plexus activity in Explorer",
  icon: "Activity", context: "workspace",
  onSelect: ({ openPanel }) => openPanel("activity", { location: "explorer" }) });
```

Icon names must be Lucide names (unknown names render nothing, `AGENTS.md`). `PluginCommandCenterItemBase`
is `{ id, title, icon, keywords? }` and the workspace form calls `onSelect(context)` with
`openPanel(id, options?)` on it (`dist/client/contracts.d.ts:155-170`).

### 11.2 Panel

- Root `flex: 1`, `surface0` background; header row + `FlatList`.
- Header: scope selector (`All keys` + names from `plexusActivity.keys`), connection pill, and a
  "pause" toggle that stops polling and delta application without dropping the server stream.
  Key names are truncated with a middle ellipsis; the selector is a small `Modal` list rather than a
  native picker so it looks the same on iOS, Android and web.
- If `plexusActivity.keys` is `unauthorized`/`unavailable`, the selector falls back to a free-text key
  name input in a modal (degradation path; admin keys normally get the list).
- Empty, loading, unconfigured, unauthorized, and error states are explicit components, not blank rows.
- `FlatList` with `keyExtractor: row.requestId`, newest first, no index keys.
- A 250 ms–500 ms ticker updates `now` **only** while at least one row is in flight (Plexus does 500 ms),
  so idle panels do no work.

### 11.3 Card

Four text lines, all values from §6; `props: { row, now, offset, theme, compact }`:

```
chat→messages · stream · raw
gpt-5.4 · High · priority
↑1.2k (c0/w0) ↓340 (r0) · $0.004200
2.3s · TTFT 410ms · 148 t/s · E2E 152 t/s
```

- Abbreviations (`c`, `w`, `r`, `t/s`) stay fixed at every width; wide docks simply get more whitespace.
  Values wrap rather than clip when a long slug pushes the line.
- In-flight rows: perf line shows ticking `Dur` + `~N t/s` in `foregroundMuted`; no status badge (4.4).

### 11.4 Connection pill

`live` → `statusSuccess` dot + "Live"; `degraded` → `statusWarning` + "Polling"; `retrying` →
`statusWarning` + "Retrying · Ns"; `unauthorized` → `statusDanger` + "Key rejected";
`unconfigured` → `foregroundMuted` + "Not configured"; `error` → `statusDanger` + "Error".
The pill is the only status-colored chrome; row text uses `foreground`/`foregroundMuted` only.

### 11.5 Theme and platform rules

- One `createStyles(theme, compact)` factory, memoized on `[theme, compact]`.
- Only the 11 `theme.colors` tokens; no hardcoded hex, no per-provider or per-tier brand colors
  (Plexus uses cyan/emerald/fuchsia icon colors — those do not exist here and are not reproduced).
- Transparency via `opacity`, not hex-alpha string concatenation (theme values need not be 6-digit hex).
- Primary text `theme.colors.foreground`, secondary `theme.colors.foregroundMuted`, cards `surface1`
  with `border` hairlines, selection/interaction `accent`.
- No `client/web.ts` needed: no DOM globals, no browser APIs; clipboard is `copyText` from the host,
  URLs open only through the settings `ExternalLink`/actions.
- No ES6 classes and no `node:*` imports in `client/` or `shared/`.

### 11.6 Settings screen

Sections: **Connection** (`SettingsInput` base URL, `SettingsInput secureTextEntry` admin key,
`SettingsAction` "Test & save"), **Display** (`SettingsSelect` default scope from keys RPC),
**Status** (read-only: configured, connection state, last event, plugin version).
Flow: local draft → `verify` RPC → `useSettings().save(values, revision)`; on `conflict`, reload and
re-apply the draft once; surface `saveError`/field errors inline. The key field starts empty with
placeholder `••••••••` when one is already stored; "Clear key" resets it.

---

## 12. File layout

```
plexus-activity/
  paseo-plugin.json        { "id": "plexus-activity", "requirements": { "paseo": ">=0.10.0" } }
  package.json             @getpaseo/* pinned 0.10.0 (sdk:check enforced)
  tsconfig.json            lib: ["ES2023"] — no DOM, noUncheckedIndexedAccess
  vitest.config.ts         aliases the host-provided @getpaseo/* modules to a stub
  index.client.tsx         panel + surface + sidebar item + settings screen + commands
  index.server.ts          registerSettings, 3 RPC handlers, service start/stop
  shared/
    settings.ts            defineSettings + base-URL normalisation
    rpc.ts  view.ts        contracts and the serializable row/status schemas
    row-model.ts           record folding, ordering, scope matching, projection
    format.ts  api-types.ts    Plexus-parity formatting and the throughput heuristic
    *.test.ts
  server/
    sse.ts                 incremental UTF-8 SSE frame parser
    records.ts             untrusted-payload normalisation (names-only key projection)
    http.ts                node:http(s) JSON + streaming client with abort paths
    plexus-port.ts         the Plexus endpoints behind an interface
    live-store.ts          merge, cap, journal, delta snapshots, progress decoration
    service.ts             settings subscription, connect/backoff/watchdog/degraded, cleanup
    *.test.ts              fake timers + a scripted port
  client/
    panel.tsx  card.tsx  scope-select.tsx  settings-screen.tsx
    use-activity.ts        snapshot polling + key list + session scope memory
    styles.ts              one memoized theme/compact style factory
    index.client.test.ts   registration contract (panel, surface, sidebar item, commands)
    bundle.test.ts         esbuild + no-classes + size budget + hermesc
  test/stubs/plugin-sdk.ts
  docs/SCOPE.md
  README.md
```

Repo wiring: `"plexus-activity"` is in `plugins` in `.paseo-sdk.json` (so `npm run sdk:check` validates
the pins) and listed in the root `README.md` plugin list.

---

## 13. Risks and limitations (explicit)

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | No server→client push at 0.10.0 | 1.5–5 s display latency | small delta payloads; local 4 Hz ticker for durations |
| R2 | Settings are not a credential vault; `useSettings` exposes the key to the plugin client | key readable by any client authorized to manage the host | write-only field, never in RPC output, never logged; documented |
| R3 | `GET /v0/management/keys` returns plaintext secrets | accidental leak | project `Object.keys()` only; zod output schema forbids extra fields; test asserts `secret` never serialized |
| R4 | Proxy buffering of SSE (no `X-Accel-Buffering`) | frozen panel while claiming live | 45 s watchdog → degraded 10 s polling; 60 s backfill backstop |
| R5 | `id:` is not a resume cursor; no replay | missed events across reconnects | backfill on every connect |
| R6 | `apiKey` REST filter is substring `LIKE` | wrong scope results | none on the wire; exact local filtering |
| R7 | Remote Plexus vs client clock skew | wrong live durations | `serverNow` offset correction, clamped |
| R8 | Live `~t/s` is a bytes heuristic | approximate number | always prefixed `~`, never shown for completed rows |
| R9 | Mobile runtime (`eval()` on Hermes) | plugin silently dropped on iOS | `client/bundle.test.ts` (esbuild + no-class regex + size budget + `hermesc`) and a device smoke test |
| R10 | Plexus `date` is an ISO string, not a date | wrong date filters | we send no date filters |
| R11 | Limited (non-admin) key yields a pre-scoped stream and 403s on `/keys` | the scope dropdown cannot list keys; only that key's events arrive | detect `role: "limited"` from `verify`, show a hint, fall back to a free-text key name, accept server-side scoping |
| R12 | Compact layouts expose no panel launcher (tab switcher offers only new agent/terminal) and do not reveal the Explorer overlay for a plugin `openPanel(..., { location: "explorer" })` | a panel-only plugin is unreachable on a phone | register a surface + sidebar item, which the sidebar drawer renders on every layout |

Spec/impl drift worth knowing: `/v0/management/usage` documents an `attribution` filter the handler
ignores, and a 500-row `limit` cap that is not enforced. We neither use nor rely on either.

---

## 14. Verification checklist

1. `npm ci` in `plexus-activity/`; `npm run lint`, `npm run typecheck`, `npm test`; root `npm run sdk:check`.
2. Tests: format parity cases from Plexus (`format.test.ts` fixtures), SSE parser edge cases
   (split multi-byte UTF-8, CRLF, unknown events, `ping`), store merge/journal/cap, service reconnect
   and 401-stop with a scripted port and fake timers, RPC output schemas reject `secret`.
3. Boundary checks: `client/` imports no `server/` and no `node:*`; `shared/` is runtime-neutral.
4. `paseo plugin install ./plexus-activity` → `paseo plugin reload plexus-activity` → `paseo plugin ls`
   and `paseo plugin logs plexus-activity` clean.
5. Live: unconfigured → save key via settings (Test & save) → panel goes Live under 2 s; run one request
   and one multi-second streamed request; verify ticking duration, `~t/s`, then final TTFT/TPS/E2E.
6. Scope: pick one key, confirm exact filtering (a `team-a2`-style neighbour key must not appear),
   confirm the default scope applies on a fresh panel mount.
7. Failure paths: revoke the key (expect `Key rejected`, no retry storm), stop Plexus (expect
   `Retrying` then recovery), reload the plugin mid-stream (expect clean reconnect, no duplicate rows).
8. Mobile: verify Settings → Plugins shows no evaluation error on iOS, the **sidebar row** opens the
   full-screen view, and the panel renders at the 240 pt minimal dock width.

---

## 15. Implementation status

Verified locally:

- 98 unit tests across format parity, API labels and the bytes-per-token heuristic, record folding and
  ordering, SSE framing, store deltas/caps/eviction, and the service state machine (connect, backfill,
  sparse merge, ping handling, degraded polling, idle abort, 401 halt, reconnect backoff, settings-change
  reset, key caching/refresh, verify, idempotent cleanup).
- `biome check`, `tsc --noEmit`, and root `npm run sdk:check` are clean.
- `client/bundle.test.ts` reproduces Paseo's client compile: no ES6 classes, 48 KB bundle (budget
  320 KB), and `hermesc` bytecode generation on hosts with the prebuilt.
- Installed on a live daemon: `paseo plugin install ./plexus-activity` → `running`, `Plugin ready`, no
  load errors, and it stays dormant (no outbound connection) while no admin key is configured.

Not yet verified — needs a real Plexus and a device:

- End-to-end streaming against a live Plexus instance, including live `~t/s` estimates.
- iOS/Android smoke: Settings → Plugins shows the plugin active with no evaluation error, and the panel
  renders correctly at the 240 pt minimum dock width.
- Proxy-buffering behaviour through the actual reverse proxy in front of Plexus.

---

## 16. Open items (decide later, not blockers)

- Whether to render `incomingModelAlias` as a prefix (Plexus's Model line 1).
- Whether error rows need a `statusDanger` cost tint, given decision 4.4 hides status.
- Whether to keep finished rows forever in the view or expire them after N minutes of idleness.
- Whether a per-workspace default scope is meaningful (currently one host-scoped setting).
