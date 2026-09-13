import type { PluginClientContext } from "@getpaseo/plugin/client";

import { PiToolPolicySettings } from "./client/tool-policy-settings.js";

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: "tool-policy",
    title: "Pi Tool Policy",
    icon: "ShieldCheck",
    Component: PiToolPolicySettings,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "configure-tool-policy",
    title: "Configure Pi tool policy",
    icon: "ShieldCheck",
    context: "global",
    keywords: ["pi", "tools", "policy", "settings"],
    onSelect: (context) => context.openSettings("tool-policy"),
  });
  return () => {
    removeSettings();
    removeCommand();
  };
}
