# Pi JSON-RPC provider

Run [Pi](https://github.com/earendil-works/pi) in Paseo through one isolated `pi --mode rpc` process per agent session.

![Pi provider controls](./images/pi-provider.svg)

## What it does

- Lists Pi models with only the thinking levels each model supports.
- Streams messages, reasoning, tools, compaction, retries, and usage into Paseo.
- Persists native Pi sessions and supports conversation rewind.
- Bridges Pi extension questions to Paseo permissions.
- Applies session system prompts, environment overrides, and injected MCP servers.
- Exposes `/compact` plus a Pi composer pill for automatic compaction, retry, Fast mode, and future runtime controls.
- Recognizes [`pi-gpt-fast-mode`](https://github.com/mcowger/pi-gpt-fast-mode) and includes Fast in that pill for supported models.
- Recognizes [`pi-openai-long-context`](https://github.com/johnhenaot/pi-openai-long-context) and includes Long context only for supported models.
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

### Fast mode

Install [`pi-gpt-fast-mode`](https://github.com/mcowger/pi-gpt-fast-mode) in the same Pi profile used by the Paseo daemon:

```sh
pi install git:github.com/mcowger/pi-gpt-fast-mode
```

The provider probes for the extension and its supported model before showing Fast in the Pi settings pill. If the extension is not installed, or the current model is unsupported, the control stays hidden.

### Long context

Install [`pi-openai-long-context`](https://github.com/johnhenaot/pi-openai-long-context) in the Pi profile used by Paseo. The pill hides Long context unless the extension reports the active model as supported.

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
