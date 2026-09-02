# Reasoning display plugin

This plugin replaces Paseo's built-in reasoning rows with a collapsible Markdown renderer. It
supports three display modes:

- **Collapsed** — reasoning starts collapsed.
- **Expand last** — only the newest reasoning row starts expanded.
- **Always expand** — every reasoning row starts expanded.

The plugin adds a **Reasoning Display** sidebar surface for changing the mode. The selection is
stored in `$PASEO_HOME/plugin-data/reasoning-display.json` through the plugin's own RPC handler.

The plugin does not modify Paseo core code. Install its dependencies, typecheck it, then install it
as a directory source:

```bash
cd /absolute/path/to/reasoning-display
npm install
npm run typecheck
paseo plugin install "$PWD"
paseo plugin reload reasoning-display
```

The renderer uses only modules supplied to plugin client bundles. It implements the small Markdown
subset needed for thinking text instead of importing Paseo's private Markdown components.
