# Colorful agent activity

A Paseo 0.8 plugin that replaces public agent reasoning and tool-call rows with colorful,
icon-led timeline cards.

## What it renders

- Reasoning with a Sparkles icon, paced streaming text, Markdown headings, inline bold/italic/code, ordered and unordered lists, blockquotes, fenced code blocks, and expand/collapse behavior.
- Shell commands and output with Shiki token highlighting.
- File reads, writes, and edits with extension-aware file icons.
- Edit line counts such as `+8 / -0` and colored diff rows.
- Search, fetch, worktree, sub-agent, plan, plain-text, and unknown tool details.
- Running, completed, failed, and canceled status icons.

The newest thinking block stays open until a newer thinking block starts, even while tool calls run. Tool calls remain open while streaming; completed tool calls start collapsed and can be expanded.

## Palette modes

The **Colorful activity** settings screen offers:

- **Vivid** — stronger category colors and tinted surfaces.
- **Soft** — quieter accents and backgrounds.
- **High contrast** — stronger borders and status colors.

Palette colors come from the active Paseo theme. Shiki uses a matching light or dark token theme
and falls back to plain monospace text when a language or output is too large to highlight.

## Install

```bash
cd /absolute/path/to/colorful-agent-activity
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"
paseo plugin disable reasoning-display
paseo plugin reload colorful-agent-activity
```

Disable `reasoning-display` while this plugin is enabled. Paseo gives the first matching timeline
transformer ownership of a source row.

## Limitations

- The plugin sees public agent tool calls, not internal orchestrator calls.
- Set Paseo's Tool call detail setting to Detailed. In Overview mode, Paseo groups consecutive calls before plugin transforms run, so the plugin cannot recover the individual rows.
- Native Paseo detail and syntax components are private, so this plugin renders its own details.
- Shiki runs through its JavaScript regex engine in the plugin bundle. It is not a terminal emulator,
  and unsupported or oversized output falls back to plain text.
- Unknown provider payloads use a generic JSON fallback.

## Development

```bash
npm run lint
npm run typecheck
npm test
```
