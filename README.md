# Paseo plugins

Plugins and local experiments for [Paseo](https://paseo.sh/), targeting the Paseo 0.10 plugin API and
`@getpaseo/*` SDK `0.10.0`.

Plugins use separate `index.client.tsx` and `index.server.ts` entries with strict `client/`,
`server/`, and `shared/` boundaries. See Paseo's [plugin guide](https://paseo.sh/docs/plugins.md)
when contributing changes.

## Plugins in this repository

- [Colorful agent activity](./colorful-agent-activity/README.md)
- [Skill picker](./skill-picker/README.md)
- [Super tasks](./super-tasks/README.md)
- [OpenCodeReview](./ocr/README.md)
- [Plexus service tier](./plexus-service-tier/README.md)
- [Superpi](./superpi/README.md): Pi subprocess provider with native child views,
  durable history, and Plexus-discovered context/service-tier controls.
  [Superpi companion](./superpi-companion/README.md) is its required Pi extension,
  not a separate Paseo plugin.

## Continuing development through SuperPi

Future work on Superpi will use SuperPi itself. Start with its
[development workflow](./superpi/README.md#developing-through-superpi) and
[current docs index](./superpi/docs/README.md). Use the isolated daemon for changes
that would reload or stop the provider running your development conversation.

## Reference index and community registry

- [Community reference index](./examples/README.md): Extensive index of public Paseo plugins organized by architectural technique (surfaces, panels, timeline transformers, composer pills, providers, lifecycle automation, telemetry, themes) with source and registry links.
- [paseo.cafe](https://paseo.cafe/): The community plugin directory and registry. Machine-readable endpoints:
  - Catalog: [`https://paseo.cafe/api/plugins`](https://paseo.cafe/api/plugins)
  - LLM index: [`https://paseo.cafe/llms.txt`](https://paseo.cafe/llms.txt)
  - Registry repo: [`paseo-cafe/paseo-cafe/tree/main/registry`](https://github.com/paseo-cafe/paseo-cafe/tree/main/registry)

