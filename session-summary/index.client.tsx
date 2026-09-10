import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { SessionSummaryPanel } from "./client/session-summary-panel";

const PANEL_ID = "session-summary";
const AGENT_PAGE_SIZE = 200;
const AGENT_SUBSCRIPTION_ID = "session-summary-agents";

type ComposerAgent = {
  readonly id: string;
  readonly workspaceId?: string | null;
  readonly archivedAt?: string | null;
};

async function listAgents(client: PluginClientContext): Promise<ComposerAgent[]> {
  const agents: ComposerAgent[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.paseo.agents.list({
      filter: { includeArchived: false },
      page: { limit: AGENT_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      ...(cursor ? {} : { subscribe: { subscriptionId: AGENT_SUBSCRIPTION_ID } }),
    });
    agents.push(...response.entries.map(({ agent }) => agent));
    cursor = response.pageInfo.hasMore ? (response.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return agents;
}

export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  const workspaceIds = new Map<string, string>();
  let stopped = false;

  const removePill = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    workspaceIds.delete(agentId);
  };
  const registerPill = (agent: ComposerAgent) => {
    if (stopped || !agent.workspaceId || agent.archivedAt) {
      removePill(agent.id);
      return;
    }
    if (workspaceIds.get(agent.id) === agent.workspaceId) return;

    removePill(agent.id);
    const workspaceId = agent.workspaceId;
    workspaceIds.set(agent.id, workspaceId);
    pills.set(
      agent.id,
      client.addComposerPill({
        id: PANEL_ID,
        workspaceId,
        agentId: agent.id,
        button: {
          title: "Open session summary",
          icon: "LayoutDashboard",
          label: "Summary",
          behavior: {
            kind: "action",
            onPress() {
              client.openPanel(PANEL_ID, { workspaceId, agentId: agent.id });
            },
          },
        },
      }),
    );
  };

  const removePanel = client.addWorkspacePanel({
    id: PANEL_ID,
    title: "Summary",
    icon: "LayoutDashboard",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: SessionSummaryPanel,
  });
  const removeSlashCommand = client.addSlashCommand({
    name: "summary",
    description: "Open the agent session summary",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel(PANEL_ID);
    },
  });
  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") removePill(update.agentId);
    else registerPill(update.agent);
  });

  void listAgents(client)
    .then((agents) => {
      if (!stopped) agents.forEach(registerPill);
    })
    .catch(() => undefined);

  return () => {
    stopped = true;
    unsubscribeAgents();
    removeSlashCommand();
    removePanel();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    workspaceIds.clear();
  };
}
