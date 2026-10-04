# Paseo Pi Integration — Current Limits & Working Capabilities to Borrow

Historical native-Paseo survey from 2026-10-03, retained at its source snapshot.
"Current" below means that snapshot; external PR/issue status hasn't been
rechecked. This isn't Superpi's present feature/limit list. Start with
[the provider README](../README.md) and [Paseo shortcomings](PaseoShortcomings.md).

**Verified against:** paseo `0.11.0-beta.3` @ `5293ddac3` (`~/workspace/paseo`)
**Source basis:** survey of pi session logs Aug–Oct 2026 (~2,730 sessions), cross-checked against current source.

Part 1 lists limitations that still exist in 0.11.0-beta.3. Part 2 lists capabilities that *do* work today — including things fixed since the original complaints — that are worth borrowing into the pi plugin / extensions work.

---

## Part 1 — Limits that still exist

### 1.1 Environment / PATH propagation (High impact)

Agents launched by paseo inherit only the daemon's own `process.env`, sanitized of paseo internals (`packages/server/src/utils/spawn.ts:56-74` → `paseo-env.ts:31-47`). There is **no login-shell / shellenv / mise handling anywhere** in the source. Anything mise manages (`gh`, `node` versions, CLIs) is invisible to pi children unless the daemon itself was launched from an interactive shell.

- Symptom: "Why can't agents running under paseo find 'gh' consistently on path? mise is installed and working."
- Executable discovery relies on plain PATH lookup (`packages/server/src/executable-resolution/executable-resolution.ts:54`).
- **Limit:** no mechanism to re-resolve PATH through the user's shell of choice, or to declare required tools with diagnostics when missing.


### 1.4 "Invalid mode" error reachable for pi (Low)

Pi now correctly advertises zero modes (`provider-manifest.ts:243-248`), and the default path skips mode validation. But an *explicit* `mode: "build"` in config still throws `Invalid mode 'build' for provider 'pi' (none)` from the shared validator (`create-agent-mode.ts:48-53`) — there is no pi-specific guard that maps this to a friendlier "pi has no modes" message or silently drops the field.  Corrected in https://github.com/getpaseo/paseo/pull/5377, but unmerged.

### 1.5 Strict pi `providerOptions` schema (Low–Medium)

`PiProviderOptionsSchema` is `.strict()` and accepts only `sessionDir`, `rpcTimeoutMs`, `extensionTimeoutMs` (`agent.ts:108-114`). Any extra options passed by a custom provider plugin (e.g. the pi plugin's own options) are silently rejected/ignored by the built-in client. Generic plugin providers now plumb `env/toolPolicy/settings/providerOptions` correctly (`plugin-provider.ts:1611-1646`) — the built-in pi provider did not adopt the same leniency.

### 1.6 pi `toolPolicy` hand-off unclear (Medium, needs confirmation)

The built-in pi provider has no clearly visible pass-through of `toolPolicy` into the pi session (checked around the MCP/tool wiring at `agent.ts:2722-2763`). The generic plugin contract applies tool policy (`applyToolPolicy`, gated on `supportsExactMcpPreapproval`, `provider-registry.ts:649-660`), but for the built-in pi path the tool restriction story remains: the restrictions of the `pi` provider are not expressible for custom pi providers in one place — the original complaint ("can we set those same restrictions in config.json for a custom provider?") is only half-solved.

### 1.7 No composer surface for pi runtime settings (High)

`/compact` and `/autocompact` exist as slash commands (`agent.ts:117-127, 1765, 1810`), but there is **no auto-retry toggle** or dedicated runtime-settings UI in the composer (`packages/app/src/composer/` — nothing found). Settings live only in the command palette.   This is really problematic

### 1.8 Cancel ≠ stop (High)

`cancelAgentRunNow` (`agent-manager.ts:3010-3070`) does interrupt-then-wait with force-cancel fallbacks — good — but there is **no single cancel-then-stop RPC**. Stopping/archiving (`archive/delete`, `messages.ts:913,919`; `closeAgent`, `agent-manager.ts:1668`) is a separate operation. To stop a pi child cleanly you must sequence two RPCs and hope nothing starts a new turn in between. The desired pattern ("issue cancel, get confirmation, wait, then stop") is not a first-class API.


### 1.12 Residual reload race (Low)

The hardened reload path (`StaleProviderSessionError` + auto-retry, commits `8598b6aab` / `849a876bc`) covers the common case, but the raw `"Provider runtime is closed"` throws still exist at `plugin-provider.ts:354,381,394` and can surface on a genuine connect/reload race (session opened while runtime is closing). Rare, but not impossible.


### 1.13 Residual reload race (Low)
 Paseo does not respect steered as a terminal subagent state. Your pi-subagents extension
 treats steered as terminal, but Paseo's tintinweb adapter maps it to running — Paseo ignores
 the extension's state semantics.

### 1.14 Paseo's Pi provider cannot dispatch control commands out-of-band — they must ride the prompt channel.

 1. Control commands from the service-tier pill go out as ordinary agent messages (/service-tier
    fast), and the SDK's activeTurnBehavior defaults to "interrupt" when omitted — replacing the
    active run.
 2. Passing "steer" doesn't help: Paseo's pi provider explicitly rejects slash-command inputs in
    steerActiveTurn (pi/agent.ts:1345), falling back to interrupt-and-replace.
 3. The out-of-band path (tryRunOutOfBand) would be non-interrupting, but the pi provider's
    tryHandleOutOfBand only whitelists compact/autocompact (pi/agent.ts:1594) — no extension slash
    command can use it.
 4. Pi itself executes extension commands regardless of streaming — the limitation is purely
    Paseo-side.

---

## Part 2 — What works today and is worth borrowing

### 2.1 Proven fixed capabilities (no longer limits)

These original complaints are demonstrably fixed in 0.11 and should be treated as the new baseline:

| Capability | Where |
|---|---|
| Per-model thinking-level mapping (drops unsupported levels, reports the applied level) | `agent.ts:1097-1135`; #4413 |
| Composer model picker fed from pi's real catalog incl. extension models, configured default marked | `agent.ts:2601-2641`; #5343 |
| Rewind/fork via pi session tree navigation with stable persisted tokens | `rewind.ts`, `agent.ts:97-107, 165`; #5383, #5432 |
| Todo extensions feeding the composer task-list track | `rpiv-todo`, `pi-example-todo`, `pi-goal-x`; #5309 |
| Model-aware image gating + file-path materialization for text-only models | `agent.ts:365-419` |
| Startup diagnostics: command/binary/auth rows, MCP probe failures, extension failures as timeline notifications | `agent.ts:2683-2760`, `host.ts:112-116` |
| Turn state machine with `agent_settled` + retry-aware pending messages (no more stuck-running agents) | `agent.ts:2120-2256`; #3849 |
| MCP dual-mode: auto-detects builtin vs pi-mcp-adapter via `get_commands`, merges paseo servers with the user's `mcp.json` without clobbering | `agent.ts:2707-2760, 571-612` |
| Timeline transformers/renderers + themes (plugin can restyle reasoning/tool calls/color) | `plugin/contracts.ts:141-146`; worked example `plugin-examples/inline-thinking` |
| Transforms run before Overview grouping | `presentation.ts:144-176` |
| Server-side plugin settings with host scope, revisions, atomic writes | `plugin/contracts.ts:25-37` |
| Hermes-compatible client bundles (explicit async lowering + eager CJS interop) | `compiler.ts:305-421` |
| Durable session persistence (no disappearing conversations) | `AgentPersistenceHandle`, `session-descriptor.ts` |
| `/compact` + `/autocompact` wired end-to-end | `agent.ts:1765, 1810`; `cli-runtime.ts:135-143` |
| Manifest `requirements` validation with prerelease-aware matching (`0.11.0-beta.3` satisfies `>=0.8.0`) | `plugin-requirements.ts:28-47` |
| LLM worktree naming logs its fallbacks instead of failing silently | `worktree-branch-name-generator.ts:140-149` |

### 2.2 Patterns worth borrowing into the pi plugin / extensions

**a. Stale-session recovery pattern.** `StaleProviderSessionError` → `reloadAgentSession` → retry-on-next-prompt (`agent-prompt.ts:115-165`). If the pi plugin (or a subagent extension) ever has an interrupted child/session, adopt the same "mark stale, transparently reload, retry" flow rather than surfacing an error.

**b. Terminal-signal discipline.** The turn FSM's explicit `agent_end` / `agent_settled` boundaries with `pendingSettledMessages` buffering (`agent.ts:2120-2256`) is exactly the shape your subagent extension needed for "paseo still thinks it's running." Borrow the buffering-before-terminal-emission pattern for subagent completion notifications: never emit terminal state before the result is persisted, buffer anything arriving early.

**c. Capability auto-detection via probe.** `prepareMcpInjection`'s `get_commands` probe to choose builtin vs adapter (`agent.ts:2707-2760`) is the right way to handle the fracturing pi extension ecosystem: probe at session start, adapt, and record what was detected (it feeds `supportsMcpServers`). Borrow for subagent extensions: probe the extension's capabilities at admission instead of hardcoding per-package heuristics.

**d. Dual-write config that preserves user state.** The MCP path merges paseo-owned servers into a generated `--mcp-config` file while preserving the global `mcp.json` (`agent.ts:571-612`). Any paseo↔pi shared state (settings, presets) should follow the same "generated overlay over user-owned base" pattern.

**e. Per-model capability gates with graceful degradation.** `piModelSupportsImageInput` → materialized file hint (`agent.ts:369-419`) is the template for any model-dependent behavior: check the catalog capability, degrade to a text equivalent, never break the session.

**f. Prerelease-aware requirements matching.** `plugin-requirements.ts` strips the prerelease core before `satisfies` — every pi extension that version-gates on the host should use the same logic (the `host_capability_unavailable` / `pi_version_unsupported` refusal you hit would be friendlier with it).

**g. Extension failure → timeline notification.** Extension load failures surface as provider notifications in the chat timeline (`host.ts:112-116`) rather than only logs. Subagent extensions should do the same for admission failures (e.g. blocked MCP tools, pinned-model rejection) so the user sees *why* inside the conversation.

**h. Diagnostics rows pattern.** `getDiagnostic()`'s formatted command/binary/auth rows (`agent.ts:2683-2706`) is a clean way to expose "what env did the child get / what PATH / which binary resolved" — directly addresses the PATH-propagation limit if borrowed for agent env display.

---

## Summary

The 0.11-beta.3 codebase resolved nearly every architectural complaint from the survey: rewind, todos, MCP staleness, subagent streaming/terminal-state, reload crashes, diagnostics, and the "limited in-tree provider" cluster. The remaining limits are environmental (PATH/mise), cosmetic-adjacent (reasoning collapse, mode error, tool-name normalization), pi-provider strictness (`providerOptions`, `toolPolicy`), and — most significantly — subagent *policy* enforcement, which is deliberately extension-side and remains the main open design work (the PI_SUBAGENTS_SPEC track).
