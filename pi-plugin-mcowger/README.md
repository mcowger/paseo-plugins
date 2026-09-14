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
- Recognizes [`pi-gpt-fast-mode`](https://github.com/mcowger/pi-gpt-fast-mode) and adds a Fast composer control for supported models.
- Recognizes [`pi-openai-long-context`](https://github.com/johnhenaot/pi-openai-long-context) and adds a Long context composer control when its status protocol is available.
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

The provider probes for the extension and its supported model before showing the Fast control. If the extension is not installed, or the current model is unsupported, the control stays hidden.

### Long context

Install [`pi-openai-long-context`](https://github.com/johnhenaot/pi-openai-long-context) in the same Pi profile used by the Paseo daemon. The provider probes `/long-context` and `/long-context-status`, then refreshes Pi's effective model and usage state after toggling. The control stays hidden when the extension is absent or reports the current model as unsupported.

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
