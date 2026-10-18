import type { PluginClientContext } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { DialogEditorScreen } from "./client/dialog-editor";
import { ModelNameSettings } from "./client/model-names";
import { resumeCommandRpc } from "./shared/resume";

export default function contribute(client: PluginClientContext): () => void {
  const removeScreen = client.addSettingsScreen({
    id: "plexuspi-dialogs",
    title: "Pi dialogs",
    icon: "MessageSquare",
    Component: DialogEditorScreen,
  });
  const removeModelNames = client.addSettingsScreen({
    id: "plexuspi-model-names",
    title: "PlexusPi model names",
    icon: "Tag",
    Component: ModelNameSettings,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "dialogs",
    title: "Pi dialogs",
    icon: "MessageSquare",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("plexuspi-dialogs");
    },
  });
  const removeResume = client.addCommandCenterItem({
    id: "copy-resume-command",
    title: "PlexusPi: Copy Pi resume command (stop session first)",
    icon: "Copy",
    context: "agent",
    keywords: ["resume", "terminal", "pi"],
    async onSelect({ agent, rpc }) {
      const { command } = await rpc(resumeCommandRpc, { agentId: agent.id });
      await copyText(command);
    },
  });
  return () => {
    removeResume();
    removeCommand();
    removeModelNames();
    removeScreen();
  };
}
