import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
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
} from "./server/service";
import { createMutex } from "./server/store";
import {
  archiveVirtualWorkspace as archiveVirtualWorkspaceRpc,
  cleanupVirtualWorkspace as cleanupVirtualWorkspaceRpc,
  createVirtualWorkspace as createVirtualWorkspaceRpc,
  forgetVirtualWorkspace as forgetVirtualWorkspaceRpc,
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
      await paseo.workspaces.archive(workspaceId);
    },
    async renameWorkspace(workspaceId: string, title: string): Promise<void> {
      await paseo.workspaces.ref(workspaceId).setTitle(title);
    },
    async listWorkspaces(): Promise<HostWorkspaceRef[]> {
      const listed = await paseo.workspaces.list();
      return listed.entries.map((entry) => ({
        id: entry.id,
        cwd: entry.workspaceDirectory ?? entry.projectRootPath,
        projectId: entry.projectId ?? null,
        name: entry.name ?? null,
      }));
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
  const init = createInitRunner();
  const paseoHome = resolvePaseoHome();
  const withIndexLock = createMutex();

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
    return createVirtualWorkspace(depsFor(context), {
      uberProjectId: input.uberProjectId,
      feature: input.feature,
      baseBranchOverrides: input.baseBranchOverrides,
      importBranch: input.importBranch,
      importDefaults: input.importDefaults,
      createTerminals: input.createTerminals,
      resume: input.resume,
    });
  });

  server.handle(archiveVirtualWorkspaceRpc, async (input, context) => {
    return archiveVirtualWorkspace(depsFor(context), {
      virtualId: input.virtualId,
      forceRepoIds: input.forceRepoIds,
      force: input.force,
    });
  });

  server.handle(getRepoStatusesRpc, async (input, context) => {
    return getRepoStatuses(depsFor(context), input.virtualId);
  });

  server.handle(regenerateRepomapRpc, async (input, context) => {
    return regenerateRepomap(depsFor(context), input.virtualId);
  });

  server.handle(reconcileVirtualWorkspacesRpc, async (_input, context) => {
    return reconcileVirtualWorkspaces(depsFor(context));
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
    await handleWorkspaceArchived(hookDeps, { id: event.workspace.id, cwd: event.workspace.cwd });
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

  return () => init.stop();
}
