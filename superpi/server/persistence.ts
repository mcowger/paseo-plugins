import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { ProviderPersistence } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import lockfile from "proper-lockfile";

const manifestSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  cwd: z.string(),
  nativeSessionId: z.string().optional(),
  nativeSessionFile: z.string().optional(),
  interrupted: z.boolean().default(false),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
const handleSchema = z.object({ id: z.string().uuid() }).strict();
const MAX_METADATA_BYTES = 64 * 1024;

async function readJson(file: string): Promise<unknown> {
  const handle = await fs.open(file, "r");
  try {
    if ((await handle.stat()).size > MAX_METADATA_BYTES) throw new Error("Session metadata exceeds its size limit");
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally { await handle.close(); }
}

export class SessionStore {
  private updates: Promise<void> = Promise.resolve();
  private releasePromise?: Promise<void>;
  private constructor(
    readonly directory: string,
    private manifest: Manifest,
    private readonly releaseLock: () => Promise<void>,
  ) {}

  static async open(root: string, cwd: string, persistence?: ProviderPersistence): Promise<SessionStore> {
    if (persistence && persistence.version !== 1) throw new Error("Unsupported Superpi persistence version");
    const id = persistence ? handleSchema.parse(persistence.data).id : randomUUID();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const realRoot = await fs.realpath(root);
    const directory = path.join(realRoot, id);
    if (!persistence) await fs.mkdir(directory, { mode: 0o700 });
    if (await fs.realpath(directory) !== directory) throw new Error("Session directory cannot be a symbolic link");
    const canonicalCwd = await fs.realpath(cwd);
    let releaseLock: () => Promise<void>;
    try { releaseLock = await lockfile.lock(directory, { stale: 10_000, update: 5_000, retries: 0 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new Error("This Superpi session already has an active writer; after a crash, retry in 10 seconds");
      throw error;
    }
    let store: SessionStore;
    try {
      const manifest = persistence ? manifestSchema.parse(await readJson(path.join(directory, "manifest.json")))
        : { version: 1 as const, id, cwd: canonicalCwd, interrupted: false };
      if (manifest.id !== id || manifest.cwd !== canonicalCwd) throw new Error("Session persistence does not belong to this workspace");
      store = new SessionStore(directory, manifest, releaseLock);
    } catch (error) { await releaseLock(); throw error; }
    try {
      await fs.mkdir(store.sessionDirectory, { recursive: true, mode: 0o700 });
      if (await fs.realpath(store.sessionDirectory) !== store.sessionDirectory) throw new Error("Native session directory cannot be a symbolic link");
      if (store.manifest.nativeSessionFile) await store.resolveTranscript(store.manifest.nativeSessionFile);
      await store.save({});
      return store;
    } catch (error) { await store.release(); throw error; }
  }

  get sessionDirectory(): string { return path.join(this.directory, "native"); }
  get data(): Readonly<Manifest> { return { ...this.manifest }; }
  get persistence(): ProviderPersistence { return { version: 1, data: { id: this.manifest.id } }; }

  async transcript(): Promise<string | undefined> {
    return this.manifest.nativeSessionFile ? this.resolveTranscript(this.manifest.nativeSessionFile) : undefined;
  }

  private async resolveTranscript(relative: string): Promise<string> {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Invalid native transcript identity");
    const file = await fs.realpath(path.join(this.directory, relative));
    if (!file.startsWith(`${this.sessionDirectory}${path.sep}`)) throw new Error("Native transcript is outside its owned session");
    if (!(await fs.stat(file)).isFile()) throw new Error("Native transcript is not a file");
    return file;
  }

  async recordNative(sessionId: string, sessionFile: string | undefined): Promise<void> {
    let relative: string | undefined;
    if (sessionFile) {
      relative = path.relative(this.directory, sessionFile);
      try { await this.resolveTranscript(relative); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || this.manifest.nativeSessionFile) throw error;
        const parent = await fs.realpath(path.dirname(sessionFile));
        const candidate = path.join(parent, path.basename(sessionFile));
        if (!candidate.startsWith(`${this.sessionDirectory}${path.sep}`)) throw new Error("Native transcript is outside its owned session");
        relative = undefined;
      }
    }
    await this.save({ nativeSessionId: sessionId, ...(relative ? { nativeSessionFile: relative } : {}) });
  }

  save(changes: Partial<Manifest>): Promise<void> {
    if (this.releasePromise) return Promise.reject(new Error("Session writer has been released"));
    const operation = this.updates.then(async () => {
      const next = manifestSchema.parse({ ...this.manifest, ...changes });
      const temporary = path.join(this.directory, `manifest-${randomUUID()}.tmp`);
      const file = await fs.open(temporary, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify(next)}\n`); await file.sync(); }
      finally { await file.close(); }
      try { await fs.rename(temporary, path.join(this.directory, "manifest.json")); }
      finally { await fs.rm(temporary, { force: true }); }
      this.manifest = next;
    });
    this.updates = operation.catch(() => {});
    return operation;
  }

  release(): Promise<void> {
    this.releasePromise ??= this.updates.then(() => this.releaseLock());
    return this.releasePromise;
  }
}
