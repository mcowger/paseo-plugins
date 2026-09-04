import type { ComponentType, ReactNode } from "react";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type {
  PluginAttachmentSourceContribution,
  PluginCleanup,
  PluginCommandCapabilities,
  PluginCommandCenterItemContribution,
  PluginHandlerContext,
  PluginIconProps,
  PluginRpcContract,
  PluginSidebarContribution,
  PluginSurfaceProps,
  PluginThemeContribution,
  PluginTimelineRendererContribution,
  PluginTimelineTransformerContribution,
  PluginWorkspacePanelContribution,
} from "@getpaseo/plugin";

declare module "@getpaseo/plugin" {
  export interface PluginClientSlashCommandContribution {
    name: string;
    description: string;
    argumentHint: string;
    context: "workspace" | "agent";
    onSubmit(context: any): void | Promise<void>;
  }

  export interface PluginClientContext extends PluginCommandCapabilities {
    addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): PluginCleanup;
    addSidebarItem(contribution: PluginSidebarContribution): PluginCleanup;
    addWorkspacePanel(contribution: PluginWorkspacePanelContribution): PluginCleanup;
    addCommandCenterItem(contribution: PluginCommandCenterItemContribution): PluginCleanup;
    addSlashCommand(contribution: PluginClientSlashCommandContribution): PluginCleanup;
    addComposerPill(contribution: PluginComposerPillContribution): PluginCleanup;
    addAttachmentSource(contribution: PluginAttachmentSourceContribution): PluginCleanup;
    addTheme(contribution: PluginThemeContribution): PluginCleanup;
    addTimelineTransformer<ItemType extends AgentTimelineItem["type"]>(
      contribution: PluginTimelineTransformerContribution<ItemType>,
    ): PluginCleanup;
    addTimelineRenderer<Schema extends ZodType>(
      contribution: PluginTimelineRendererContribution<Schema>,
    ): PluginCleanup;
    openPanel(id: string, options: PluginClientOpenPanelOptions): void;
  }

  export interface PluginServerContext {
    handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      handler: (
        input: ZodOutput<InputSchema>,
        context: PluginHandlerContext,
      ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
    ): void;
    registerProvider(provider: unknown): void;
  }

  export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;

  export function defineRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    definition: { name: string; input: InputSchema; output: OutputSchema },
  ): PluginRpcContract<InputSchema, OutputSchema>;
  export type RpcInput<Contract extends PluginRpcContract> = ZodOutput<Contract["input"]>;
  export type RpcOutput<Contract extends PluginRpcContract> = ZodInput<Contract["output"]>;
}

declare module "@getpaseo/plugin/react-native" {
  export const Icon: ComponentType<PluginIconProps>;
  export const Modal: ComponentType<{
    title: string;
    icon?: ReactNode;
    open: boolean;
    onOpenChange(open: boolean): void;
    children: ReactNode;
  }> & {
    Content: ComponentType<{ children: ReactNode }>;
  };
  export function useToast(): {
    show(message: string, options?: { variant?: string; durationMs?: number }): void;
    error(message: string): void;
  };
  export function useRevealedText(text: string, phase: "streaming" | "complete"): string;
}
