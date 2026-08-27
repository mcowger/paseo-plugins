# Paseo plugin guidance

This repository contains Paseo plugins. Use the following Paseo resources as the source of truth
when creating or changing a plugin:

- [Plugin guide](https://paseo.sh/docs/plugins.md): setup, installation, development workflow,
  lifecycle, and debugging.
- [Plugin API reference](https://paseo.sh/docs/plugins/reference.md): contribution surfaces,
  components, SDK usage, RPC, themes, hosts, and troubleshooting.
- [Official plugin examples](https://github.com/getpaseo/paseo/tree/main/plugin-examples):
  working examples for panels and commands, RPC, attachment sources, themes, and timeline items.

## Development reminders

- The plugin API is experimental and may include breaking changes.
- Plugins are trusted, unsandboxed code. Keep daemon-only work and credentials in server modules;
  client modules run inside Paseo.
- Keep `*.client.tsx`, `*.server.ts`, and `*.shared.ts` boundaries separate. Use host-provided
  modules rather than private Paseo internals.
- The plugin entry point should default-export the contribution function and return cleanup for
  timers, watchers, sockets, and other resources.
- Validate RPC inputs and outputs with Zod, keep secrets server-side, and never log credentials.
- Use lowercase IDs containing only letters, numbers, and hyphens.

For the normal local workflow, install dependencies and typecheck from the plugin directory, then
reload the installed plugin explicitly with `paseo plugin reload <plugin-id>`.
