# Pi JSON-RPC provider

This plugin runs each Pi session in its own `pi --mode rpc` subprocess.

It intentionally does not load Pi as a module. A child crash rejects its pending RPCs and fails the active turn without affecting another session's Pi state or deleting its persistence handle.

## What it supports

- Model catalog and thinking-level selection.
- Streaming text, reasoning, tool calls, compaction, retry notices, and usage.
- Native Pi session persistence and conversation rewind.
- Pi extension prompts through Paseo permissions.
- Per-session system prompts, environment overrides, and native MCP config files.
- Steer, interrupt (`clear_queue` then `abort`), and deterministic child cleanup.

## Development

```sh
cd pi-plugin-mcowger
npm install --legacy-peer-deps
npm run lint
npm run typecheck
npm test
```

Reload it explicitly after changes:

```sh
paseo plugin reload pi-plugin-mcowger
```
