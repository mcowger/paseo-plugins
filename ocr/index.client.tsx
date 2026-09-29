import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ReviewPanel } from "./client/review-panel";
import { OcrSettings } from "./client/settings";
import { searchSelectionsRpc } from "./shared/contracts.js";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: "open-code-review",
    title: "OpenCodeReview",
    icon: "SearchCheck",
    locations: ["workspace", "explorer"],
    context: "workspace",
    Component: ReviewPanel,
  });
  const removeAttachments = client.addAttachmentSource({
    id: "selections",
    title: "OpenCodeReview selections",
    icon: "ListChecks",
    pickerTitle: "Attach OpenCodeReview findings",
    searchPlaceholder: "Search workspace, session, or file",
    search: searchSelectionsRpc,
  });
  const removeSettings = client.addSettingsScreen({
    id: "preferences",
    title: "OpenCodeReview",
    icon: "Settings2",
    Component: OcrSettings,
  });
  return () => {
    removePanel();
    removeAttachments();
    removeSettings();
  };
}
