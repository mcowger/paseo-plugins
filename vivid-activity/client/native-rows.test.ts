import * as esbuild from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0.6.0 (opus-F49): on the iOS and Android apps a Text inside a row does not shrink unless told to (React Native's
 * flexShrink default is 0), so a long line runs past the row and the card clips it. These tests render the real
 * components once, statically (React, react-native and the host SDK replaced by stand-ins, no effects), and check the
 * texts that share a row with something else. The Yoga 3 measurements behind it are in the 2026-10-12 fix report.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const STANDINS: Record<string, string> = {
  react: `let __hooks = 0;
const __hookLog = [];
export const __hooksCount = () => __hooks;
export const __hooksReset = () => { __hooks = 0; __hookLog.length = 0; };
export const __hooksLog = () => __hookLog;
export const Fragment = Symbol.for("standin.fragment");
export const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } });
export const useState = (value) => { __hooks++; __hookLog.push("state"); return [typeof value === "function" ? value() : value, () => {}]; };
export const useMemo = (factory, deps) => { __hooks++; __hookLog.push("memo"); return factory(); };
export const useCallback = (callback, deps) => { __hooks++; __hookLog.push("callback"); return callback; };
export const useRef = (value) => { __hooks++; __hookLog.push("ref"); return { current: value }; };
export const useEffect = (fn, deps) => { __hooks++; __hookLog.push("effect"); };
export const useLayoutEffect = (fn, deps) => { __hooks++; __hookLog.push("layout"); };
export const useSyncExternalStore = (subscribe, snapshot) => { __hooks++; __hookLog.push("store"); return snapshot(); };
export const createContext = (value) => ({ Provider: "ContextProvider", _value: value });
export const useContext = (context) => context._value;
export default { Fragment, createElement, useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect, useSyncExternalStore, createContext, useContext };`,
  "react/jsx-runtime": `export const Fragment = Symbol.for("standin.fragment");
export const jsx = (type, props) => ({ type, props: props ?? {} });
export const jsxs = jsx;`,
  "react-native": `export const View = "View", Text = "Text", Pressable = "View", ScrollView = "ScrollView", Image = "Image", ActivityIndicator = "ActivityIndicator", TextInput = "View";
export const Platform = { OS: "android", select: (spec) => spec.android ?? spec.default };
export const StyleSheet = { create: (styles) => styles, hairlineWidth: 0.5, absoluteFillObject: {} };
class Value { constructor(value) { this.value = value; } interpolate() { return this; } }
const animation = () => ({ start() {}, stop() {} });
export const Animated = { Value, View: "View", timing: animation, spring: animation, loop: animation, sequence: animation, parallel: animation, delay: animation };
const curve = (t) => t;
export const Easing = { linear: curve, ease: curve, quad: curve, cubic: curve, sin: curve, in: () => curve, out: () => curve, inOut: () => curve, bezier: () => curve };
export const AppState = { currentState: "active", addEventListener: () => ({ remove() {} }) };
export const AccessibilityInfo = { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) };`,
  host: `export const Icon = "Icon", ScrollView = "ScrollView", Modal = "View", TextInput = "View";
export const useRevealedText = (text) => text;
export const copyText = async () => {};
export const useToast = () => ({ error() {} });
export const useAgent = () => undefined;
export const usePaseo = () => ({ agents: { ref: () => ({}) } });
export const useRpc = () => async () => ({});
export const useSettings = () => globalThis.__vividSettings ?? ({ status: "loading" });
export const defineRpc = (contract) => contract;
export const defineSettings = (definition) => definition;
export const settingsRpc = () => ({ read: {} });
export const SettingsSection = "SettingsSection";
export const SettingsCard = "SettingsCard";
export const SettingsRow = "SettingsRow";
export const SettingsSelect = "SettingsSelect";
export const SettingsSwitch = "SettingsSwitch";
export const SettingsInput = "SettingsInput";
export const SettingsAction = "SettingsAction";
export const SettingsGroup = "SettingsGroup";`,
};
const HOST_SPECIFIERS = ["@getpaseo/plugin", "@getpaseo/plugin/client", "@getpaseo/plugin/client/react-native", "@getpaseo/plugin/client/ui"];

type HostNode = { type: string; props: Record<string, unknown>; children: Host[] };
type Host = HostNode | { text: string };
type Element = { type: unknown; props: Record<string, unknown> } | string | number | boolean | null | undefined | Element[];

function render(element: Element): Host[] {
  if (element === null || element === undefined || typeof element === "boolean") return [];
  if (typeof element === "string" || typeof element === "number") return [{ text: String(element) }];
  if (Array.isArray(element)) return element.flatMap(render);
  if (typeof element.type === "function") return render((element.type as (props: unknown) => Element)(element.props));
  if (typeof element.type === "symbol") return render(element.props.children as Element);
  return [{ type: element.type as string, props: element.props, children: render(element.props.children as Element) }];
}
const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean).map(flatten)) : ((style as Record<string, unknown>) ?? {}));
const textOf = (node: Host): string => ("text" in node ? node.text : node.children.map(textOf).join(""));
/** Every [row, child] pair where the row lays out horizontally. */
function rowChildren(nodes: Host[]): Array<{ row: HostNode; child: HostNode }> {
  const out: Array<{ row: HostNode; child: HostNode }> = [];
  const visit = (node: Host) => {
    if ("text" in node) return;
    if (flatten(node.props.style).flexDirection === "row") for (const child of node.children) if (!("text" in child)) out.push({ row: node, child });
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

let dir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ui: any;
const theme = { colors: { surface0: "#101114", surface1: "#17181c", surface2: "#1f2026", surface3: "#2a2b31", foreground: "#ececf1", foregroundMuted: "#9a9aa5", border: "#2c2d33", accent: "#20744a" } };

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "vivid-native-rows-"));
  const entry = path.join(dir, "entry.ts");
  writeFileSync(entry, [
    // The separately bundled stand-in runtime has its own translator.
    `import ${JSON.stringify(path.join(here, "../tests/i18n-setup.ts"))};`,
    // 0.6.0-local.5: the reasoning body lives in the lazy details chunk, the styles stay with the resident rows.
    `export { useActivityStyles } from ${JSON.stringify(path.join(here, "activity.tsx"))};`,
    `export { ReasoningMarkdown } from ${JSON.stringify(path.join(here, "activity-details.tsx"))};`,
    `export { ReasoningText } from ${JSON.stringify(path.join(here, "activity-details.tsx"))};`,
    `export { VividHeader, resolveVividPalette, useVividText } from ${JSON.stringify(path.join(here, "vivid.tsx"))};`,
    `export { PiSubagentLifecycleSummary } from ${JSON.stringify(path.join(here, "pi-subagent-summary.tsx"))};`,
    `export { OmpWaitTextDetail } from ${JSON.stringify(path.join(here, "omp-wait-text.tsx"))};`,
    `export { densityMetrics } from ${JSON.stringify(path.join(here, "density.ts"))};`,
    `export { PinnedPromptView } from ${JSON.stringify(path.join(here, "prompt-pin.tsx"))};`,
    // 0.6.0-local.5 (codex-vivid-merge-F2): a whole tool row, and the Pi notice data it draws.
    `export { ColorfulToolCall, PiReaderRetry } from ${JSON.stringify(path.join(here, "activity.tsx"))};`,
    `export { ColorfulReasoning } from ${JSON.stringify(path.join(here, "activity.tsx"))};`,
    `export { retryPiNotices } from ${JSON.stringify(path.join(here, "transform.ts"))};`,
    `export { createToolCallData, setPiNoticePhase, setPiNoticeReader, createReasoningData } from ${JSON.stringify(path.join(here, "../shared/timeline.ts"))};`,
    `export { readPiNotice } from ${JSON.stringify(path.join(here, "../shared/pi-notice.ts"))};`,
    // 0.8.0: running animations, the change list of an expanded summary, and the summary's diffstat and turn tokens.
    `export { LoaderFrame } from ${JSON.stringify(path.join(here, "loaders.tsx"))};`,
    `export { FoldChanges } from ${JSON.stringify(path.join(here, "fold-changes.tsx"))};`,
    `export { ChangeStat, TurnTokens } from ${JSON.stringify(path.join(here, "fold-row.tsx"))};`,
    `export { FoldRow } from ${JSON.stringify(path.join(here, "fold-row.tsx"))};`,
    `export { DiffBlock } from ${JSON.stringify(path.join(here, "activity-details.tsx"))};`,
    `export { PreviewPanel } from ${JSON.stringify(path.join(here, "settings-preview-rows.tsx"))};`,
    `export { DisplaySettings } from ${JSON.stringify(path.join(here, "settings.tsx"))};`,
    `export { activitySettings } from ${JSON.stringify(path.join(here, "../shared/settings.ts"))};`,
    `export { CommandTokens } from ${JSON.stringify(path.join(here, "command-tokens.tsx"))};`,
    `export { configureFx } from ${JSON.stringify(path.join(here, "fx.ts"))};`,
    `export { __hooksCount, __hooksReset, __hooksLog } from "react";`,
    `export { paletteFor } from ${JSON.stringify(path.join(here, "activity.tsx"))};`,
    `export { stillCells } from ${JSON.stringify(path.join(here, "../shared/loaders.ts"))};`,
    `export { fileId } from ${JSON.stringify(path.join(here, "../shared/changes.ts"))};`,
  ].join("\n"));
  const result = await esbuild.build({
    entryPoints: [entry], bundle: true, format: "esm", platform: "node", write: false, jsx: "automatic", logLevel: "silent",
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
  ui = await import(pathToFileURL(file).href);
}, 60_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("rows on the phone apps: long text shrinks instead of running off the row (opus-F49)", () => {
  const styles = () => ui.useActivityStyles(theme, ui.resolveVividPalette(theme), ui.densityMetrics("compact", true, true));

  it("renders wait result markdown and running metadata without raw wrappers", () => {
    const palette = ui.resolveVividPalette(theme);
    const props = { theme, palette, styles: styles() };
    const result = render({ type: ui.OmpWaitTextDetail, props: { ...props, model: { kind: "result", entries: [{ id: "Scout", agent: "scout", status: "completed", duration: "26s", output: "**Summary**\n- Found the answer" }] } } });
    const running = render({ type: ui.OmpWaitTextDetail, props: { ...props, model: { kind: "running", entries: [{ id: "Scout", agent: "task", duration: "15s", metadata: ["5 req", "ctx 9K"] }] } } });
    expect(result.map(textOf).join(" ")).toContain("Found the answer");
    expect(result.map(textOf).join(" ")).not.toContain("<task-result");
    expect(running.map(textOf).join(" ")).toContain("5 req");
  });

  it("lets a reasoning list item shrink next to its marker, and the marker grow for 「10.」", () => {
    const text = `- ${"很长的一条说明".repeat(20)}\n10. 第十条`;
    const rows = rowChildren(render({ type: ui.ReasoningMarkdown, props: { text, theme, styles: styles() } }));
    const items = rows.filter(({ child }) => child.type === "Text" && textOf(child).startsWith("很长") || textOf(child) === "第十条");
    expect(items).toHaveLength(2);
    for (const { child } of items) expect(flatten(child.props.style)).toMatchObject({ flexShrink: 1, flexGrow: 1, minWidth: 0 });
    const markers = rows.filter(({ child }) => textOf(child) === "•" || textOf(child) === "10.");
    expect(markers).toHaveLength(2);
    for (const { child } of markers) {
      const style = flatten(child.props.style);
      expect(style).toMatchObject({ flexShrink: 0, minWidth: 14 });
      expect(style.width).toBeUndefined();
    }
  });

  it("lets Pi's usage line wrap beside its state pill", () => {
    const output = "Agent: c1060d595b3f\nType: worker | Status: completed | Tool uses: 135 | 169.4k token | Context: 16% | Duration: 453.8s\nDescription: x\n\nbody";
    const rows = rowChildren(render({ type: ui.PiSubagentLifecycleSummary, props: { toolName: "subagent", input: undefined, output, theme, palette: ui.resolveVividPalette(theme), styles: styles() } }));
    const usage = rows.find(({ child }) => textOf(child).includes("次工具调用"));
    expect(usage).toBeDefined();
    expect(flatten(usage!.child.props.style).flexShrink).toBe(1);
  });

  it("keeps a row header's title from pushing the row off the screen, and shrinks the summary before it", () => {
    const text = ui.useVividText(theme);
    // codex-vivid-F3: the title gives way too, last; a long one stops at 240 px so the summary keeps room on wide rows.
    expect(text.label).toMatchObject({ flexShrink: 1, minWidth: 0, maxWidth: 240 });
    expect(text.fileBase).toMatchObject({ maxWidth: "100%" });
    expect(text.summary.flexShrink).toBeGreaterThanOrEqual(100 * text.label.flexShrink);
    expect(text.metaText.flexShrink).toBeGreaterThan(text.label.flexShrink);
    expect(text.meta.flexShrink).toBe(0);
    const all = styles();
    expect(all.title).toMatchObject({ flexShrink: 0, maxWidth: "50%" });
    expect(all.fileName).toMatchObject({ maxWidth: "100%" });
  });

  it("lets raw tool names, list metadata and long field names shrink in their rows", () => {
    const all = styles();
    expect(all.subAgentActionLabel).toMatchObject({ flexShrink: 1, maxWidth: "60%" });
    expect(all.childTimelineItemTitle).toMatchObject({ flexShrink: 1, maxWidth: "60%" });
    expect(all.paseoListItemMeta.flexShrink).toBe(1);
    expect(all.paseoKey).toMatchObject({ flexShrink: 1, maxWidth: "45%" });
  });
});

/** Every node inside `node` (itself included). */
function nodesOf(node: Host): HostNode[] {
  if ("text" in node) return [];
  return [node, ...node.children.flatMap(nodesOf)];
}

/**
 * Natural width of a part that keeps its size, with the fonts of the Yoga run in the 2026-10-12 fix report (a CJK
 * character 1 em, any other 0.55 em, 0.6 em in monospace): explicit widths, text, icons, and rows of those with their gaps.
 */
function naturalWidth(node: Host): number {
  if ("text" in node) return 0;
  const style = flatten(node.props.style);
  if (typeof style.width === "number") return style.width;
  if (node.type === "Icon") return Number(node.props.size ?? 12);
  const padding = Number(style.paddingHorizontal ?? 0) * 2 + Number(style.paddingLeft ?? 0) + Number(style.paddingRight ?? 0);
  if (node.type === "Text") {
    const size = Number(style.fontSize ?? 14);
    const em = style.fontFamily === "monospace" ? 0.6 : 0.55;
    return padding + Array.from(textOf(node)).reduce((sum, ch) => sum + (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? size : size * em), 0);
  }
  const parts = node.children.filter((child) => !("text" in child) && flatten((child as HostNode).props.style).position !== "absolute");
  const widths = parts.map(naturalWidth);
  const across = style.flexDirection === "row";
  return padding + (across ? widths.reduce((sum, width) => sum + width, 0) + Number(style.gap ?? 0) * Math.max(0, parts.length - 1) : Math.max(0, ...widths));
}

describe("a narrow phone row keeps its state on screen (codex-vivid-F3)", () => {
  // The review's case: a 320 px row, title 「Summarize changelog」 (a real ACP tool title), timing formatDuration(80 000).
  const WIDTH = 320;
  const metrics = () => ui.densityMetrics("compact", true, true);
  const header = (status: string, extra: Record<string, unknown> = {}) =>
    render({
      type: ui.VividHeader,
      props: {
        theme, compact: true, look: "other", title: "Summarize changelog", summary: "query: build the index", status, timing: "1 分 20 秒",
        expanded: false, expandable: true, chevronColor: "#888", onPress() {}, dirText: (dir: string) => dir, metrics: metrics(),
        Pressable: ({ children, style }: { children: unknown; style: unknown }) => ({ type: "View", props: { style, children } }),
        ...extra,
      },
    });

  for (const [status, extra] of [["waiting", {}], ["failed", {}], ["failed", { look: "shell", statusText: "退出码 127", stats: { additions: 12, deletions: 3 } }]] as const) {
    it(`${status}${"statusText" in extra ? "（退出码与改动）" : ""}: only the words give way; the pill, timing, state and chevron keep their width and fit`, () => {
      const [frame] = header(status, extra) as HostNode[];
      const row = frame!.children.find((child): child is HostNode => !("text" in child) && flatten(child.props.style).flexDirection === "row")!;
      const parts = row.children.filter((child): child is HostNode => !("text" in child));
      const words = parts.find((part) => textOf(part).startsWith("Summarize changelog"))!;
      expect(flatten(words.props.style)).toMatchObject({ flexDirection: "row", flexGrow: 1, flexShrink: 1, minWidth: 0 });
      expect(textOf(words)).toBe("Summarize changelogquery: build the index");
      for (const text of words.children.filter((child): child is HostNode => !("text" in child))) {
        const style = flatten(text.props.style);
        expect(style.minWidth).toBe(0);
        expect(Number(style.flexShrink)).toBeGreaterThanOrEqual(1);
      }
      // Everything else in the row keeps its width (React Native's flexShrink default is 0).
      const fixed = parts.filter((part) => part !== words);
      for (const part of fixed) expect(Number(flatten(part.props.style).flexShrink ?? 0)).toBe(0);
      expect(fixed.some((part) => textOf(part) === "1 分 20 秒")).toBe(true);
      expect(fixed.some((part) => textOf(part) === ("statusText" in extra ? "退出码 127" : status === "waiting" ? "等你批准" : "失败"))).toBe(true);
      expect(fixed.at(-1)!.type).toBe("Icon");
      // And they fit in 320 px with room left for the words: tile, pill, timing, state mark, chevron, gaps and paddings.
      const rowStyle = flatten(row.props.style);
      const frameStyle = flatten(frame!.props.style);
      const used = fixed.reduce((sum, part) => sum + naturalWidth(part), 0) + Number(rowStyle.gap) * (parts.length - 1) + Number(rowStyle.paddingRight ?? 0) + Number(frameStyle.paddingLeft ?? 0);
      expect(used).toBeLessThan(WIDTH - 40);
    });
  }
});

describe("the pinned question on the phone apps (grok-B2)", () => {
  const view = (text: string) => render({ type: ui.PinnedPromptView, props: { title: "本轮提问", text, truncated: false, theme, mode: "vivid", metrics: ui.densityMetrics("compact", true, true) } });

  it("shows three lines of a long question behind a 「展开全部」 button, with the copy button beside it, not inside", () => {
    const tree = view(["第一行：先把失败的测试修好", "第二行：然后跑一遍全部测试", "第三行：最后更新 CHANGELOG", "第四行：不要改依赖"].join("\n"));
    const all = tree.flatMap(nodesOf);
    const buttons = all.filter((node) => node.props.accessibilityRole === "button");
    expect(buttons.map((node) => textOf(node))).toEqual(["复制", expect.stringContaining("展开全部")]);
    // No button holds another one (react-native-web draws each as a <button>).
    for (const button of buttons) expect(button.children.flatMap(nodesOf).some((inner) => inner !== button && inner.props.accessibilityRole === "button")).toBe(false);
    const body = all.find((node) => node.type === "Text" && textOf(node).startsWith("第一行"));
    expect(body?.props.numberOfLines).toBe(3);
    expect(buttons[1]!.props["aria-expanded"]).toBe(false);
    // The title shares its row with the copy button: it may shrink, the button may not.
    const title = rowChildren(tree).find(({ child }) => textOf(child) === "本轮提问");
    expect(flatten(title!.child.props.style)).toMatchObject({ flexShrink: 1, minWidth: 0 });
    expect(flatten(buttons[0]!.props.style).flexShrink).toBe(0);
  });

  it("shows a short question as it is, selectable, without a toggle", () => {
    const all = view("把 README 翻成英文").flatMap(nodesOf);
    expect(all.filter((node) => node.props.accessibilityRole === "button").map((node) => textOf(node))).toEqual(["复制"]);
    const body = all.find((node) => node.type === "Text" && textOf(node) === "把 README 翻成英文");
    expect(body?.props).toMatchObject({ selectable: true });
    expect(body?.props.numberOfLines).toBeUndefined();
  });
});

describe("a Pi notice drawn without its reader (0.6.0-local.5, codex-vivid-merge-F2)", () => {
  // Rows the 0.11.1 host builds from Pi extension messages; Paseo marks every one of them completed.
  const fixtures = JSON.parse(readFileSync(path.resolve(here, "../test-fixtures/pi-notices-0.11.1.json"), "utf8")) as { rows: Array<{ name: string; row: Record<string, unknown> }> };
  const rowOf = (name: string) => structuredClone(fixtures.rows.find((entry) => entry.name === name)!.row);
  const MARKS = ["Check", "X", "CircleCheck", "CircleX", "CircleSlash2", "LoaderCircle", "Hand"];
  const PALETTES = [undefined, { status: "ready", values: { palette: "soft", expansion: {}, density: "compact", pinPrompt: false } }];
  const icons = (nodes: Host[]): string[] => nodes.flatMap((node) => ("text" in node ? [] : [...(node.type === "Icon" ? [String(node.props.name)] : []), ...icons(node.children)]));
  function draw(row: Record<string, unknown>, settings: unknown) {
    (globalThis as { __vividSettings?: unknown }).__vividSettings = settings;
    try {
      const data = ui.createToolCallData(row);
      // The other palettes read the status colours of the host theme too.
      const full = { colors: { ...theme.colors, accentForeground: "#ffffff", statusSuccess: "#3fb950", statusWarning: "#d29922", statusDanger: "#f85149" } };
      const props = { agentId: "agent-pi", item: { kind: "vivid-tool-call", data }, theme: full, timestamp: new Date(0), layout: { compact: false, platform: "web" } };
      const nodes = render({ type: ui.ColorfulToolCall, props });
      return { text: nodes.map(textOf).join(" "), marks: icons(nodes).filter((name) => MARKS.includes(name)) };
    } finally {
      (globalThis as { __vividSettings?: unknown }).__vividSettings = undefined;
    }
  }

  it.each(["bg-failed", "bg-killed"])("shows a real %s notice neutral after the download failed, in the vivid and the other palettes", (name) => {
    ui.setPiNoticePhase("failed");
    try {
      for (const settings of PALETTES) {
        const row = draw(rowOf(name), settings);
        expect(row.text).toContain("Pi 通知");
        expect(row.text).toContain("没能读取，点开看原文");
        expect(row.text).not.toMatch(/完成|失败|已停止|background-task-notification/);
        expect(row.marks).toEqual([]);
      }
    } finally {
      ui.setPiNoticePhase("idle");
    }
  });

  it("would show the host's completed mark on an ordinary tool row, and the notice's own state once the reader is here", () => {
    // The check above is not vacuous: the same message as an ordinary tool row carries the host's completed mark…
    const ordinary = { ...rowOf("bg-failed"), metadata: undefined };
    for (const settings of PALETTES) expect(draw(ordinary, settings).marks.length).toBeGreaterThan(0);
    // …and with the reader the failed task carries its own (failed) mark.
    ui.setPiNoticeReader(ui.readPiNotice);
    try {
      expect(draw(rowOf("bg-failed"), undefined).marks).toEqual(["X"]);
    } finally {
      ui.setPiNoticeReader(null);
    }
  });

  it("offers 「重新读取」, which tries the download again", () => {
    const button = render({ type: ui.PiReaderRetry, props: { theme } }).flatMap(function find(node: Host): HostNode[] {
      return "text" in node ? [] : [...(node.props.accessibilityRole === "button" ? [node] : []), ...node.children.flatMap(find)];
    });
    expect(button).toHaveLength(1);
    expect(button[0]!.props.accessibilityLabel).toBe("重新读取 Pi 通知");
    expect(button[0]!.props.onPress).toBe(ui.retryPiNotices);
    expect(textOf(button[0]!)).toBe("重新读取");
  });
});

describe("0.8.0: running animations, the change summary and the turn's tokens", () => {
  const nodes = (element: Element) => render(element);
  const all = (hosts: Host[]): HostNode[] => hosts.flatMap(function walk(node: Host): HostNode[] {
    return "text" in node ? [] : [node, ...node.children.flatMap(walk)];
  });

  it("rests on one frame under reduced motion and moves every layer otherwise", () => {
    const frame = (kind: string, state: string) => nodes({ type: ui.LoaderFrame, props: { kind, size: 16, color: "#60A5FA", state } });
    // Sparkle: the full star alone when still; all six glyph layers, each driven by the loop, when moving.
    expect(all(frame("sparkle", "static")).filter((node) => node.type === "Text").map(textOf)).toEqual(["✻"]);
    const moving = all(frame("sparkle", "run")).filter((node) => node.type === "Text").map((node) => textOf(node).replace("︎", ""));
    expect(moving).toEqual(["·", "✢", "✳", "✶", "✻", "✽"]);
    // Orb: the ball alone when still, the ball and its glow ring when moving.
    expect(all(frame("orb", "static")).filter((node) => node.type === "View")).toHaveLength(2);
    expect(all(frame("orb", "run")).filter((node) => node.type === "View")).toHaveLength(3);
    // Dot grid: nine dots; still, they keep the frozen frame's opacities.
    const still = all(frame("snake", "static")).filter((node) => flatten(node.props.style).borderRadius !== undefined);
    expect(still.map((node) => flatten(node.props.style).opacity)).toEqual(ui.stillCells("snake"));
    const twinkle = all(frame("matrix", "run")).filter((node) => flatten(node.props.style).borderRadius !== undefined);
    expect(twinkle).toHaveLength(9);
    for (const dot of twinkle) expect(flatten(dot.props.style).transform).toBeDefined();
    // Decorative: the row's own label says it is running.
    for (const kind of ["sparkle", "orb", "snake"]) expect(frame(kind, "run")[0]).toMatchObject({ props: { accessibilityElementsHidden: true } });
  });

  it("shows 「N 个文件 +A −R」 and five blocks on wide rows, the numbers and blocks on phones", () => {
    const wide = nodes({ type: ui.ChangeStat, props: { theme, files: 3, added: 12, removed: 4, compact: false, lineHeight: 16 } });
    expect(textOf({ type: "View", props: {}, children: wide })).toBe("3 个文件+12−4");
    const phone = nodes({ type: ui.ChangeStat, props: { theme, files: 3, added: 12, removed: 0, compact: true, lineHeight: 16 } });
    expect(textOf({ type: "View", props: {}, children: phone })).toBe("+12");
    const blocks = all(phone).filter((node) => node.props.accessibilityElementsHidden === true)[0]!;
    expect(blocks.children).toHaveLength(5);
    // Changes whose lines are not known: said apart, never added in; alone when nothing was counted.
    const more = nodes({ type: ui.ChangeStat, props: { theme, files: 2, added: 5, removed: 1, uncounted: 1, compact: false, lineHeight: 16 } });
    expect(textOf({ type: "View", props: {}, children: more })).toBe("2 个文件+5−1另 1 处未计");
    const only = nodes({ type: ui.ChangeStat, props: { theme, files: 0, added: 0, removed: 0, uncounted: 2, compact: true, lineHeight: 16 } });
    expect(textOf({ type: "View", props: {}, children: only })).toBe("2 处改动未计行数");
    expect(all(only).some((node) => node.props.accessibilityElementsHidden === true)).toBe(false);
  });

  it("writes the turn's tokens short and reads them out in full", () => {
    const line = nodes({ type: ui.TurnTokens, props: { theme, tokens: { id: "t1", i: 12_345, c: 80_123, o: 2_400 }, indent: 30 } })[0] as HostNode;
    expect(line.props.accessibilityLabel).toBe("本轮：输入 12,345，缓存 80,123，输出 2,400");
    expect(textOf(line)).toBe("本轮  输入 12k · 缓存 80k · 输出 2.4k");
    const noCache = nodes({ type: ui.TurnTokens, props: { theme, tokens: { id: "t1", i: 300, c: null, o: 40, live: true }, indent: 30 } })[0] as HostNode;
    expect(textOf(noCache)).toBe("本轮  输入 300 · 输出 40");
  });

  it("lists changed files and failed commands, letting long names shrink", () => {
    const item = (key: string) => ({
      "t:edit": { type: "tool_call", callId: "edit", name: "Edit", status: "completed", error: null, detail: { type: "edit", filePath: "/home/user/demo-app/src/very/deep/folder/component-with-a-long-name.tsx", oldString: "a", newString: "b" } },
      "t:bash": { type: "tool_call", callId: "bash", name: "Bash", status: "failed", error: "Exit code 1", detail: { type: "shell", command: "cd /home/user/demo-app && npm test -- --run\necho done" } },
    } as Record<string, unknown>)[key] ?? null;
    const list = nodes({ type: ui.FoldChanges, props: {
      theme, lineHeight: 16, indent: 30, cwd: "/home/user/demo-app", files: 3, item,
      changed: [{ key: "t:edit", file: ui.fileId("src/very/deep/folder/component-with-a-long-name.tsx"), added: 1, removed: 1 }, { key: "t:edit", file: "unknown", added: 9, removed: 0 }],
      fails: [{ key: "t:bash", exit: 1 }, { key: "t:gone", exit: 2 }],
    } });
    const text = textOf({ type: "View", props: {}, children: list });
    expect(text).toContain("…/deep/folder/component-with-a-long-name.tsx+1−1");
    const base = all(list).find((node) => node.type === "Text" && textOf(node) === "component-with-a-long-name.tsx")!;
    const dir = all(list).find((node) => node.type === "Text" && textOf(node) === "…/deep/folder/")!;
    expect(flatten(base.props.style)).toMatchObject({ flexShrink: 0, maxWidth: "100%" });
    expect(flatten(dir.props.style)).toMatchObject({ flexShrink: 1 });
    // A file whose row is no longer kept, and the one beyond the list, are counted, not named.
    expect(text).toContain("还有 2 个文件");
    expect(text).toContain("$ npm test -- --run");
    expect(text).toContain("退出码 1");
    expect(text).not.toContain("退出码 2");
  });
});

describe("0.11.0: 淡出强度 (strength)", () => {
  // 命令着色的组件在 fx 懒加载块：测试里用同步 loader 直接供给（peek 不经下载）。
  beforeAll(() => {
    const surfaces = { CommandTokens: ui.CommandTokens };
    ui.configureFx({ peek: () => surfaces, load: async () => surfaces });
  });
  // 非 vivid 调色板读 host 主题的状态色（与上面的 Pi 用例同一个完整主题）。
  const fullTheme = { colors: { ...theme.colors, accentForeground: "#ffffff", statusSuccess: "#3fb950", statusWarning: "#d29922", statusDanger: "#f85149" } };
  const ready = (strength: string) => ({ status: "ready", values: { expansion: {}, density: "compact", strength }, revision: 1 });
  const withSettings = (settings: unknown, draw: () => Host[]) => {
    (globalThis as { __vividSettings?: unknown }).__vividSettings = settings;
    try {
      return draw();
    } finally {
      (globalThis as { __vividSettings?: unknown }).__vividSettings = undefined;
    }
  };
  const cardStyle = (nodes: Host[]) => {
    const card = nodes[0] as HostNode; // render() 的首节点是卡片外层 View
    return flatten(card.props.style);
  };
  const tool = (status: string, settings: unknown) =>
    withSettings(settings, () => render({ type: ui.ColorfulToolCall, props: { agentId: "a-strength", item: { kind: "colorful-tool-call", data: ui.createToolCallData({ type: "tool_call", callId: "t1", name: "Bash", status, error: null, detail: { type: "shell", command: "npm test" } }) }, theme: fullTheme, timestamp: new Date(0), layout: { compact: false, platform: "web" } } }));
  const think = (phase: "streaming" | "complete", settings: unknown) =>
    withSettings(settings, () => render({ type: ui.ColorfulReasoning, props: { agentId: "a-strength", item: { kind: "colorful-reasoning", data: ui.createReasoningData({ type: "reasoning", text: "two steps" }, phase) }, theme: fullTheme, timestamp: new Date(0), layout: { compact: false, platform: "web" } } }));

  it("fades a finished row at the chosen strength, failures included", () => {
    expect(cardStyle(tool("completed", ready("faded"))).opacity).toBe(0.45);
    expect(cardStyle(tool("completed", ready("dim"))).opacity).toBe(0.3);
    expect(cardStyle(tool("completed", ready("soft"))).opacity).toBe(0.65);
    expect(cardStyle(tool("failed", ready("dim"))).opacity).toBe(0.3);
    expect(cardStyle(think("complete", ready("faded"))).opacity).toBe(0.45);
  });

  it("keeps running and streaming rows at full strength", () => {
    expect(cardStyle(tool("running", ready("dim"))).opacity).toBeUndefined();
    expect(cardStyle(think("streaming", ready("dim"))).opacity).toBeUndefined();
  });

  it("stays at full strength on 「全强度」, when settings are unread, and keeps expandable-only fading consistent", () => {
    expect(cardStyle(tool("completed", ready("full"))).opacity).toBeUndefined();
    // Settings still loading: the default is full, nothing fades.
    expect(cardStyle(tool("completed", undefined)).opacity).toBeUndefined();
  });

  it("never fades a row without expandable content: its hover and focus cannot restore it (disabled Pressable swallows them)", () => {
    const bare = withSettings(ready("dim"), () => render({ type: ui.ColorfulToolCall, props: { agentId: "a-strength", item: { kind: "colorful-tool-call", data: ui.createToolCallData({ type: "tool_call", callId: "t1", name: "PaseoStatus", status: "completed", error: null, detail: { type: "unknown", output: "" } }) }, theme: fullTheme, timestamp: new Date(0), layout: { compact: false, platform: "web" } } }));
    expect(cardStyle(bare).opacity).toBeUndefined();
  });

  it("fades a finished fold summary too; the expanded one and a running segment header stay full", () => {
    const foldRow = (over: Record<string, unknown>, settings: unknown) =>
      withSettings(settings, () => render({ type: ui.FoldRow, props: { agentId: "a-strength", item: { kind: "colorful-fold", data: { segment: "s1", mode: "done", expanded: false, steps: 4, hidden: 0, counts: [["shell", 2], ["think", 2]], failed: 0, canceled: 0, durationMs: 38000, ...over } }, theme: fullTheme, timestamp: new Date(0), layout: { compact: false, platform: "web" } } }));
    expect(cardStyle(foldRow({}, ready("dim"))).opacity).toBe(0.3);
    expect(cardStyle(foldRow({ expanded: true }, ready("dim"))).opacity).toBeUndefined();
    // 运行中的段头（「前面 N 步」）代表还在进行的活动：不淡。
    expect(cardStyle(foldRow({ mode: "earlier", durationMs: null }, ready("dim"))).opacity).toBeUndefined();
    expect(cardStyle(foldRow({}, ready("full"))).opacity).toBeUndefined();
  });
});

describe("0.11.0: diff 折行与命令着色", () => {
  // 命令着色的组件在 fx 懒加载块：测试里用同步 loader 直接供给（peek 不经下载）。
  const fullTheme = { colors: { ...theme.colors, accentForeground: "#ffffff", statusSuccess: "#3fb950", statusWarning: "#d29922", statusDanger: "#f85149" } };
  const ready = (values: Record<string, unknown>) => ({ status: "ready", values: { expansion: {}, density: "compact", ...values }, revision: 1 });
  const withSettings = (settings: unknown, draw: () => Host[]) => {
    (globalThis as { __vividSettings?: unknown }).__vividSettings = settings;
    try {
      return draw();
    } finally {
      (globalThis as { __vividSettings?: unknown }).__vividSettings = undefined;
    }
  };
  beforeAll(() => {
    const surfaces = { CommandTokens: ui.CommandTokens };
    ui.configureFx({ peek: () => surfaces, load: async () => surfaces });
  });

  it("keeps diff lines on one scrolling row by default and wraps them to the width when asked", () => {
    const detail = { type: "edit", filePath: "/demo/src/app.ts", oldString: `const a = ${"很长的一行。".repeat(30)}\nconst b = 1;`, newString: "const a = 1;\nconst b = 2;" };
    const diffStyles = () => ui.useActivityStyles(fullTheme, ui.resolveVividPalette(fullTheme), ui.densityMetrics("compact", true, true));
    const draw = (settings: unknown) => withSettings(settings, () => render({
      type: ui.DiffBlock,
      props: { detail, palette: ui.resolveVividPalette(fullTheme), styles: diffStyles() },
    }));
    const scrollsHorizontally = (nodes: Host[]) => nodes.flatMap(nodesOf).some((node) => node.type === "ScrollView" && node.props.horizontal === true);
    // marker（「+」）是独立 Text；行内容 Text 紧随其后。
    const lineText = (nodes: Host[]) => {
      const flat = nodes.flatMap(nodesOf);
      const marker = flat.findIndex((node) => node.type === "Text" && textOf(node) === "+");
      return marker >= 0 ? (flat[marker + 1] as HostNode) : undefined;
    };
    // 默认 off：diff 行单行横滚（ScrollView horizontal），文字不折（flexShrink 0）。
    expect(scrollsHorizontally(draw(undefined))).toBe(true);
    expect(flatten(lineText(draw(undefined))!.props.style).flexShrink).toBe(0);
    // on：不再横滚，diff 文字折行（flexShrink 1 + minWidth 0）。
    const on = ready({ wrapLines: { diff: true, code: false, output: false } });
    expect(scrollsHorizontally(draw(on))).toBe(false);
    expect(flatten(lineText(draw(on))!.props.style)).toMatchObject({ flexShrink: 1, minWidth: 0 });
  });

  it("colors the shell command in the title when always, leaves it plain while collapsed by default", () => {
    const shell = (settings: unknown) => withSettings(settings, () => render({ type: ui.ColorfulToolCall, props: { agentId: "a-strength", item: { kind: "colorful-tool-call", data: ui.createToolCallData({ type: "tool_call", callId: "t1", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "npm ci --omit=dev && npm test" } }) }, theme: fullTheme, timestamp: new Date(0), layout: { compact: false, platform: "web" } } }));
    // 非前景/弱化色（语法 token 色）的 Text = 着色段；计数、计时等常规文本用 foregroundMuted，不算。
    const spans = (nodes: Host[]) => nodes.flatMap(nodesOf).filter((node) => {
      if (node.type !== "Text") return false;
      const style = flatten(node.props.style);
      const color = style.color as string | undefined;
      return !!color && color !== fullTheme.colors.foreground && color !== fullTheme.colors.foregroundMuted;
    });
    const collapsedDefault = spans(shell(ready({ expansion: { shell: "never" } })));
    expect(collapsedDefault).toHaveLength(0);
    const always = spans(shell(ready({ expansion: { shell: "never" }, commandColors: "always" })));
    expect(always.length).toBeGreaterThan(1);
    // 展开时（默认 expanded 档）也着色。
    const expandedDefault = spans(shell(ready({ expansion: { shell: "always" } })));
    expect(expandedDefault.length).toBeGreaterThan(1);
  });
});

describe("0.11.0: 工具明细区只在运行中跟随（跟随矩阵）", () => {
  const fullTheme = { colors: { ...theme.colors, accentForeground: "#ffffff", statusSuccess: "#3fb950", statusWarning: "#d29922", statusDanger: "#f85149" } };
  const ready = (values: Record<string, unknown>) => ({ status: "ready", values: { expansion: { shell: "always" }, density: "compact", ...values }, revision: 1 });
  const output = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");
  /** Draws an expanded shell row and fires its detail ScrollView's onContentSizeChange (RN fires it on first layout too). */
  const scrollsOnLayout = (status: string, values: Record<string, unknown> = {}) => {
    (globalThis as { __vividSettings?: unknown }).__vividSettings = ready(values);
    try {
      const nodes = render({ type: ui.ColorfulToolCall, props: { agentId: "a-follow", item: { kind: "colorful-tool-call", data: ui.createToolCallData({ type: "tool_call", callId: "f1", name: "Bash", status, error: null, detail: { type: "shell", command: "npm test", output } }) }, theme: fullTheme, timestamp: new Date(0), layout: { compact: false, platform: "web" } } });
      const scroll = nodes.flatMap(nodesOf).find((node) => node.type === "ScrollView" && typeof node.props.onContentSizeChange === "function");
      expect(scroll).toBeDefined();
      let calls = 0;
      (scroll!.props.ref as { current: unknown }).current = { scrollToEnd: () => { calls += 1; } };
      (scroll!.props.onContentSizeChange as () => void)();
      return calls;
    } finally {
      (globalThis as { __vividSettings?: unknown }).__vividSettings = undefined;
    }
  };

  it("opens a finished row's long details at the top, with every follow switch on (the default)", () => {
    expect(scrollsOnLayout("completed")).toBe(0);
    expect(scrollsOnLayout("failed")).toBe(0);
  });

  it("keeps a running row's details at the bottom while its area follows, and lets the switch turn that off", () => {
    expect(scrollsOnLayout("running")).toBe(1);
    expect(scrollsOnLayout("running", { followOutput: { shell: false, logs: true, todo: true, browser: true } })).toBe(0);
  });
});

describe("0.11.0: 思考行尾随窗口", () => {
  const fullTheme = { colors: { ...theme.colors, accentForeground: "#ffffff", statusSuccess: "#3fb950", statusWarning: "#d29922", statusDanger: "#f85149" } };
  const palette = () => ui.resolveVividPalette(fullTheme);
  const styles = () => ui.useActivityStyles(fullTheme, palette(), ui.densityMetrics("compact", true, true));
  const ready = (values: Record<string, unknown>) => ({ status: "ready", values: { expansion: {}, density: "compact", ...values }, revision: 1 });
  const withSettings = (settings: unknown, draw: () => Host[]) => {
    (globalThis as { __vividSettings?: unknown }).__vividSettings = settings;
    try {
      return draw();
    } finally {
      (globalThis as { __vividSettings?: unknown }).__vividSettings = undefined;
    }
  };
  const draw = (text: string, settings: unknown) => withSettings(settings, () => render({ type: ui.ReasoningText, props: { text, phase: "complete", theme: fullTheme, palette: palette(), styles: styles() } }));
  const outputOf = (nodes: Host[]) => nodes.map(textOf).join("\n");
  const expandButton = (nodes: Host[]) => nodes.flatMap(nodesOf).find((node) => node.type === "Text" && textOf(node).startsWith("展开全部"));

  it("keeps the head frozen by default: new lines stay out until 展开全部 is pressed", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `第${index + 1}行`);
    const out = outputOf(draw(lines.join("\n"), undefined));
    expect(out).toContain("第1行");
    expect(out).not.toContain("第40行");
    expect(expandButton(draw(lines.join("\n"), undefined))).toBeDefined();
  });

  it("follows the tail in block mode: the newest lines are in and the head is out", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `第${index + 1}行`);
    const out = outputOf(draw(lines.join("\n"), ready({ thoughtTailFollow: true, thoughtTailLines: 10 })));
    expect(out).not.toContain("第1行");
    expect(out).toContain("第40行");
    expect(out).toContain("第31行");
    expect(out).not.toContain("第30行");
    // 窗口装不下全量时，「展开全部」仍在。
    expect(expandButton(draw(lines.join("\n"), ready({ thoughtTailFollow: true, thoughtTailLines: 10 })))).toBeDefined();
  });

  it("windows whole steps and keeps their original numbers", () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `第${index + 1}步的内容`);
    const out = outputOf(draw(paragraphs.join("\n\n"), ready({ thoughtTailFollow: true, thoughtTailLines: 5 })));
    // 无粗体标题的步骤只显示「第 N 步」标签（ui.step），正文单独渲染。
    expect(out).toContain("第 8 步");
    expect(out).toContain("第8步的内容");
    expect(out).toContain("第 12 步");
    expect(out).toContain("第12步的内容");
    // 只渲染尾窗 5 步：头部步骤的正文与越界序号都不得出现。
    expect(out).not.toContain("第1步的内容");
    expect(out).not.toContain("第7步的内容");
    expect(out).not.toContain("第 7 步");
    expect(out).not.toContain("第 19 步");
  });

  it("marks the newest global step active while streaming, never an older windowed one", () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `第${index + 1}步的内容`);
    const drawAt = (phase: "streaming" | "complete", settings: unknown) => withSettings(settings, () => render({ type: ui.ReasoningText, props: { text: paragraphs.join("\n\n"), phase, theme: fullTheme, palette: palette(), styles: styles() } }));
    // active 步骤 = 空心呼吸点（transparent 底）。
    const subtreeHasActiveDot = (node: Host): boolean => {
      if ("text" in node) return false;
      const style = flatten(node.props.style);
      if (style.borderRadius === 7 && style.backgroundColor === "transparent" && Number(style.width) === 14) return true;
      return node.children.some((child) => subtreeHasActiveDot(child));
    };
    const stepActive = (nodes: Host[], marker: string, notMarker: string) => {
      // 只看「含本步、不含相邻步」的最小子树（整卡会同时含所有步骤的文本）。
      const rows = nodes.flatMap(nodesOf).filter((node) => !("text" in node) && textOf(node).includes(marker) && !textOf(node).includes(notMarker));
      return rows.some(subtreeHasActiveDot);
    };
    const streaming = drawAt("streaming", ready({ thoughtTailFollow: true, thoughtTailLines: 5 }));
    expect(stepActive(streaming, "第12步的内容", "第11步")).toBe(true);
    expect(stepActive(streaming, "第5步的内容", "第4步")).toBe(false);
  });

  it("shows everything when the window holds the whole text", () => {
    const lines = Array.from({ length: 8 }, (_, index) => `第${index + 1}行`);
    const out = outputOf(draw(lines.join("\n"), ready({ thoughtTailFollow: true, thoughtTailLines: 20 })));
    expect(out).toContain("第1行");
    expect(out).toContain("第8行");
    expect(expandButton(draw(lines.join("\n"), ready({ thoughtTailFollow: true, thoughtTailLines: 20 })))).toBeUndefined();
  });
});

describe("0.11.0: 设置预览面板", () => {
  const fullTheme = { colors: { ...theme.colors, accentForeground: "#ffffff", statusSuccess: "#3fb950", statusWarning: "#d29922", statusDanger: "#f85149" } };
  const ready = (values: Record<string, unknown>) => ({ status: "ready", values: { expansion: {}, density: "compact", ...values }, revision: 1 });
  const withSettings = (settings: unknown, draw: () => Host[]) => {
    (globalThis as { __vividSettings?: unknown }).__vividSettings = settings;
    try {
      return draw();
    } finally {
      (globalThis as { __vividSettings?: unknown }).__vividSettings = undefined;
    }
  };
  const draw = (settings: unknown) => withSettings(settings, () => render({ type: ui.PreviewPanel, props: { theme: fullTheme, paletteFor: ui.paletteFor, actions: {}, compact: false } }));

  it("invokes hooks in a stable sequence across loading → ready → takeover-off renders (React #310 class)", () => {
    const firstHook = (settings: unknown) => {
      ui.__hooksReset();
      withSettings(settings, () => render({ type: ui.PreviewPanel, props: { theme: fullTheme, paletteFor: ui.paletteFor, actions: {}, compact: false } }));
      return ui.__hooksLog()[0] ?? "none";
    };
    const loading = firstHook(undefined);
    expect(loading).toBe("effect");
    expect(firstHook(ready({}))).toBe(loading);
    expect(firstHook(ready({ takeover: "off" }))).toBe(loading);
  });

  it("renders with a stable hook sequence across loading → ready re-renders (React #310 class)", () => {
    const log = (settings: unknown) => {
      ui.__hooksReset();
      withSettings(settings, () => render({ type: ui.DisplaySettings, props: { theme: fullTheme, paletteFor: ui.paletteFor, actions: {}, layout: { compact: false, platform: "web" }, scroll: true } }));
      return ui.__hooksLog().slice();
    };
    const loadingLog = log({ status: "loading" });
    const readyLog = log({ status: "ready", values: ui.activitySettings.schema.parse({ strength: "faded" }), revision: 1 });
    // loading 的 hook 序列必须是 ready 序列的前缀（hooks 在提前返回之前无条件调用）。
    expect(readyLog.slice(0, loadingLog.length)).toEqual(loadingLog);
  });
  const viewsWithOpacity = (nodes: Host[]): number[] => nodes.flatMap(nodesOf).flatMap((node) => {
    if (node.type !== "View") return [];
    const opacity = flatten(node.props.style).opacity;
    return typeof opacity === "number" ? [opacity] : [];
  });
  const text = (nodes: Host[]) => nodes.map(textOf).join("\n");

  it("dims the idle samples by the chosen strength and keeps expanded and running ones full", () => {
    const faded = viewsWithOpacity(draw(ready({ strength: "faded" })));
    expect(faded).toEqual(expect.arrayContaining([0.45]));
    expect(faded).not.toContain(0.3);
    expect(viewsWithOpacity(draw(ready({ strength: "dim" })))).toContain(0.3);
  });

  it("colors the collapsed shell command only in the always mode (When open keeps it plain until expanded)", () => {
    const summarySpans = (mode: string) => {
      const nodes = draw(ready({ commandColors: mode, expansion: { shell: "never" }, strength: "full" }));
      const summary = nodes.flatMap(nodesOf).find((node) => node.type === "Text" && textOf(node).includes("npm ci") && node.children && node.children.length > 0);
      // 着色段 = 嵌套的 Text 元素 children；纯文本 = 单个字符串 children。
      return summary && Array.isArray(summary.children) ? summary.children.filter((c) => typeof c === "object" && !("text" in c) && c.type === "Text").length : 0;
    };
    // Always：收起的行也带语法色段（多个嵌套 Text）；When open：收起行纯文本（展开后才着色）。
    expect(summarySpans("always")).toBeGreaterThan(1);
    expect(summarySpans("expanded")).toBe(0);
  });

  it("mirrors the wrap diff lines setting in the diff sample", () => {
    // diff 样本挂在展开的 shell 行下：显式给 shell「总是展开」（expansion 嵌套结构与真实设置一致）。
    // 断言只看 diff 行自身是否处于横滚祖先内——预览里其他域（code/output 关态）也有各自的横滚，不能全树扫。
    // diffSurface 的特征样式（minWidth:100% + borderWidth:1 + paddingVertical:2 + overflow:hidden）：
    // 只匹配 diff 容器节点，返回它是否处于横向 ScrollView 祖先内。
    const diffInHScroll = (nodes: Host[], insideH: boolean): boolean | null => {
      for (const node of nodes ?? []) {
        if (node === null || typeof node !== "object" || !("props" in node) || "text" in node) continue;
        const style = flatten(node.props.style);
        const isH = node.type === "ScrollView" && node.props.horizontal === true;
        if (style.minWidth === "100%" && style.borderWidth === 1 && style.paddingVertical === 2 && style.overflow === "hidden") return insideH;
        const child = diffInHScroll(node.children as Host[], insideH || isH);
        if (child !== null) return child;
      }
      return null;
    };
    const drawDiff = (settings: Record<string, unknown>) => diffInHScroll(draw(ready(settings)), false);
    expect(drawDiff({ wrapLines: { diff: false, code: false, output: false }, expansion: { shell: "always" } })).toBe(true);
    expect(drawDiff({ wrapLines: { diff: true, code: false, output: false }, expansion: { shell: "always" } })).toBe(false);
  });

  it("draws the mock turn: pinned question, thinking, tools, fold summary and tokens", () => {
    const out = text(draw(ready({ pinPrompt: true, strength: "faded", fold: true })));
    expect(out).toContain("把登录模块");
    expect(out).toContain("第 1 步：先找到超时配置的来源。");
    expect(out).toContain("npm ci --omit=dev");
    expect(out).toContain("4 步");
    expect(out).toContain("本轮 输入 12k");
  });

  it("renders the mock turn without negative card margins (the panel has no Paseo spacing to offset, so negatives would overlap rows)", () => {
    const negative = draw(ready({ strength: "faded" })).flatMap(nodesOf).filter((node) => {
      if (node.type !== "View") return false;
      const style = flatten(node.props.style);
      return (typeof style.marginTop === "number" && style.marginTop < 0) || (typeof style.marginBottom === "number" && style.marginBottom < 0);
    });
    expect(negative).toHaveLength(0);
  });

  it("says there is nothing to preview while takeover is off", () => {
    const out = text(draw(ready({ takeover: "off" })));
    expect(out).toContain("接管已关闭");
    expect(out).not.toContain("npm ci --omit=dev");
  });
});
