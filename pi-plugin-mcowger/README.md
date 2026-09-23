# Pi JSON-RPC provider

Run [Pi](https://github.com/earendil-works/pi) in Paseo through one isolated `pi --mode rpc` process per agent session.

![Pi provider controls](./images/pi-provider.svg)

## What it does

- Lists Pi models with only the thinking levels each model supports.
- Streams messages, reasoning, tools, compaction, retries, and usage into Paseo.
- Persists native Pi sessions and supports conversation rewind.
- Bridges Pi extension questions to Paseo permissions.
- Applies session system prompts, environment overrides, and injected MCP servers.
- Exposes `/compact` plus a Pi composer pill for automatic compaction, retry, Fast mode, Long context, and future runtime controls.
- Probes only [`@mcowger/pi-microgpt`](https://github.com/mcowger/pi-plugins/tree/main/packages/pi-microgpt). It adds Fast mode, Long context, and native Codex `apply_patch` for supported models.
- Stops each Pi process and removes its temporary files when Paseo closes or reloads the provider.

## Installation

Pi must be installed and available as `pi` on the daemon host. Set `PI_COMMAND` if the executable has a different name or path.

```sh
paseo plugin add mcowger/paseo-plugins:pi-plugin-mcowger
```

For a local checkout:

```sh
cd /absolute/path/to/pi-plugin-mcowger
npm install --legacy-peer-deps
npm run lint
npm run typecheck
npm test
paseo plugin add "$PWD"
```

### pi-microgpt

Install `@mcowger/pi-microgpt` in the same Pi profile used by the Paseo daemon using any supported Pi package source, including a local path, npm, or git.

The provider verifies pi-microgpt's JSON response before showing Fast or Long context in the Pi settings pill. Unsupported models keep both controls hidden. Native `apply_patch` calls appear as edits.

## Limitations

- Requires a Pi CLI build with `--mode rpc` support.
- Imported session listing is not implemented yet.
- Rewind changes Pi conversation history only. It does not revert workspace files.
- Pi runtime settings apply only to the active session. New sessions use their configured defaults.

## Development

```sh
npm run lint
npm run typecheck
npm test
```
