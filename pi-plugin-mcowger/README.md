# Pi JSON-RPC provider

Run [Pi](https://github.com/earendil-works/pi) in Paseo through one isolated `pi --mode rpc` process per agent session.

![Pi provider controls](./images/pi-provider.svg)

## What it does

- Lists Pi models with only the thinking levels each model supports.
- Streams messages, reasoning, tools, compaction, retries, and usage into Paseo.
- Persists native Pi sessions and supports conversation rewind.
- Bridges Pi extension questions to Paseo permissions.
- Applies session system prompts, environment overrides, and injected MCP servers.
- Exposes `/compact` plus composer controls for automatic compaction and retry.
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

## Limitations

- Requires a Pi CLI build with `--mode rpc` support.
- Imported session listing is not implemented yet.
- Rewind changes Pi conversation history only. It does not revert workspace files.
- Plugin-provider settings have generic composer glyphs in Paseo 0.8. The Compact and Retry selectors still render inside the composer with their current state.

## Development

```sh
npm run lint
npm run typecheck
npm test
```
