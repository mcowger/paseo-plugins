import type { PluginButtonRegistration } from "@getpaseo/plugin/client";
import type { ServiceTier } from "../shared/service-tier";

/** Per-agent pill state shared between registration and the popover content. */
export interface AgentServiceTierState {
  /** Last tier selected from this client; pi keeps its own per-session state. */
  tier: ServiceTier;
  provider: string;
  model: string | null;
  registration: PluginButtonRegistration;
}

export const agentTierState = new Map<string, AgentServiceTierState>();
