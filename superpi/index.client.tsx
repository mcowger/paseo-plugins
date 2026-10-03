import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DialogEditorScreen } from "./client/dialog-editor";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { resumeCommandRpc } from "./shared/resume";

export default function contribute(client: PluginClientContext): () => void {
  const removeScreen = client.addSettingsScreen({
    id: "superpi-dialogs",
    title: "Pi dialogs",
    icon: "MessageSquare",
    Component: DialogEditorScreen,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "dialogs",
    title: "Pi dialogs",
    icon: "MessageSquare",
    context: "global",
    onSelect({ openSettings }) { openSettings("superpi-dialogs"); },
  });
  const removeResume = client.addCommandCenterItem({
    id: "copy-resume-command",
    title: "Superpi: Copy Pi resume command (stop session first)",
    icon: "Copy",
    context: "agent",
    keywords: ["resume", "terminal", "pi"],
    async onSelect({ agent, rpc }) {
      const { command } = await rpc(resumeCommandRpc, { agentId: agent.id });
      await copyText(command);
    },
  });
  return () => { removeResume(); removeCommand(); removeScreen(); };
}
