import { z } from "zod";
import { MANIFEST_FILENAME } from "../shared/config";
import { ManifestSchema, type VirtualWorkspaceManifest } from "../shared/manifest";
import { joinSegments } from "./paths";
import type { FsPort } from "./ports";

export const INDEX_VERSION = 1;
export const INDEX_DIRNAME = "plugin-data/poly-repo-workspaces";
export const INDEX_FILENAME = "index.json";

export const IndexEntrySchema = z.object({
  rootPath: z.string().min(1),
  workspaceId: z.string().nullable(),
  uberProjectId: z.string().min(1),
  feature: z.string().min(1),
  branch: z.string().min(1),
  updatedAt: z.string(),
});

export type IndexEntry = z.infer<typeof IndexEntrySchema>;

export const IndexSchema = z.object({
  version: z.literal(INDEX_VERSION),
  virtual: z.record(z.string(), IndexEntrySchema),
});

export type WorkspaceIndex = z.infer<typeof IndexSchema>;

export function emptyIndex(): WorkspaceIndex {
  return { version: INDEX_VERSION, virtual: {} };
}

export function manifestPath(rootPath: string): string {
  return joinSegments(rootPath, MANIFEST_FILENAME);
}

export function indexPath(paseoHome: string): string {
  return joinSegments(joinSegments(paseoHome, INDEX_DIRNAME), INDEX_FILENAME);
}

export async function loadIndex(fs: FsPort, paseoHome: string): Promise<WorkspaceIndex> {
  const raw = await fs.readFile(indexPath(paseoHome));
  if (!raw) return emptyIndex();
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = IndexSchema.safeParse(parsed);
    if (!result.success) return emptyIndex();
    return result.data;
  } catch {
    return emptyIndex();
  }
}

export async function saveIndex(
  fs: FsPort,
  paseoHome: string,
  index: WorkspaceIndex,
): Promise<void> {
  await fs.writeFileAtomic(indexPath(paseoHome), JSON.stringify(index, null, 2));
}

export async function readManifest(
  fs: FsPort,
  rootPath: string,
): Promise<VirtualWorkspaceManifest | null> {
  const raw = await fs.readFile(manifestPath(rootPath));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = ManifestSchema.safeParse(parsed);
    if (!result.success) return null;
    return result.data;
  } catch {
    return null;
  }
}

export async function writeManifest(fs: FsPort, manifest: VirtualWorkspaceManifest): Promise<void> {
  await fs.writeFileAtomic(manifestPath(manifest.rootPath), JSON.stringify(manifest, null, 2));
}

export function createMutex(): () => Promise<() => void> {
  let tail: Promise<void> = Promise.resolve();
  return async () => {
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = tail;
    tail = previous.then(() => next);
    await previous;
    return release;
  };
}
