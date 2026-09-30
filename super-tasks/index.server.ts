import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelWorkspaceAgent,
  getProviderSubagentTimeline,
  listWorkspaceProviderSubagents,
} from "./shared/agents/control";
import {
  cancelAgentTurn,
  fetchProviderSubagentTimelineHandler,
  listProviderSubagentsForParents,
} from "./server/agents/control";

export default function contribute(server: PluginServerContext) {
  server.handle(cancelWorkspaceAgent, cancelAgentTurn);
  server.handle(listWorkspaceProviderSubagents, listProviderSubagentsForParents);
  server.handle(getProviderSubagentTimeline, fetchProviderSubagentTimelineHandler);

  return () => {};
}
