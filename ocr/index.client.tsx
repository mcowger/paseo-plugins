import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ReviewPanel } from "./client/review-panel";
import { OcrSettings } from "./client/settings";
import { searchSelectionsRpc } from "./shared/contracts.js";

export const REVIEW_PANEL_ID = "open-code-review";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: REVIEW_PANEL_ID,
    title: "OpenCodeReview",
    icon: "SearchCheck",
    locations: ["explorer"],
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
  // Command palette entries: the only panel opener reachable on mobile,
  // where the new-tab launcher has no touch entry point.
  const removeWorkspaceCommand = client.addCommandCenterItem({
    id: "open-review-panel",
    title: "Open OpenCodeReview",
    icon: "SearchCheck",
    keywords: ["ocr", "review", "findings", "panel"],
    context: "workspace",
    onSelect: (context) => {
      context.openPanel(REVIEW_PANEL_ID);
    },
  });
  const removeAgentCommand = client.addCommandCenterItem({
    id: "open-review-panel-agent",
    title: "Open OpenCodeReview",
    icon: "SearchCheck",
    keywords: ["ocr", "review", "findings", "panel"],
    context: "agent",
    onSelect: (context) => {
      context.openPanel(REVIEW_PANEL_ID);
    },
  });
  // Composer slash command: second opener route via the agent composer.
  // Slash command names are host-unique regardless of context, so only one
  // registration is allowed. Workspace context works in both workspace and
  // agent composers (the host only needs the workspace to resolve).
  // Note: slash commands do not run while the composer has attachments;
  // the command palette entries above cover that case.
  const removeSlash = client.addSlashCommand({
    name: "ocr",
    description: "Open the OpenCodeReview panel",
    argumentHint: "",
    context: "workspace",
    onSubmit: (context) => {
      context.openPanel(REVIEW_PANEL_ID);
    },
  });
  return () => {
    removePanel();
    removeAttachments();
    removeSettings();
    removeWorkspaceCommand();
    removeAgentCommand();
    removeSlash();
  };
}
