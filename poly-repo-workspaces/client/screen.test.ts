import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getCreateJob, VirtualWorkspaceSummary } from "../shared/rpc";

type CreateResult = Extract<RpcOutput<typeof getCreateJob>, { state: "finished" }>["result"];

import { PolyRepoScreen } from "./screen";

// Lightweight hook/host harness: test interactions without a DOM or native runtime.
const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  mounted: false,
  effectDeps: [] as unknown[][],
  effectCursor: 0,
  refCursor: 0,
  effects: [] as Array<() => unknown>,
  items: [] as VirtualWorkspaceSummary[],
  create: vi.fn(),
  createJob: vi.fn(),
  branches: vi.fn(),
  archive: vi.fn(),
  projects: vi.fn(),
  refresh: vi.fn(),
  toast: { show: vi.fn(), error: vi.fn() },
  refs: [] as Array<{ current: ReturnType<typeof setTimeout> | null }>,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: <State>(initial: State) => {
    const index = harness.cursor++;
    if (index >= harness.states.length) harness.states.push(initial);
    return [
      harness.states[index],
      (next: State | ((previous: State) => State)) => {
        harness.states[index] =
          typeof next === "function"
            ? (next as (previous: State) => State)(harness.states[index] as State)
            : next;
      },
    ];
  },
  useRef: <Value>(initial: Value) => {
    const index = harness.refCursor++;
    if (!harness.refs[index])
      harness.refs[index] = { current: initial } as {
        current: ReturnType<typeof setTimeout> | null;
      };
    return harness.refs[index] as { current: Value };
  },
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
    const index = harness.effectCursor++;
    const previous = harness.effectDeps[index];
    if (!previous || !deps || deps.some((value, i) => value !== previous[i])) {
      harness.effectDeps[index] = deps ? [...deps] : [];
      if (!harness.mounted) harness.effects.push(effect);
      else effect();
    }
  },
}));

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));

// Vitest maps all host SDK entry points to the same stub module.
vi.mock("@getpaseo/plugin/client", () => ({
  defineRpc: (definition: unknown) => definition,
  defineSettings: (definition: unknown) => definition,
  useToast: () => harness.toast,
  usePaseo: () => ({}),
  useRpc: (contract: { name: string }) =>
    contract.name === "polyrepo.virtual-workspaces.create"
      ? harness.create
      : contract.name === "polyrepo.virtual-workspaces.create-status"
        ? harness.createJob
        : contract.name === "polyrepo.virtual-workspaces.import-branches"
          ? harness.branches
          : contract.name === "polyrepo.virtual-workspaces.archive"
            ? harness.archive
            : harness.projects,
}));

vi.mock("./use-virtual-workspaces", () => ({
  useVirtualWorkspaces: () => ({
    items: harness.items,
    loading: false,
    error: null,
    refresh: harness.refresh,
  }),
}));

type ElementProps = {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityState?: { busy?: boolean; disabled?: boolean; selected?: boolean };
  disabled?: boolean;
  editable?: boolean;
  onPress?: () => void;
  onChangeText?: (text: string) => void;
};

function nodes(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...nodes(node.props.children)];
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<ElementProps>(node) ? text(node.props.children) : "";
}

function control(tree: ReactNode, label: string): ElementProps {
  const match = nodes(tree).find((node) => node.props.accessibilityLabel === label);
  if (!match) throw new Error(`Missing control: ${label}`);
  return match.props;
}

function render(): ReactElement {
  harness.cursor = 0;
  harness.refCursor = 0;
  harness.effectCursor = 0;
  const tree = PolyRepoScreen({
    theme: { colors: {} } as PluginScreenProps["theme"],
    layout: { compact: false } as PluginScreenProps["layout"],
    params: {},
  } as PluginScreenProps);
  if (!harness.mounted) {
    harness.mounted = true;
    for (const effect of harness.effects) effect();
  }
  return tree;
}

async function ready(): Promise<ReactElement> {
  render();
  await Promise.resolve();
  return render();
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function pendingCreate() {
  let resolve: (result: { jobId: string }) => void = () => {};
  let reject: (error: Error) => void = () => {};
  harness.create.mockImplementationOnce(
    () =>
      new Promise<{ jobId: string }>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      }),
  );
  return {
    resolve: (result: CreateResult) => {
      harness.createJob.mockResolvedValueOnce({ state: "finished", result });
      resolve({ jobId: "job-1" });
    },
    reject: (error: Error) => reject(error),
  };
}

const success: CreateResult = {
  ok: true,
  virtualId: "uber-fix",
  workspaceId: "workspace",
  error: null,
  preflight: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  harness.create.mockReset();
  harness.createJob.mockReset();
  harness.projects.mockReset();
  harness.branches.mockReset();
  harness.projects.mockResolvedValue({
    uberProjects: [
      {
        id: "uber",
        displayName: "Uber",
        branchTemplate: "{feature}",
        repos: [{ id: "frontend" }, { id: "app" }],
      },
    ],
  });
  harness.branches.mockResolvedValue({
    branches: ["main", "feature-x"],
    error: null,
    defaults: [
      { repoId: "frontend", branch: "master" },
      { repoId: "app", branch: "main" },
    ],
    defaultError: null,
  });
  harness.states = [];
  harness.effects = [];
  harness.items = [];
  harness.effectDeps = [];

  harness.mounted = false;
  harness.create.mockResolvedValue({ jobId: "job-1" });
  harness.createJob.mockResolvedValue({ state: "finished", result: success });
  harness.refs = [];
});

it("refreshes project choices after returning from configuration", async () => {
  let tree = await ready();
  expect(control(tree, "Workspaces").accessibilityState?.selected).toBe(true);
  control(tree, "Configuration").onPress?.();
  tree = render();
  expect(control(tree, "Configuration").accessibilityState?.selected).toBe(true);
  harness.projects.mockResolvedValue({
    uberProjects: [
      { id: "new", displayName: "New project", branchTemplate: "{feature}", repos: [] },
    ],
  });
  control(tree, "Workspaces").onPress?.();
  render();
  await Promise.resolve();
  tree = render();
  expect(control(tree, "Use New project")).toBeDefined();
  expect(nodes(tree).some((node) => node.props.accessibilityLabel === "Use Uber")).toBe(false);
});

describe("workspace creation feedback", () => {
  it("requires confirmation before forcing removal", async () => {
    harness.items = [
      {
        virtualId: "uber-fix",
        uberProjectId: "uber",
        feature: "Fix",
        branch: "fix",
        state: "teardown-blocked",
        rootExists: true,
        constituents: [],
      } as unknown as VirtualWorkspaceSummary,
    ];
    harness.archive.mockResolvedValue({ ok: true, error: null, blocked: [] });
    let tree = await ready();
    control(tree, "Force delete Fix").onPress?.();
    tree = render();
    expect(text(tree)).toContain("uncommitted changes");
    expect(harness.archive).not.toHaveBeenCalled();
    control(tree, "Confirm force delete Fix").onPress?.();
    await Promise.resolve();
    expect(harness.archive).toHaveBeenCalledWith({ virtualId: "uber-fix", force: true });
    expect(harness.refresh).toHaveBeenCalled();
  });

  it("previews the sanitized branch, keeps the display name, and shows a spinner until completion", async () => {
    let tree = await ready();
    const feature = "SIG: ABSCD - Fix My Stuff";
    control(tree, "Feature name").onChangeText?.(feature);
    tree = render();
    expect(text(tree)).toContain("Branch: sig-abscd-fix-my-stuff");
    const pending = pendingCreate();
    control(tree, "Create virtual workspace").onPress?.();
    tree = render();
    expect(harness.create).toHaveBeenCalledWith({
      uberProjectId: "uber",
      feature,
      createTerminals: undefined,
    });
    expect(text(tree)).toContain(`Creating ${feature}...`);
    expect(text(tree)).toContain("Setting up 2 repo worktrees");
    expect(control(tree, "Workspace creation in progress")).toBeDefined();
    expect(control(tree, "Create virtual workspace").accessibilityState?.busy).toBe(true);
    expect(control(tree, "Feature name").editable).toBe(false);
    expect(control(tree, "Use Uber").disabled).toBe(true);
    expect(control(tree, "Open a terminal in each repo after creation").disabled).toBe(true);

    pending.resolve(success);
    await flushAsync();
    tree = render();
    expect(nodes(tree).some((node) => node.type === "ActivityIndicator")).toBe(false);
    expect(control(tree, "Feature name").editable).toBe(true);
    expect(harness.toast.show).toHaveBeenCalledWith(`Created ${feature}`);
    expect(harness.refresh).toHaveBeenCalled();
  });
  it("polls a running create job until it finishes", async () => {
    vi.useFakeTimers();
    try {
      let tree = await ready();
      control(tree, "Feature name").onChangeText?.("Poll me");
      tree = render();
      harness.createJob
        .mockResolvedValueOnce({ state: "running" })
        .mockResolvedValueOnce({ state: "finished", result: success });
      control(tree, "Create virtual workspace").onPress?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.createJob).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(harness.createJob).toHaveBeenCalledTimes(2);
      expect(harness.createJob).toHaveBeenLastCalledWith({ jobId: "job-1" });
      expect(harness.toast.show).toHaveBeenCalledWith("Created Poll me");
    } finally {
      vi.useRealTimers();
    }
  });

  it("imports each configured default branch", async () => {
    let tree = await ready();
    await Promise.resolve();
    tree = render();
    expect(text(tree)).toContain("frontend: master");
    expect(text(tree)).toContain("app: main");
    expect(text(tree)).toContain("Create a branch to keep commits reachable.");
    const pending = pendingCreate();
    expect(control(tree, "Create workspace from default branches").disabled).toBe(false);
    control(tree, "Create workspace from default branches").onPress?.();
    expect(harness.create).toHaveBeenCalledWith({
      uberProjectId: "uber",
      feature: "default",
      importDefaults: true,
      createTerminals: undefined,
    });
    pending.resolve(success);
    await flushAsync();
    render();
  });

  it("imports a selected branch and clears it when changing projects", async () => {
    let tree = await ready();
    await flushAsync();
    tree = render();
    control(tree, "Import branch feature-x").onPress?.();
    tree = render();
    expect(control(tree, "Import branch feature-x").accessibilityState?.selected).toBe(true);
    expect(text(tree)).toContain("Branch: feature-x");
    expect(control(tree, "Feature name")).toBeDefined();
    const pending = pendingCreate();
    control(tree, "Create virtual workspace").onPress?.();
    expect(harness.create).toHaveBeenCalledWith({
      uberProjectId: "uber",
      feature: "feature-x",
      importBranch: "feature-x",
      createTerminals: undefined,
    });
    pending.resolve(success);
    await flushAsync();
    render();
  });

  it.each(["preflight", "error", "exception"])(
    "clears the busy indicator after %s failures",
    async (failure) => {
      let tree = await ready();
      control(tree, "Feature name").onChangeText?.("Fix my stuff");
      tree = render();
      const pending = pendingCreate();
      control(tree, "Create virtual workspace").onPress?.();
      if (failure === "exception") pending.reject(new Error("Disconnected"));
      else {
        pending.resolve({
          ...success,
          ok: false,
          error: failure === "error" ? "Disk full" : null,
          preflight:
            failure === "preflight"
              ? [{ repoId: "app", code: "branch-exists", message: "Branch already exists" }]
              : [],
        });
      }
      await flushAsync();
      tree = render();
      expect(nodes(tree).some((node) => node.type === "ActivityIndicator")).toBe(false);
      expect(control(tree, "Create virtual workspace").disabled).toBe(false);
      expect(text(tree)).toContain(
        failure === "exception"
          ? "Disconnected"
          : failure === "error"
            ? "Disk full"
            : "Branch already exists",
      );
      expect(harness.refresh).toHaveBeenCalled();
    },
  );

  it("shows the same spinner while resuming a partial workspace", async () => {
    harness.items = [
      {
        virtualId: "uber-fix",
        uberProjectId: "uber",
        feature: "Fix my stuff",
        state: "creating",
        constituents: [],
      } as unknown as VirtualWorkspaceSummary,
    ];
    let tree = await ready();
    const pending = pendingCreate();
    control(tree, "Resume Fix my stuff").onPress?.();
    tree = render();
    expect(text(tree)).toContain("Resuming Fix my stuff...");
    expect(control(tree, "Workspace creation in progress")).toBeDefined();
    pending.resolve(success);
    await flushAsync();
    expect(nodes(render()).some((node) => node.type === "ActivityIndicator")).toBe(false);
  });
});
