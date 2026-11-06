import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import {
  execCommand,
  type PluginHandlerContext,
  type PluginServerContext,
} from "@getpaseo/plugin/server";
import { createArchiveJobManager } from "./server/archive-jobs";
import { createJobManager } from "./server/create-jobs";
import { createFsPort } from "./server/files";
import { createGitPort } from "./server/git";
import { createInitRunner } from "./server/init";
import type {
  CreateDirectoryWorkspaceInput,
  CreateDirectoryWorkspaceResult,
  HostWorkspaceRef,
  WorkspacesPort,
} from "./server/ports";
import {
  archiveVirtualWorkspace,
  cleanupVirtualWorkspace,
  createVirtualWorkspace,
  discoverImportBranches,
  forgetVirtualWorkspace,
  getRepoStatuses,
  handleWorkspaceArchived,
  listVirtualWorkspaces,
  reconcileOnLoad,
  reconcileVirtualWorkspaces,
  regenerateRepomap,
  repairConstituent,
  type ServiceDeps,
  sanitizeVirtualId,
} from "./server/service";
import { createMutex } from "./server/store";
import {
  archiveVirtualWorkspace as archiveVirtualWorkspaceRpc,
  cleanupVirtualWorkspace as cleanupVirtualWorkspaceRpc,
  createVirtualWorkspace as createVirtualWorkspaceRpc,
  emptyReconcileReport,
  forgetVirtualWorkspace as forgetVirtualWorkspaceRpc,
  getArchiveJob,
  getCreateJob,
  getRepoStatuses as getRepoStatusesRpc,
  getSettingsSnapshot,
  listImportBranches as listImportBranchesRpc,
  listUberProjects,
  listVirtualWorkspaces as listVirtualWorkspacesRpc,
  reconcileVirtualWorkspaces as reconcileVirtualWorkspacesRpc,
  regenerateRepomap as regenerateRepomapRpc,
  repairConstituent as repairConstituentRpc,
} from "./shared/rpc";
import { polyrepoSettings } from "./shared/settings";

function resolvePaseoHome(): string {
  const fromEnv = process.env.PASEO_HOME;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".paseo");
}

function createWorkspacesPort(paseo: PaseoApi): WorkspacesPort {
  return {
    async createDirectoryWorkspace(
      input: CreateDirectoryWorkspaceInput,
    ): Promise<CreateDirectoryWorkspaceResult> {
      const handle = await paseo.workspaces.create({
        source: {
          kind: "directory",
          path: input.path,
          ...(input.projectId ? { projectId: input.projectId } : {}),
        },
        title: input.title,
      });
      return { workspaceId: handle.id, projectId: handle.projectId };
    },
    async archiveWorkspace(workspaceId: string): Promise<void> {
      const result = await paseo.workspaces.archive(workspaceId);
      if (result.error) throw new Error(result.error);
    },
    async renameWorkspace(workspaceId: string, title: string): Promise<void> {
      await paseo.workspaces.ref(workspaceId).setTitle(title);
    },
    async listWorkspaces(): Promise<HostWorkspaceRef[]> {
      const entries: HostWorkspaceRef[] = [];
      let cursor: string | undefined;
      do {
        const listed = await paseo.workspaces.list({
          filter: { includeInternal: true, includeBackground: true },
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        entries.push(
          ...listed.entries.map((entry) => ({
            id: entry.id,
            cwd: entry.workspaceDirectory ?? entry.projectRootPath,
            projectId: entry.projectId ?? null,
            name: entry.name ?? null,
          })),
        );
        cursor = listed.pageInfo.hasMore ? (listed.pageInfo.nextCursor ?? undefined) : undefined;
        if (listed.pageInfo.hasMore && !cursor) throw new Error("workspace listing is incomplete");
      } while (cursor);
      return entries;
    },
    async listProjects() {
      const result = await paseo.projects.list();
      return result.projects.map((project) => ({
        id: project.projectId,
        rootPath: project.projectRootPath,
      }));
    },
    async deleteProject(projectId, paseoHome) {
      await execCommand("paseo", ["project", "delete", "--home", paseoHome, projectId], {
        timeout: 60_000,
      });
    },
    async createTerminal(
      workspaceId: string,
      input: { cwd?: string; name?: string },
    ): Promise<void> {
      await paseo.workspaces.ref(workspaceId).terminals.create(input);
    },
  };
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(polyrepoSettings);
  const fs = createFsPort();
  const git = createGitPort();
  const archiveJobs = createArchiveJobManager();
  const createJobs = createJobManager();
  const init = createInitRunner();
  const paseoHome = resolvePaseoHome();
  const withIndexLock = createMutex();
  let stopped = false;

  function depsFor(context: PluginHandlerContext): ServiceDeps {
    return {
      fs,
      git,
      init,
      workspaces: createWorkspacesPort(context.paseo),
      settings: {
        async snapshot() {
          const state = await settings.read();
          if (state.status !== "ready") return { uberProjects: [] };
          return {
            virtualRootBase: state.values.virtualRootBase,
            uberProjects: state.values.uberProjects,
          };
        },
      },
      paseoHome,
      now: () => new Date().toISOString(),
      withIndexLock,
    };
  }

  server.handle(getSettingsSnapshot, async (_input, context) => {
    const snapshot = await depsFor(context).settings.snapshot();
    return {
      virtualRootBase: snapshot.virtualRootBase ?? null,
      uberProjects: snapshot.uberProjects,
    };
  });

  server.handle(listUberProjects, async (_input, context) => {
    const snapshot = await depsFor(context).settings.snapshot();
    return { uberProjects: snapshot.uberProjects };
  });

  server.handle(listVirtualWorkspacesRpc, async (_input, context) => {
    return { virtualWorkspaces: await listVirtualWorkspaces(depsFor(context)) };
  });

  server.handle(listImportBranchesRpc, async (input, context) => {
    return discoverImportBranches(depsFor(context), input.uberProjectId);
  });

  server.handle(createVirtualWorkspaceRpc, async (input, context) => {
    const virtualId = sanitizeVirtualId(input.uberProjectId, input.feature);
    const jobId = createJobs.start(virtualId, () =>
      archiveJobs.hasRunning(virtualId)
        ? Promise.resolve({
            ok: false,
            virtualId,
            workspaceId: null,
            error: "Workspace archive is still running.",
            preflight: [],
          })
        : createVirtualWorkspace(depsFor(context), {
            uberProjectId: input.uberProjectId,
            feature: input.feature,
            baseBranchOverrides: input.baseBranchOverrides,
            importBranch: input.importBranch,
            importDefaults: input.importDefaults,
            createTerminals: input.createTerminals,
            resume: input.resume,
          }),
    );
    return { jobId };
  });

  server.handle(getCreateJob, (input) => Promise.resolve(createJobs.get(input.jobId)));

  server.handle(archiveVirtualWorkspaceRpc, async (input, context) => {
    const jobId = archiveJobs.start(input.virtualId, () =>
      createJobs.hasRunning(input.virtualId)
        ? Promise.resolve({ ok: false, error: "Workspace creation is still running.", blocked: [] })
        : archiveVirtualWorkspace(depsFor(context), {
            virtualId: input.virtualId,
            forceRepoIds: input.forceRepoIds,
            force: input.force,
          }),
    );
    return { jobId };
  });

  server.handle(getArchiveJob, (input) => Promise.resolve(archiveJobs.get(input.jobId)));

  server.handle(getRepoStatusesRpc, async (input, context) => {
    return getRepoStatuses(depsFor(context), input.virtualId);
  });

  server.handle(regenerateRepomapRpc, async (input, context) => {
    return regenerateRepomap(depsFor(context), input.virtualId);
  });

  server.handle(reconcileVirtualWorkspacesRpc, async (_input, context) => {
    if (archiveJobs.hasRunning() || createJobs.hasRunning()) {
      return {
        ok: false,
        error: "Wait for active workspace setup or archive to finish before resyncing.",
        report: emptyReconcileReport(),
      };
    }
    return reconcileVirtualWorkspaces(depsFor(context), {
      scheduleArchive(virtualId) {
        archiveJobs.start(virtualId, () =>
          archiveVirtualWorkspace(depsFor(context), { virtualId }),
        );
      },
    });
  });

  server.handle(forgetVirtualWorkspaceRpc, async (input, context) => {
    return forgetVirtualWorkspace(depsFor(context), input.virtualId);
  });

  server.handle(cleanupVirtualWorkspaceRpc, async (input, context) => {
    return cleanupVirtualWorkspace(depsFor(context), input.virtualId);
  });

  server.handle(repairConstituentRpc, async (input, context) => {
    return repairConstituent(depsFor(context), input.virtualId, input.repoId);
  });

  server.on("workspace.archived", async (event, context) => {
    const hookDeps: ServiceDeps = {
      ...depsFor(context),
      workspaces: createWorkspacesPort(context.paseo),
    };
    const archived = { id: event.workspace.id, cwd: event.workspace.cwd };
    if (createJobs.hasRunning()) {
      void (async () => {
        while (!stopped && createJobs.hasRunning()) await createJobs.whenIdle();
        if (!stopped) await handleWorkspaceArchived(hookDeps, archived);
      })().catch((error: unknown) => {
        console.warn("[poly-repo-workspaces] deferred archive failed", error);
      });
      return;
    }
    await handleWorkspaceArchived(hookDeps, archived);
  });

  // No startup lifecycle event exists, so reconcile when the plugin loads
  // (daemon start and every reload). reconcileOnLoad only touches the
  // filesystem and the index; host-workspace liveness is left to the
  // reconcile RPC, which runs with handler credentials.
  const loadDeps = {
    fs,
    git,
    settings: {
      async snapshot() {
        const state = await settings.read();
        if (state.status !== "ready") return { uberProjects: [] };
        return {
          virtualRootBase: state.values.virtualRootBase,
          uberProjects: state.values.uberProjects,
        };
      },
    },
    paseoHome,
    now: () => new Date().toISOString(),
    withIndexLock,
  };
  void reconcileOnLoad(loadDeps).then(
    (summary) => {
      if (summary.adopted.length > 0 || summary.finalized.length > 0) {
        console.info(
          `[poly-repo-workspaces] load reconcile: adopted ${summary.adopted.length}, ` +
            `finalized ${summary.finalized.length}`,
        );
      }
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown error";
      console.warn(`[poly-repo-workspaces] load reconcile failed: ${message}`);
    },
  );

  return async () => {
    stopped = true;
    archiveJobs.dispose();
    createJobs.dispose();
    git.stop();
    await init.stop();
  };
}
