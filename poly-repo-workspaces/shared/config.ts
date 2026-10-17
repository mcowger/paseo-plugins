import { z } from "zod";

export const PLUGIN_ID = "poly-repo-workspaces";
export const MANIFEST_FILENAME = ".polyrepo.json";
export const DEFAULT_BASE_DIRNAME = "poly-workspaces";

export const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "lowercase letters, numbers, and hyphens, starting with a letter");

export const RepoConfigSchema = z.object({
  id: IdSchema,
  sourcePath: z.string().min(1),
  dirTemplate: z.string().min(1).default("{repo}_{branch}"),
  baseBranch: z.string().min(1).optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const UberProjectSchema = z.object({
  id: IdSchema,
  displayName: z.string().min(1).max(120),
  virtualRootBase: z.string().min(1).optional(),
  branchTemplate: z.string().min(1).default("{feature}"),
  rootDirTemplate: z.string().min(1).default("{uberProject}-{feature}"),
  agentsTemplatePath: z.string().min(1),
  repos: z.array(RepoConfigSchema).min(1).max(32),
});

export type UberProject = z.infer<typeof UberProjectSchema>;

export const PluginSettingsSchema = z.object({
  virtualRootBase: z.string().min(1).optional(),
  uberProjects: z.array(UberProjectSchema).default([]),
});

export type PluginSettings = z.infer<typeof PluginSettingsSchema>;

const RESERVED_SEGMENTS = new Set([".", ".."]);

export function validateFeatureName(feature: string): string | null {
  if (feature.length === 0 || feature.length > 128) {
    return "feature name must be 1-128 characters";
  }
  if (
    /[\s~^:?*@{}]/.test(feature) ||
    feature.includes("[") ||
    feature.includes("]") ||
    feature.includes("\\")
  ) {
    return "feature name contains characters git forbids in branch names";
  }
  if (feature.includes("..") || feature.includes("//")) {
    return "feature name must not contain .. or //";
  }
  if (feature.startsWith("/") || feature.endsWith("/") || feature.endsWith(".lock")) {
    return "feature name must not start with /, end with /, or end with .lock";
  }
  for (const segment of feature.split("/")) {
    if (RESERVED_SEGMENTS.has(segment) || segment.endsWith(".lock")) {
      return `feature name has a reserved path segment: ${segment}`;
    }
  }
  return null;
}
