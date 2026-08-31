# Subagent activity

A Paseo `v0.7.0-beta.2` plugin that adds an agent panel for monitoring managed Paseo descendants.

The panel displays:

- active and archived managed child agents, including nested descendants;
- provider, model, lifecycle status, last activity, and provider-reported usage;
- the ten most recent tool calls for each managed child;
- best-effort provider-native subagent activity exposed by the parent timeline.

Provider-native activity is intentionally labeled separately because Paseo beta.2 does not expose a stable plugin-facing native-child registry. Native rows therefore do not claim model, token, or independent lifecycle data that the timeline does not provide.

## Development

The plugin targets exact Paseo package version `0.7.0-beta.2`.

```bash
npm install
npm run lint
npm run typecheck
npm test
```

After installing the plugin into Paseo, reload it with:

```bash
paseo plugin reload subagent-activity
```
