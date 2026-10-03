import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DialogEditorScreen } from "./client/dialog-editor";

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
  return () => { removeCommand(); removeScreen(); };
}
