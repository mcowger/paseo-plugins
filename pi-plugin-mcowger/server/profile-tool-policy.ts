import type { PaseoApi } from "@getpaseo/client";

import {
  createPiProfileMarkerMaintainer,
  type PiProfileConfig,
} from "./profile-markers.js";
import { discoverGlobalPiTools, type PiKnownTool } from "./tool-discovery.js";
import type {
  PiKnownToolSummary,
  PiProfileSummary,
} from "../shared/tool-policy.js";

export interface PiProfileToolPolicyHandlers {
  listProfiles(paseo: PaseoApi): Promise<{ profiles: PiProfileSummary[] }>;
  syncProfileMarkers(paseo: PaseoApi): Promise<{ profiles: PiProfileSummary[] }>;
  listKnownTools(): Promise<{ tools: PiKnownToolSummary[] }>;
}

function profileConfig(paseo: PaseoApi): PiProfileConfig {
  return {
    async get() {
      const result = await paseo.config.get();
      return {
        config: {
          agentProfiles: result.config.agentProfiles as unknown[] | undefined,
        },
      };
    },
    async patch(patch) {
      const result = await paseo.config.patch(
        { agentProfiles: patch.agentProfiles } as Parameters<typeof paseo.config.patch>[0],
      );
      return {
        config: {
          agentProfiles: result.config.agentProfiles as unknown[] | undefined,
        },
      };
    },
  };
}

function toKnownToolSummary(tool: PiKnownTool): PiKnownToolSummary {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    source: {
      kind: tool.source,
    },
    baselineActive: tool.baselineActive,
  };
}

export function createPiProfileToolPolicyHandlers(): PiProfileToolPolicyHandlers {
  const maintainer = createPiProfileMarkerMaintainer();

  return {
    async listProfiles(paseo) {
      return { profiles: await maintainer.listProfiles(profileConfig(paseo)) };
    },
    async syncProfileMarkers(paseo) {
      const result = await maintainer.syncMarkers(profileConfig(paseo));
      return { profiles: result.profiles };
    },
    async listKnownTools() {
      const tools = await discoverGlobalPiTools();
      return { tools: tools.map(toKnownToolSummary) };
    },
  };
}
