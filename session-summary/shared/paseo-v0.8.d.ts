import type {
  PluginAgentCommandContext,
  PluginAgentPanelProps,
  PluginCleanup,
} from "@getpaseo/plugin";
import type { ComponentType } from "react";

type V08AgentPanelContribution = {
  id: string;
  title: string;
  icon: string;
  context: "agent";
  locations?: readonly ("workspace" | "explorer")[];
  Component: ComponentType<PluginAgentPanelProps>;
};

type V08AgentSlashCommand = {
  name: string;
  description: string;
  argumentHint: string;
  context: "agent";
  onSubmit(context: PluginAgentCommandContext & { args: string }): void | Promise<void>;
};

declare module "@getpaseo/plugin" {
  interface PluginClientContext {
    addWorkspacePanel(contribution: V08AgentPanelContribution): PluginCleanup;
    addSlashCommand(contribution: V08AgentSlashCommand): PluginCleanup;
  }
}
