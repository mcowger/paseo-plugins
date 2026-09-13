# Paseo plugins

Published plugins for [Paseo](https://paseo.sh/), targeting the Paseo 0.8 plugin API and
`@getpaseo/*` SDK `0.8.0`.

Plugins use separate `index.client.tsx` and `index.server.ts` entries with strict `client/`,
`server/`, and `shared/` boundaries. See Paseo's [0.8 migration guide](https://paseo.sh/docs/plugins/v0.8/migration)
when contributing changes.

## Plugins in this repository

- [Scratch Chat](./scratch-chat/README.md)
- [Pi tasks timeline](./pi-tasks-timeline/README.md)
- [Pi provider (mcowger)](./pi-plugin-mcowger/README.md)
- [OpenCode session overview](./opencode-session-overview/README.md)
- [Subagent activity](./subagent-activity/README.md)
- [Session summary](./session-summary/README.md)
- [Reasoning display](./reasoning-display/README.md)
- [Colorful agent activity](./colorful-agent-activity/README.md)
- [Theme Studio](./theme-studio/README.md)

## Reference index and community registry

- [Community reference index](./examples/README.md): Extensive index of public Paseo plugins organized by architectural technique (surfaces, panels, timeline transformers, composer pills, providers, lifecycle automation, telemetry, themes) with source and registry links.
- [paseo.cafe](https://paseo.cafe/): The community plugin directory and registry. Machine-readable endpoints:
  - Catalog: [`https://paseo.cafe/api/plugins`](https://paseo.cafe/api/plugins)
  - LLM index: [`https://paseo.cafe/llms.txt`](https://paseo.cafe/llms.txt)
  - Registry repo: [`paseo-cafe/paseo-cafe/tree/main/registry`](https://github.com/paseo-cafe/paseo-cafe/tree/main/registry)

