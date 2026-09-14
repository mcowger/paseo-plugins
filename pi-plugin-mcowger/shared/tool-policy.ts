import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PI_PROVIDER_ID = "pi-plugin-mcowger";
export const PI_TOOL_POLICY_SETTINGS_ID = "pi-tool-policy";
export const PI_TOOL_POLICY_PROFILE_ID_SETTING = "pi-tool-policy-profile-id";

const MAX_POLICY_PATTERNS = 256;
const MAX_POLICY_TOOL_NAMES = 512;
const MAX_PROFILE_POLICIES = 128;
export const MAX_PROFILE_ID_LENGTH = 160;
export const MAX_PROFILE_NAME_LENGTH = 160;
export const MAX_PROFILE_NOTES_LENGTH = 4_000;
const MAX_TOOL_DESCRIPTION_LENGTH = 4_000;
const MAX_PROFILE_SUMMARIES = 256;
const MAX_KNOWN_TOOL_SUMMARIES = 1_024;

const policyPattern = z.string().trim().min(1).max(MAX_PROFILE_ID_LENGTH);
const canonicalToolId = z.string().trim().min(1).max(MAX_PROFILE_ID_LENGTH);
const profileId = z.string().trim().min(1).max(MAX_PROFILE_ID_LENGTH);
const profileName = z.string().trim().min(1).max(MAX_PROFILE_NAME_LENGTH);

function normalizedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedStringList(item: z.ZodType<string>, max: number) {
  return z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter((entry) => typeof entry !== "string" || entry.trim().length > 0)
        : value,
    z.array(item).max(max).transform(normalizedUniqueStrings),
  );
}

const normalizedPatternList = normalizedStringList(policyPattern, MAX_POLICY_PATTERNS);
const normalizedToolIdList = normalizedStringList(canonicalToolId, MAX_POLICY_TOOL_NAMES);

export const piToolPolicySchema = z.object({
  mode: z.enum(["inherit", "allowlist"]),
  allowedPatterns: normalizedPatternList.default([]),
  blockedPatterns: normalizedPatternList.default([]),
});

export const paseoHostToolPolicySchema = z.object({
  enabled: z.boolean().default(true),
  disabledTools: normalizedToolIdList.default([]),
});

export const profileToolPolicySchema = z.object({
  profileId,
  allowedPiToolNames: normalizedToolIdList.default([]),
  allowedPaseoToolNames: normalizedToolIdList.default([]),
  allowedExternalMcpPatterns: normalizedPatternList.default([]),
});

const profilePolicyList = z
  .array(profileToolPolicySchema)
  .max(MAX_PROFILE_POLICIES)
  .superRefine((policies, context) => {
    const seen = new Set<string>();
    for (const [index, policy] of policies.entries()) {
      if (seen.has(policy.profileId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate profile policy: ${policy.profileId}`,
          path: [index, "profileId"],
        });
      }
      seen.add(policy.profileId);
    }
  });

export const piToolPolicySettingsSchema = z.object({
  piTools: piToolPolicySchema.default({ mode: "inherit", allowedPatterns: [], blockedPatterns: [] }),
  paseoTools: paseoHostToolPolicySchema.default({ enabled: true, disabledTools: [] }),
  profilePolicies: profilePolicyList.default([]),
});

export const piToolPolicySettings = defineSettings({
  id: PI_TOOL_POLICY_SETTINGS_ID,
  scope: "host",
  version: 2,
  schema: piToolPolicySettingsSchema,
  migrate(values, fromVersion) {
    if (fromVersion !== 1 || typeof values !== "object" || values === null || Array.isArray(values)) {
      return values;
    }
    return { ...values, profilePolicies: [] };
  },
});

export const getPiToolPolicyRevisionRpc = defineRpc({
  name: "pi-tool-policy.revision",
  input: z.object({}).strict(),
  output: z.object({ revision: z.string().nullable() }).strict(),
});

export const syncPiToolPolicyRpc = defineRpc({
  name: "pi-tool-policy.sync",
  input: z.object({
    revision: z.string(),
    previousRevision: z.string().nullable(),
    values: piToolPolicySettings.schema,
  }).strict(),
  output: z.object({ revision: z.string() }).strict(),
});

export const piProfileSummarySchema = z.object({
  id: profileId,
  name: profileName,
  model: z.string().trim().min(1).max(MAX_PROFILE_ID_LENGTH).optional(),
  modeId: z.string().trim().min(1).max(MAX_PROFILE_ID_LENGTH).optional(),
  thinkingOptionId: z.string().trim().min(1).max(MAX_PROFILE_ID_LENGTH).optional(),
  notes: z.string().trim().max(MAX_PROFILE_NOTES_LENGTH).optional(),
}).strict();

const piProfileSummariesSchema = z.array(piProfileSummarySchema).max(MAX_PROFILE_SUMMARIES);

export const getPiToolPolicyProfilesRpc = defineRpc({
  name: "pi-tool-policy.profiles",
  input: z.object({}).strict(),
  output: z.object({ profiles: piProfileSummariesSchema }).strict(),
});

export const syncPiToolPolicyProfileMarkersRpc = defineRpc({
  name: "pi-tool-policy.sync-profile-markers",
  input: z.object({}).strict(),
  output: z.object({ profiles: piProfileSummariesSchema }).strict(),
});

export const piKnownToolSourceSchema = z.object({
  kind: z.enum(["builtin", "extension", "fallback"]),
  label: z.string().trim().min(1).max(MAX_PROFILE_NAME_LENGTH).optional(),
}).strict();

export const piKnownToolSummarySchema = z.object({
  name: canonicalToolId,
  description: z.string().trim().min(1).max(MAX_TOOL_DESCRIPTION_LENGTH).optional(),
  source: piKnownToolSourceSchema.optional(),
  baselineActive: z.boolean(),
}).strict();

export const getPiToolPolicyKnownToolsRpc = defineRpc({
  name: "pi-tool-policy.known-tools",
  input: z.object({}).strict(),
  output: z.object({ tools: z.array(piKnownToolSummarySchema).max(MAX_KNOWN_TOOL_SUMMARIES) }).strict(),
});

export type PiToolPolicy = z.output<typeof piToolPolicySchema>;
export type PaseoHostToolPolicy = z.output<typeof paseoHostToolPolicySchema>;
export type ProfileToolPolicy = z.output<typeof profileToolPolicySchema>;
export type PiToolPolicySettings = z.output<typeof piToolPolicySettings.schema>;
export type PiProfileSummary = z.output<typeof piProfileSummarySchema>;
export type PiKnownToolSource = z.output<typeof piKnownToolSourceSchema>;
export type PiKnownToolSummary = z.output<typeof piKnownToolSummarySchema>;

export const DEFAULT_PI_TOOL_POLICY_SETTINGS: PiToolPolicySettings = {
  piTools: { mode: "inherit", allowedPatterns: [], blockedPatterns: [] },
  paseoTools: { enabled: true, disabledTools: [] },
  profilePolicies: [],
};
