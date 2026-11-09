import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { activitySettings } from "../shared/settings";

const host = vi.hoisted(() => ({ settings: {} as any }));
vi.mock("@getpaseo/plugin/client", () => ({ useSettings: () => host.settings }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SettingsAction: "SettingsAction", SettingsCard: "SettingsCard", SettingsInput: "SettingsInput", SettingsRow: "SettingsRow", SettingsSection: "SettingsSection", SettingsSelect: "SettingsSelect", SettingsSwitch: "SettingsSwitch" }));
vi.mock("react-native", () => ({
  Text: "Text",
  View: "View",
  ScrollView: "ScrollView",
  // 0.11.0: the preview card renders a real DiffBlock, whose module graph reaches use-foreground (AppState).
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
}));
vi.mock("./language-settings", () => ({ LanguageSettings: () => null }));
vi.mock("./i18n-client", () => ({ useI18n: () => undefined }));
vi.mock("./kit", () => ({ toneColor: () => "#ffffff" }));
// 0.8.0: the running animations preview draws live loaders (fx code); the settings logic is what this test covers.
vi.mock("./loader-preview", () => ({ LoaderPreview: () => null, loaderLabels: { spinner: "转圈", sparkle: "星芒", orb: "光球", snake: "点阵 · 蛇形", matrix: "点阵 · 闪烁" } }));
// 0.11.0: same for the full preview panel (its render is covered in native-rows.test with the fuller react-native stand-ins).
vi.mock("./settings-preview-rows", () => ({ PreviewPanel: () => null }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useCallback: (fn: unknown) => fn, useEffect: () => undefined, useMemo: (compute: () => unknown) => compute(), useState: (value: unknown) => [value, () => undefined] }));
vi.mock("./typography", async (original) => ({ ...await original<typeof import("./typography")>(), useTypography: () => ({ scale: 1, line: 1 }) }));

import { ActivitySettings, type SettingsActions } from "./settings";
import { PlainDetail } from "./activity-lazy";

function controls(node: ReactNode): Array<{ type: unknown; props: any }> {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(controls);
  const element = node as ReactElement<any>;
  if (typeof element.type === "function") return controls((element.type as (props: any) => ReactNode)(element.props));
  return [element, ...controls(element.props?.children)];
}
const settle = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };

describe("lazy activity surfaces", () => {
  let actions: SettingsActions;
  beforeEach(() => {
    host.settings = { status: "ready", values: activitySettings.schema.parse({}), revision: "revision-1", saving: false, save: vi.fn(async () => true) };
    actions = { onFoldSettings: vi.fn(), onTakeover: vi.fn() };
  });
  const renderSettings = () => controls(ActivitySettings({ theme: { colors: { foreground: "#fff" } }, actions } as any));

  it("sends saved takeover and fold changes back to the eager runtime through props", async () => {
    const rendered = renderSettings();
    rendered.find((entry) => entry.props.label === "接管")!.props.onValueChange("off");
    expect(actions.onTakeover).not.toHaveBeenCalled();
    await settle();
    expect(actions.onFoldSettings).toHaveBeenCalledWith({ scope: "off" });
    expect(actions.onTakeover).toHaveBeenCalledWith("off");
    rendered.find((entry) => entry.type === "SettingsSwitch" && String(entry.props.label).includes("折叠"))!.props.onValueChange(false);
    await settle();
    expect(actions.onFoldSettings).toHaveBeenCalledWith({ enabled: false });
    expect(host.settings.save).toHaveBeenCalledWith(expect.objectContaining({ takeover: "off" }), "revision-1");
  });

  it("does not apply unsaved settings when a concurrent revision loses", async () => {
    host.settings.save.mockResolvedValue(false);
    const rendered = renderSettings();
    rendered.find((entry) => entry.props.label === "接管")!.props.onValueChange("off");
    rendered.find((entry) => entry.type === "SettingsSwitch" && String(entry.props.label).includes("折叠"))!.props.onValueChange(false);
    await settle();
    expect(actions.onFoldSettings).not.toHaveBeenCalled();
    expect(actions.onTakeover).not.toHaveBeenCalled();
  });

  it("saves the code font only through Apply and only when it is a plain font list", async () => {
    host.settings.values = { ...host.settings.values, monoFont: '"JetBrains Mono"' };
    let rendered = renderSettings();
    const apply = () => rendered.find((entry) => entry.type === "SettingsAction" && entry.props.actionLabel === "应用")!;
    expect(rendered.find((entry) => entry.props.label === "字体" && "initialValue" in entry.props)!.props).toMatchObject({ initialValue: '"JetBrains Mono"', error: null });
    expect(apply().props.disabled).toBe(true);
    rendered.find((entry) => entry.props.label === "字号")!.props.onValueChange("large");
    rendered.find((entry) => entry.props.label === "行距")!.props.onValueChange("double");
    await settle();
    expect(host.settings.save).toHaveBeenCalledTimes(1);
    expect(host.settings.save).toHaveBeenCalledWith(expect.objectContaining({ textSize: "large", monoFont: '"JetBrains Mono"' }), "revision-1");
    host.settings.values = { ...host.settings.values, monoFont: "Mono; } body {" };
    rendered = renderSettings();
    expect(rendered.find((entry) => entry.props.label === "字体" && "initialValue" in entry.props)!.props.error).toBe("只能填字体名（字母、数字、空格和 . _ + -），用逗号分隔，最多 200 个字符。");
    expect(apply().props.disabled).toBe(true);
  });

  it("shows readable plain text before detail code loads, including file bodies and empty-output commands", () => {
    const text = (props: any) => PlainDetail(props).props.children;
    expect(text({ data: { detail: { type: "shell", output: "", command: "npm run check" } } })).toBe("npm run check");
    expect(text({ data: { detail: { type: "read", content: "const answer = 42" } } })).toBe("const answer = 42");
    expect(text({ data: { detail: { type: "edit", unifiedDiff: "-old\n+new" } } })).toBe("-old\n+new");
    expect(text({ text: "\u001b[31m思考中\u001b[0m" })).toBe("思考中");
    expect(text({ text: "x".repeat(10_000) })).toHaveLength(4000);
    expect(text({})).toBe("正在加载详情…");
  });
});
