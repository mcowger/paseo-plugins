# Claude and Codex Enterprise usage

One Paseo plugin adds separate sidebar meters for Claude and Codex usage. Each meter opens details for that provider, including reported spend, limits, feature windows, reset times and refresh status. Spend-only Enterprise accounts do not need a session or weekly window to be displayed.

## Install

```sh
paseo plugin install /path/to/paseo-plugins/enterprise-usage
```

The plugin runs on the Paseo daemon host. Install OMP and sign in to Anthropic and OpenAI Codex in OMP on that host. The `omp` executable must be on the daemon's PATH. The Codex meter can display used or remaining usage. Paseo 0.12.0 or later is required.

## Data and privacy

The server obtains access tokens with `omp token`, using the first OMP OAuth account for each provider and the daemon's OMP profile. OMP handles credential refresh and coordinates it with other OMP processes. The plugin sends the Anthropic token to Anthropic's usage endpoint, and the Codex token and account ID to ChatGPT's usage endpoint. Credentials stay on the daemon and are never returned to the client. Sign in again in OMP if credential retrieval fails.

These usage endpoints can change independently of the plugin. Available budgets and windows depend on the account and organization; missing values are not treated as zero. Claude's spend meter supports USD. Claude automatic reads are cached for two minutes with a 30-second manual-refresh minimum; Codex uses a one-minute cache and a 10-second manual-refresh minimum. Provider rate limits apply; failures preserve the last successful reading with a stale indicator.

Balances are individual account usage allowances, not organization-wide billing totals. API-key, Bedrock and Vertex billing are not supported.
