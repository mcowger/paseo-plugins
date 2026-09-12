# Scratch Chat

Scratch Chat adds a **Chat** button to the Paseo sidebar and a **New temporary chat** action to the Command Center.

Each chat gets an empty temporary directory and a regular Paseo workspace. The native agent screen opens after creation, so the chat works like any other Paseo agent without using a project checkout.

Use the **Discard** composer action or the **Discard scratch chat** Command Center action when you're done. It archives the agent and workspace and removes the temporary directory. Scratch Chat also cleans up tracked chats when it stops.

## Install

```bash
cd /absolute/path/to/scratch-chat
npm install
paseo plugin install "$PWD"
paseo plugin reload scratch-chat
```

The plugin selects the first available provider model from Paseo's provider catalog. If no provider model is available, it shows an error instead of creating a workspace.

## Development

```bash
npm run lint
npm run typecheck
npm test
```
