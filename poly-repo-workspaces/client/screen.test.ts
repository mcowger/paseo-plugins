import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createVirtualWorkspace, VirtualWorkspaceSummary } from "../shared/rpc";

type CreateResult = RpcOutput<typeof createVirtualWorkspace>;

import { PolyRepoScreen } from "./screen";

// Lightweight hook/host harness: test interactions without a DOM or native runtime.
const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  mounted: false,
  effects: [] as Array<() => unknown>,
  items: [] as VirtualWorkspaceSummary[],
  create: vi.fn(),
  archive: vi.fn(),
  refresh: vi.fn(),
  toast: { show: vi.fn(), error: vi.fn() },
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
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => {
    if (!harness.mounted) harness.effects.push(effect);
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
  useToast: () => harness.toast,
  usePaseo: () => ({}),
  useRpc: (contract: { name: string }) =>
    contract.name === "polyrepo.virtual-workspaces.create"
      ? harness.create
      : contract.name === "polyrepo.virtual-workspaces.archive"
        ? harness.archive
        : async () => ({
            uberProjects: [
              {
                id: "uber",
                displayName: "Uber",
                branchTemplate: "{feature}",
                repos: [{ id: "frontend" }, { id: "app" }],
              },
            ],
          }),
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
  accessibilityState?: { busy?: boolean; disabled?: boolean };
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

function pendingCreate() {
  let resolve: (result: CreateResult) => void = () => {};
  let reject: (error: Error) => void = () => {};
  harness.create.mockImplementationOnce(
    () =>
      new Promise<CreateResult>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      }),
  );
  return {
    resolve: (result: CreateResult) => resolve(result),
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
  harness.states = [];
  harness.effects = [];
  harness.items = [];
  harness.mounted = false;
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
    await Promise.resolve();
    tree = render();
    expect(nodes(tree).some((node) => node.type === "ActivityIndicator")).toBe(false);
    expect(control(tree, "Feature name").editable).toBe(true);
    expect(harness.toast.show).toHaveBeenCalledWith(`Created ${feature}`);
    expect(harness.refresh).toHaveBeenCalled();
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
      await Promise.resolve();
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
    await Promise.resolve();
    expect(nodes(render()).some((node) => node.type === "ActivityIndicator")).toBe(false);
  });
});
