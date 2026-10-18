# Injecting custom composer controls in Paseo

How to replace or enrich Paseo composer controls from a client plugin without patching Paseo core or rebuilding the composer.

## The problem

Paseo lets custom provider plugins publish session settings (`ProviderSetting[]` in `@getpaseo/plugin/server/provider`). These flow to the client as `AgentFeature[]` and render in the composer toolbar:

```
Provider server (settings: ProviderSetting[])
  -> Paseo server (maps to AgentFeature[])
  -> Client app (renders DesktopFeatureItem with testID="agent-feature-<id>")
```

The native UI is very rigid:

- Only two control types exist: `toggle` (boolean button) and `select` (dropdown combobox). No sliders, switches, or segmented buttons.
- Feature icons are hardcoded in `packages/app/src/agent-controls/icons.ts`. Paseo only knows `list-todo`, `shield-check`, and `zap`. Every other icon name falls back to `Settings2`.
- Toolbar space is tight. Select controls show label text that truncates quickly, and Paseo aggregates overflow into a modal sheet (`agent-features-sheet`).

For things like PlexusPi's service tiers (`default`, `fast`, `flex`, `ultrafast`) or context length targets (`200k` vs `1M`), a plain dropdown with a generic gear icon works, but looks rough.

## The technique

Paseo's web and desktop clients run React Native for Web in a standard browser document. Plugin client bundles (`index.client.tsx`) run in that same JS environment and have direct DOM access.

Instead of fighting Paseo's React internals or replacing the entire composer, use the native control as a headless proxy:

1. Let Paseo render its native feature control normally so backend state tracking remains wired up.
2. In the client plugin, target the control's container via `data-testid`.
3. Suppress the native button/combobox visually with injected CSS.
4. Mount a custom DOM element into the container (segmented buttons, sliders, custom SVGs).
5. Drive the hidden native control when the user clicks the custom UI, or send a direct plugin RPC.

```
+------------------------------------------------------------------+
| Composer toolbar                                                 |
|                                                                  |
| [Model]  [Thinking]  [data-testid="agent-feature-tier"]           |
|                      |                                           |
|                      +-- Native trigger (display: none)          |
|                      |                                           |
|                      +-- Injected UI (segmented pills)           |
|                          [ Auto | Fast | Flex* ]                 |
+------------------------------------------------------------------+
```

## Step-by-step mechanism

### 1. Register a client adapter

Plugins declare client scripts in `paseo-plugin.json`:

```json
{
  "name": "my-provider-plugin",
  "client": "dist/index.client.js"
}
```

In `index.client.tsx`, start the adapter alongside your normal screen or command registrations:

```ts
import type { PluginClientContext } from "@getpaseo/plugin/client";

export default function contribute(client: PluginClientContext): () => void {
  const cleanup = installCustomControls(client);
  return () => {
    cleanup();
  };
}
```

### 2. Inject suppression styles

Inject a scoped stylesheet into `document.head`. The rule hides the native trigger children while keeping the root container mounted in Paseo's layout:

```ts
const css = document.createElement("style");
css.textContent = `
  /* Hide the native Combobox trigger for our feature */
  [data-testid="agent-feature-tier"] > [role="button"],
  [data-testid="agent-feature-longContext"] > [role="button"] {
    display: none !important;
  }

  /* Style the injected container */
  .custom-feature-slot {
    display: flex;
    align-items: center;
    gap: 4px;
  }
`;
document.head.appendChild(css);
```

Keeping the container visible lets Paseo maintain its layout flexbox measurements.

### 3. Observe mounting and DOM lifecycle

Paseo mounts and unmounts the composer toolbar as users switch agents, workspaces, or tabs. Use a `MutationObserver` to watch for the target controls:

```ts
const TARGETS = [
  "agent-feature-tier",
  "agent-feature-longContext",
];

const observer = new MutationObserver(() => {
  for (const id of TARGETS) {
    const el = document.body.querySelector(`[data-testid="${id}"]`);
    if (el && !el.querySelector(".custom-feature-slot")) {
      mountCustomControl(id, el);
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });
```

### 4. Mount the custom controls

When the container appears, create a slot element and render the custom UI:

- **Segmented button group for tiers:** Instead of a dropdown, render horizontal pills (`Auto`, `Fast`, `Flex`). Highlight the active selection. Add custom SVGs or Lucide icons directly.
- **Toggle switch or slider for context length:** Instead of a select box picking `200k` or `1M`, render a toggle switch or two-step slider with token labels.

```ts
function mountCustomControl(featureId: string, container: Element) {
  const slot = document.createElement("div");
  slot.className = "custom-feature-slot";

  if (featureId === "agent-feature-tier") {
    // Read available options from the native DOM if needed, or define the UI:
    const tiers = ["default", "fast", "flex"];
    for (const tier of tiers) {
      const btn = document.createElement("button");
      btn.textContent = tier;
      btn.onclick = () => selectTier(tier, container);
      slot.appendChild(btn);
    }
  }

  container.appendChild(slot);
}
```

### 5. Sync state back to the provider

You have two clean ways to send user updates back to the backend.

#### Option A: Drive the native control (zero backend changes)

Because the native trigger is still in the DOM (just hidden), you can trigger it programmatically:

1. Click the native trigger to open Paseo's Combobox popover.
2. Query the option corresponding to the chosen value (`[role="option"]` matching the label).
3. Call `.click()` on the option.

This triggers Paseo's internal `setAgentFeature(agentId, featureId, value)` call. Paseo then calls `bridge.configure({ settings: { ... } })` on your provider server, which forwards the change to the control.

#### Option B: Direct plugin RPC

If simulating clicks on the combobox feels fragile across Paseo updates, bypass the native combobox entirely:

1. Define an RPC in your plugin shared contracts:
   ```ts
   export const updateSettingRpc = defineRpc<
     { agentId: string; key: string; value: unknown },
     { ok: boolean }
   >("my-plugin:update-setting");
   ```
2. When the custom control changes, call `client.rpc(updateSettingRpc, { agentId, key, value })`.
3. In your provider server, handle the RPC and call your control or session configure method directly.

This avoids interacting with Paseo's combobox DOM entirely.

### 6. Sync UI when Paseo updates state

When the user switches models, your provider might change advertised tiers (e.g. from 4 tiers down to none).

Paseo will update or remove `data-testid="agent-feature-tier"`. The `MutationObserver` picks this up:

- If the native container is removed, Paseo determined the feature is inactive. Remove your injected elements.
- If Paseo updates the native label or aria attributes, re-read the active value and update the highlighted pill in your custom UI.

## Edge cases to handle

1. **Toolbar overflow / feature aggregation:**
   When the composer toolbar runs out of width, Paseo collapses loose features into a sheet (`presentation.aggregateFeatures` in `agent-controls/index.tsx`). The feature moves inside `[data-testid="agent-features-sheet"]`. Your observer should check for the test IDs both in the main toolbar and inside the modal sheet.

2. **Compact / mobile layout:**
   On narrow viewports, Paseo uses bottom sheets instead of inline dropdowns. Check `window.matchMedia` or container widths. If space is tight, fall back to native rendering or show an icon-only popover trigger.

3. **Fail-open fallback:**
   If your script encounters unexpected DOM structures or errors during mounting, remove the suppression CSS class. The native Paseo dropdown will show up as a fallback rather than leaving an empty space in the composer.

4. **Teardown:**
   When `contribute()` returns its cleanup function, disconnect the `MutationObserver`, remove the injected `<style>` tag, and delete any `.custom-feature-slot` elements so reloads stay clean.
