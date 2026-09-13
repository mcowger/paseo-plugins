import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PI_PROVIDER_ID = "pi-plugin-mcowger";
export const PI_TOOL_POLICY_SETTINGS_ID = "pi-tool-policy";

const policyPattern = z.string().trim().min(1).max(160);
const canonicalToolId = z.string().trim().min(1).max(160);

function normalizedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

const normalizedPatternList = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter((item) => typeof item !== "string" || item.trim().length > 0)
      : value,
  z.array(policyPattern).max(256).transform(normalizedUniqueStrings),
);
const normalizedToolIdList = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter((item) => typeof item !== "string" || item.trim().length > 0)
      : value,
  z.array(canonicalToolId).max(512).transform(normalizedUniqueStrings),
);

export const piToolPolicySchema = z.object({
  mode: z.enum(["inherit", "allowlist"]),
  allowedPatterns: normalizedPatternList.default([]),
  blockedPatterns: normalizedPatternList.default([]),
});

export const paseoHostToolPolicySchema = z.object({
  enabled: z.boolean().default(true),
  disabledTools: normalizedToolIdList.default([]),
});

export const piToolPolicySettings = defineSettings({
  id: PI_TOOL_POLICY_SETTINGS_ID,
  scope: "host",
  version: 1,
  schema: z.object({
    piTools: piToolPolicySchema.default({ mode: "inherit", allowedPatterns: [], blockedPatterns: [] }),
    paseoTools: paseoHostToolPolicySchema.default({ enabled: true, disabledTools: [] }),
  }),
});

export const getPiToolPolicyRevisionRpc = defineRpc({
  name: "pi-tool-policy.revision",
  input: z.object({}),
  output: z.object({ revision: z.string().nullable() }),
});

export const syncPiToolPolicyRpc = defineRpc({
  name: "pi-tool-policy.sync",
  input: z.object({
    revision: z.string(),
    previousRevision: z.string().nullable(),
    values: piToolPolicySettings.schema,
  }),
  output: z.object({ revision: z.string() }),
});

export type PiToolPolicy = z.output<typeof piToolPolicySchema>;
export type PaseoHostToolPolicy = z.output<typeof paseoHostToolPolicySchema>;
export type PiToolPolicySettings = z.output<typeof piToolPolicySettings.schema>;

export const DEFAULT_PI_TOOL_POLICY_SETTINGS: PiToolPolicySettings = {
  piTools: { mode: "inherit", allowedPatterns: [], blockedPatterns: [] },
  paseoTools: { enabled: true, disabledTools: [] },
};
