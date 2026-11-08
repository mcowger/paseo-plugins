import * as esbuild from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * 0.11.0:「实时跟随输出」的回底回归。窗口饱和后内容高度近似不变（旧的从顶上裁掉、新的接在底下），
 * onContentSizeChange 不再触发——跟随必须挂在尾窗内容本身（tailHead），否则长内容一开始就停摆。
 * 这里用会执行 effect 的 react 替身 + 可捕获 ref/回调的 ScrollView 替身，直接驱动这两条路径。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const STANDINS: Record<string, string> = {
  react: `export const Fragment = Symbol.for("standin.fragment");
export const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } });
export const useState = (value) => [typeof value === "function" ? value() : value, () => {}];
export const useMemo = (factory) => factory();
export const useCallback = (callback) => callback;
let __refSlots = [];
let __refIdx = 0;
export const useRef = (value) => { if (__refIdx >= __refSlots.length) __refSlots.push({ current: value }); return __refSlots[__refIdx++]; };
export const __refsReset = () => { __refIdx = 0; };
export const __refsClear = () => { __refSlots = []; __refIdx = 0; };
export const useEffect = (fn) => { fn(); };
export const setTimeout = (fn, ms) => globalThis.setTimeout(fn, ms);
export const clearTimeout = (id) => globalThis.clearTimeout(id);
export const useSyncExternalStore = (subscribe, snapshot) => snapshot();
export const createContext = (value) => ({ Provider: "ContextProvider", _value: value });
export const useContext = (context) => context._value;
export default { Fragment, createElement, useState, useMemo, useCallback, useRef, useEffect, useSyncExternalStore, createContext, useContext };`,
  "react/jsx-runtime": `export const Fragment = Symbol.for("standin.fragment");
export const jsx = (type, props) => ({ type, props: props ?? {} });
export const jsxs = jsx;`,
  "react-native": `export const View = (props) => ({ type: "View", props });
export const Text = (props) => ({ type: "Text", props });
export const Pressable = (props) => ({ type: "Pressable", props });
export const ScrollView = (props) => { globalThis.__vividScroll = props; return { type: "ScrollView", props }; };
export const Image = "Image";
export const ActivityIndicator = "ActivityIndicator";
export const StyleSheet = { create: (styles) => styles, hairlineWidth: 0.5, absoluteFillObject: {} };
export const Platform = { OS: "web", select: (spec) => spec.web ?? spec.default };
class Value { constructor(value) { this.value = value; } interpolate() { return this; } }
const animation = () => ({ start() {}, stop() {} });
export const Animated = { Value, View: "View", timing: animation, spring: animation, loop: animation, sequence: animation, parallel: animation, delay: animation };
const curve = (t) => t;
export const Easing = { linear: curve, ease: curve, quad: curve, cubic: curve, sin: curve, in: () => curve, out: () => curve, inOut: () => curve, bezier: () => curve };
export const AppState = { currentState: "active", addEventListener: () => ({ remove() {} }) };
export const AccessibilityInfo = { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) };`,
  host: `export const Icon = () => ({ type: "Icon", props: {} });
export const ScrollView = (props) => { globalThis.__vividHostScroll = props; return { type: "ScrollView", props }; };
export const Modal = "Modal";
export const TextInput = "TextInput";
export const useRevealedText = (text) => text;
export const useHighlightTokens = () => null;
export const copyText = async () => {};
export const useToast = () => ({ error() {} });
export const useSettings = () => globalThis.__vividSettings ?? ({ status: "loading" });
export const useAgent = () => undefined;
export const usePaseo = () => ({ agents: { ref: () => ({}) } });
export const useRpc = () => async () => ({});
export const defineRpc = (contract) => contract;
export const defineSettings = (definition) => definition;
export const settingsRpc = () => ({ read: {} });`,
};
const HOST_SPECIFIERS = ["@getpaseo/plugin", "@getpaseo/plugin/client", "@getpaseo/plugin/client/react-native", "@getpaseo/plugin/client/ui"];

type Element = { type: unknown; props: Record<string, unknown> } | string | number | boolean | null | undefined | Element[];

function render(element: Element): Element[] {
  if (element === null || element === undefined || typeof element === "boolean") return [];
  if (typeof element === "string" || typeof element === "number") return [String(element)];
  if (Array.isArray(element)) return element.flatMap(render);
  if (typeof element.type === "function") return render((element.type as (props: unknown) => Element)(element.props));
  if (typeof element.type === "symbol") return render(element.props.children as Element);
  return [element];
}

let dir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ui: any;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "vivid-reasoning-follow-"));
  const entry = path.join(dir, "entry.ts");
  writeFileSync(entry, [
    `import ${JSON.stringify(path.join(here, "../tests/i18n-setup.ts"))};`,
    `export { DetailBody, ReasoningText, TerminalBlock } from ${JSON.stringify(path.join(here, "activity-details.tsx"))};`,
    `export { followStatusDomains } from ${JSON.stringify(path.join(here, "settings-preview-rows.tsx"))};`,
    `export { useFollowBottom } from ${JSON.stringify(path.join(here, "settings-hooks.ts"))};`,
    `export { createToolCallData } from ${JSON.stringify(path.join(here, "../shared/timeline.ts"))};`,
    `export { __refsReset, __refsClear } from "react";`,
  ].join("\n"));
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    jsx: "automatic",
    logLevel: "silent",
    nodePaths: [path.join(here, "../node_modules")],
    plugins: [{
      name: "standins",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.path in STANDINS) return { path: args.path, namespace: "standin" };
          if (HOST_SPECIFIERS.includes(args.path)) return { path: "host", namespace: "standin" };
          return undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "standin" }, (args) => ({ contents: STANDINS[args.path], loader: "js" }));
      },
    }],
  });
  const file = path.join(dir, "bundle.mjs");
  writeFileSync(file, result.outputFiles[0]!.text);
  // 替身只覆盖推理路径用到的 SDK 面；其余组件的未匹配导出警告不阻塞（真实组件在别处渲染）。
  // 动态导入是本测试的目的本身：被导入的是 esbuild 刚写出的临时 bundle（路径运行时才存在），
  // 静态导入无法指向尚未生成的文件（同 client/native-rows.test.ts 的既有做法）。
  ui = await import(pathToFileURL(file).href);
}, 60_000);

beforeEach(() => {
  // 每个用例都是一次全新挂载：ref 槽位连值一起清空（用例内的两次 draw 之间只做索引回绕，槽位保留）。
  ui?.__refsClear?.();
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const theme = { colors: { surface0: "#101114", surface1: "#17181c", surface2: "#1f2026", foreground: "#ececf1", foregroundMuted: "#9a9aa5", border: "#2c2d33", accent: "#20744a" } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const styles = () => ({ detailsScroll: { maxHeight: 420 }, details: {}, stepList: {}, showMoreButton: {}, showMoreText: {} } as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const palette = () => ({ mode: "vivid" } as any);
const steps = (count: number) => Array.from({ length: count }, (_, index) => `第 ${index + 1} 步：写一段足够成为独立步骤的推理文本。`).join("\n\n");

function draw(text: string) {
  ui.__refsReset();
  const raw = { type: ui.ReasoningText, props: { text, phase: "streaming", theme, palette: palette(), styles: styles() } };
  const element = render(raw);
  // render 的叶分支保留函数 type，直接在渲染结果里找 ScrollView 节点取 ref/回调。
  const find = (nodes: Element[]): { ref: { current: unknown }; onScroll?: (event: unknown) => void; onContentSizeChange?: () => void } | null => {
    for (const node of nodes) {
      if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") continue;
      if (Array.isArray(node)) { const hit = find(node); if (hit) return hit; continue; }
      if (typeof node.type === "function" && node.type.name === "ScrollView") return node.props as never;
      const hit = find(node.props?.children as Element[]);
      if (hit) return hit;
    }
    return null;
  };
  const scroll = find(element);
  expect(scroll).toBeTruthy();
  expect(typeof scroll!.onContentSizeChange).toBe("function");
  return { scroll: scroll! };
}

describe("terminal wrap (0.11.0 长行折行·命令行与输出)", () => {
  const theme = { colors: { surface0: "#101114", surface1: "#17181c", foreground: "#ececf1", foregroundMuted: "#9a9aa5", border: "#2c2d33", accent: "#20744a" } };
  const styles = () => ({ frameBody: { flexDirection: "row", minWidth: "100%" }, frameBodyWrap: { minWidth: 0, width: "100%" }, codeScroll: { maxWidth: "100%" }, codeLine: {}, details: {}, detailLabel: {}, copyText: {}, termOutput: {}, termOutputHeader: {}, showMoreButton: {}, showMoreText: {}, section: {}, frame: {} });
  const palette = () => ({ mode: "vivid", statusColors: { failed: "#ff0000", completed: "#00ff00" } });
  const hasHScroll = (nodes: any[]): boolean => nodes.some((node: any) => { if (typeof node !== "object" || node === null) return false; if (node.props?.horizontal === true) return true; const kids = node.props?.children; return hasHScroll(Array.isArray(kids) ? kids : kids != null ? [kids] : []); });
  const draw = (wrap: boolean) => {
    (globalThis as unknown as { __vividSettings?: unknown }).__vividSettings = { status: "ready", values: { wrapLines: { output: wrap } }, revision: 1 };
    return render({ type: ui.TerminalBlock, props: { command: "npm ci --omit=dev && npm test -- --watch=false", output: "ok 5 files changed", errorOutput: undefined, exitCode: null, theme, palette: palette(), styles: styles() } });
  };
  it("wrap on: bounded body, no horizontal ScrollView", () => {
    expect(hasHScroll(draw(true))).toBe(false);
  });
  it("wrap off: horizontal scroll like before", () => {
    expect(hasHScroll(draw(false))).toBe(true);
  });
});

describe("useFollowBottom: enabled=false stops every path (0.11.0 跟随矩阵)", () => {
  const scrolledUp = { nativeEvent: { contentOffset: { y: 0, x: 0 }, contentSize: { height: 2000, width: 400 }, layoutMeasurement: { height: 300, width: 400 } } };
  const counter = () => {
    const state = { calls: 0 };
    return { state, ref: { current: { scrollToEnd: () => { state.calls += 1; } } } };
  };

  it("never scrolls a disabled area: not on content size changes (first layout included), not on content key changes", async () => {
    const { state, ref } = counter();
    const near = { current: true };
    const hook = ui.useFollowBottom(ref, near, 1, false);
    // RN / RN-web 的 ScrollView 首次布局就触发 onContentSizeChange：已完成的长明细不能因此被滚到底部。
    hook.onContentSizeChange();
    ui.useFollowBottom(ref, near, 2, false).onContentSizeChange();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.calls).toBe(0);
  });

  it("follows an enabled area near the bottom, and pauses once the user scrolls up", async () => {
    const { state, ref } = counter();
    const near = { current: true };
    const hook = ui.useFollowBottom(ref, near, 1, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.calls).toBe(1); // 内容键 effect（延迟一帧）
    hook.onContentSizeChange();
    expect(state.calls).toBe(2);
    hook.onScroll(scrolledUp);
    hook.onContentSizeChange();
    expect(state.calls).toBe(2);
  });
});

describe("output tail window while following (0.11.0 跟随最新输出)", () => {
  const theme = { colors: { surface0: "#101114", surface1: "#17181c", foreground: "#ececf1", foregroundMuted: "#9a9aa5", border: "#2c2d33", accent: "#20744a" } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const styles = () => ({ frameBody: {}, frameBodyWrap: {}, codeScroll: {}, codeLine: {}, details: {}, detailLabel: {}, detailText: {}, mutedText: {}, copyText: {}, termOutput: {}, termOutputHeader: {}, showMoreButton: {}, showMoreText: {}, section: {}, frame: {}, frameHeader: {}, frameTitleRow: {}, frameTitle: {}, gutter: {}, gutterText: {} } as any);
  const palette = () => ({ mode: "vivid", statusColors: { failed: "#ff0000", completed: "#00ff00" } });
  const lines = Array.from({ length: 60 }, (_, index) => `LINE_${index + 1}`);
  /** Every string the element draws, rendering function components on the way. */
  const texts = (element: unknown): string[] => {
    if (element === null || element === undefined || typeof element === "boolean") return [];
    if (typeof element === "string" || typeof element === "number") return [String(element)];
    if (Array.isArray(element)) return element.flatMap(texts);
    const node = element as { type: unknown; props?: Record<string, unknown> };
    if (typeof node.type === "function") return texts((node.type as (props: unknown) => unknown)(node.props ?? {}));
    return texts(node.props?.children);
  };
  const shownLines = (element: unknown) => new Set(texts(element).join("\n").split("\n").filter((line) => /^LINE_\d+$/.test(line)));
  const withWrap = <T,>(wrap: boolean, draw: () => T): T => {
    (globalThis as unknown as { __vividSettings?: unknown }).__vividSettings = { status: "ready", values: { wrapLines: { output: wrap, code: wrap } }, revision: 1 };
    try {
      return draw();
    } finally {
      (globalThis as unknown as { __vividSettings?: unknown }).__vividSettings = undefined;
    }
  };
  const terminal = (follow: boolean) => ({ type: ui.TerminalBlock, props: { command: "npm test", output: `${lines.join("\n")}\n`, errorOutput: undefined, exitCode: null, theme, palette: palette(), styles: styles(), follow } });

  for (const wrap of [false, true]) {
    it(`a following command output shows the newest 20 lines (wrap ${wrap ? "on" : "off"})`, () => {
      const shown = withWrap(wrap, () => shownLines(terminal(true)));
      expect(shown.has("LINE_60")).toBe(true);
      expect(shown.has("LINE_41")).toBe(true);
      expect(shown.has("LINE_40")).toBe(false);
      expect(shown.has("LINE_1")).toBe(false);
    });

    it(`a command output that is not following keeps the head preview (wrap ${wrap ? "on" : "off"})`, () => {
      const shown = withWrap(wrap, () => shownLines(terminal(false)));
      expect(shown.has("LINE_1")).toBe(true);
      expect(shown.has("LINE_20")).toBe(true);
      expect(shown.has("LINE_21")).toBe(false);
      expect(shown.has("LINE_60")).toBe(false);
    });
  }

  it("a following worktree setup log shows its newest lines too; not following, its first", () => {
    const data = ui.createToolCallData({ type: "tool_call", callId: "w1", name: "paseo_worktree_setup", status: "running", error: null, detail: { type: "worktree_setup", worktreePath: "/w", branchName: "b", log: lines.join("\n") } });
    const draw = (follow: boolean) => withWrap(false, () => shownLines({ type: ui.DetailBody, props: { data, agentId: "a", theme, palette: palette(), styles: styles(), follow } }));
    const following = draw(true);
    expect(following.has("LINE_60")).toBe(true);
    expect(following.has("LINE_1")).toBe(false);
    const still = draw(false);
    expect(still.has("LINE_1")).toBe(true);
    expect(still.has("LINE_60")).toBe(false);
  });
});

describe("follow status domains (0.11.0 跟随矩阵)", () => {
  it("lists a domain per scope with the switch state", () => {
    const domains = (ui.followStatusDomains as (v: { followOutput?: Record<string, boolean> }) => Array<{ area: string; on: boolean; label: string }>)({ followOutput: { shell: true, logs: false, todo: true, browser: false } });
    const byArea = Object.fromEntries(domains.map((d) => [d.area, d]));
    expect(domains.map((d) => d.area)).toEqual(["shell", "logs", "todo", "browser"]);
    expect(byArea.shell?.on).toBe(true);
    expect(byArea.logs?.on).toBe(false);
    expect(byArea.todo?.on).toBe(true);
    expect(byArea.browser?.on).toBe(false);
    expect(byArea.shell?.label.length).toBeGreaterThan(0);
  });
  it("defaults every domain on when the matrix is missing", () => {
    const domains = (ui.followStatusDomains as (v: { followOutput?: Record<string, boolean> }) => Array<{ area: string; on: boolean; label: string }>)({});
    expect(domains.every((d) => d.on)).toBe(true);
  });
});

describe("reasoning live follow (0.11.0 tail-follow)", () => {
  it("scrolls to the bottom when the tail window content changes, even at constant height", async () => {
    const { scroll } = draw(steps(5));
    let calls = 0;
    const scrollToEnd = () => { calls += 1; };
    (scroll.ref as { current: unknown }).current = { scrollToEnd };
    // 模拟窗口饱和后的 tick：内容换新但高度不变（不会触发 onContentSizeChange）。
    const grown = draw(steps(6));
    expect(grown.scroll.ref).toBeTruthy();
    (grown.scroll.ref as { current: unknown }).current = { scrollToEnd };
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBeGreaterThan(0);
  });

  it("does not yank the viewport when the user scrolled away from the bottom", async () => {
    const { scroll } = draw(steps(5));
    let calls = 0;
    const scrollToEnd = () => { calls += 1; };
    (scroll.ref as { current: unknown }).current = { scrollToEnd };
    // 用户向上滚离底部（handleScroll 置假），随后的内容变化不再回底。
    scroll.onScroll?.({ nativeEvent: { contentOffset: { y: 0, x: 0 }, contentSize: { height: 2000, width: 400 }, layoutMeasurement: { height: 300, width: 400 } } });
    draw(steps(6));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(0);
  });

  it("keeps following through a sustained 40-tick stream while near the bottom (long content)", async () => {
    // 长内容持续输出的真实形态：窗口早已饱和（40 步 > 20），每个 tick 高度近似不变——
    // 回底必须逐 tick 触发，停摆一次就算失败（修复前该场景为 0 次调用）。
    const { scroll } = draw(steps(20));
    let calls = 0;
    const scrollToEnd = () => { calls += 1; };
    (scroll.ref as { current: unknown }).current = { scrollToEnd };
    for (let count = 21; count <= 60; count += 1) {
      draw(steps(count));
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (calls < count - 20) break;
    }
    // 挂载那次会计入 1 次（同样合法）；关键是 40 个 tick 一次都不停摆。
    expect(calls).toBeGreaterThanOrEqual(40);
  });

  it("keeps the content-size growth path working (unsaturated window)", () => {
    const { scroll } = draw("只有一行");
    let calls = 0;
    const scrollToEnd = () => { calls += 1; };
    // 真实环境里 ScrollView 挂载后 ref.current 才有值——这里等价地在回调前挂上。
    (scroll.ref as { current: unknown }).current = { scrollToEnd };
    scroll.onContentSizeChange?.();
    expect(calls).toBe(1);
  });
});
