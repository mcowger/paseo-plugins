# OpenCode session overview

This read-only Paseo plugin adds an agent-scoped panel for OpenCode agents. It uses the public
Paseo `0.7.0-beta.2` agent SDK to resolve the native OpenCode session ID, current usage, context
window, tasks, loaded skills/commands, workspace metadata, and observed subagents.

The panel does not connect directly to OpenCode, start a server, or expose provider credentials.
It uses Paseo's normalized agent and timeline APIs, so it follows the OpenCode process and session
lifecycle already managed by Paseo.

```bash
cd /absolute/path/to/opencode-session-overview
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"
paseo plugin reload opencode-session-overview
```

Usage and context costs are based on the latest usage snapshot provided by Paseo. They are not
presented as lifetime billing totals when the provider has not supplied those values.
