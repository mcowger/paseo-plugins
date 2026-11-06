import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ClaudeUsageSidebar, CodexUsageSidebar } from "./client/usage";

export default function contribute(client: PluginClientContext) {
  const removeClaude = client.addSidebarFooterItem({ id: "claude-usage", title: "Claude usage", Component: ClaudeUsageSidebar });
  const removeCodex = client.addSidebarFooterItem({ id: "codex-usage", title: "Codex usage", Component: CodexUsageSidebar });
  return () => { removeCodex(); removeClaude(); };
}
