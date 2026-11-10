import { createClientI18n } from "./client/i18n-client";
import { boot as bootEn } from "./shared/locales/en.json";
import { boot as bootZh } from "./shared/locales/zh-CN.json";
import { t } from "./shared/text";
import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { z } from "zod";
import { createChunkLoader, lazySurfaces } from "./client/lazy-chunk";
import { ActivityDetailsContext, PlainDetail } from "./client/activity-lazy";
import { getClientChunk } from "./shared/ui-chunk";
import { FX_CHUNK } from "./shared/generated/fx-chunk-manifest";
import { PI_CHUNK } from "./shared/generated/pi-chunk-manifest";
import { UI_CHUNK } from "./shared/generated/ui-chunk-manifest";
import { ActivityIndicator } from "react-native";
import { ColorfulReasoning, ColorfulToolCall, paletteFor } from "./client/activity";
import { TurnTimeRow } from "./client/turn-time";
import { TURN_TIME_RENDERER_KIND, TURN_TIME_RENDERER_VERSION, turnTimeDataSchema } from "./shared/turn-time";
import { FoldRow } from "./client/fold-row";
import { configureFx } from "./client/fx";
import { LoaderMark } from "./client/vivid";
import { foldRuntime } from "./client/fold-runtime";
import { BOUNDARY_ITEM_TYPES, configurePiNotices, observeBoundary, transformReasoning, transformToolCall } from "./client/transform";
import { applyTakeover, isSettingsChange, setLiveTakeover, startTakeover, type TakeoverPart } from "./client/takeover";
import { installColorfulFonts } from "./client/web";
import { foldIndexRpc } from "./shared/fold-index";
import { activitySettings, DEFAULT_TAKEOVER, foldFromValues } from "./shared/settings";
import {
  FOLD_RENDERER_KIND,
  FOLD_RENDERER_VERSION,
  foldItemDataSchema,
  REASONING_RENDERER_KIND,
  REASONING_RENDERER_VERSION,
  TOOL_CALL_RENDERER_KIND,
  TOOL_CALL_RENDERER_VERSION,
  reasoningItemDataSchema,
  setPiNoticeReader,
  toolCallItemDataSchema,
  type PiNoticeReader,
} from "./shared/timeline";

type EventObserver = (
  events: ["status.plugin_settings_changed"],
  options: { signal: AbortSignal },
) => {
  subscribe(observer: { snapshot(): void; update(message: unknown): void; error?(error: unknown): void }): () => void;
  release(): Promise<void>;
};

/** Follows settings changes made on any device; also fires after (re)connecting. */
function watchSettings(client: PluginClientContext, changed: () => void): () => void {
  const observe = (client.paseo as { observeEvents?: unknown }).observeEvents;
  if (typeof observe !== "function") return () => undefined;
  const lifetime = new AbortController();
  try {
    const observation = (observe as EventObserver).call(client.paseo, ["status.plugin_settings_changed"], {
      signal: lifetime.signal,
    });
    const unsubscribe = observation.subscribe({
      snapshot: changed,
      update: (message) => {
        if (isSettingsChange(message, activitySettings.id)) changed();
      },
      error: () => undefined,
    });
    return () => {
      unsubscribe();
      lifetime.abort();
      void observation.release().catch(() => undefined);
    };
  } catch {
    lifetime.abort();
    return () => undefined;
  }
}

const NudgeRow = () => null;

/** 0.11.0：侧边栏入口。label 省略，随注册标题走（语言切换时由 i18n.localized 重挂）。 */
function SettingsSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Activity" active={currentScreen?.screenId === "settings"} onPress={() => openScreen({ screenId: "settings" })} />;
}

export default function contribute(client: PluginClientContext) {
  const i18n = createClientI18n(client, { pluginId: "vivid-activity", boot: { "zh-CN": { boot: bootZh }, en: { boot: bootEn } } });
  const surface = lazySurfaces(client, { rpc: getClientChunk, manifest: UI_CHUNK, label: () => t("boot.name"), text: i18n, fallback: (id, props) => id === "settings" ? <ActivityIndicator color={props.theme?.colors.foregroundMuted} /> : <PlainDetail {...props} /> });
  const details = { DetailBody: surface("detail"), ReasoningText: surface("reasoning") };
  const LazySettings = surface("settings");
  const actions = { onFoldSettings: foldRuntime.setSettings, onTakeover: applyTakeover, LoaderMark };
  const ActivitySettings = (props: any) => <LazySettings {...props} actions={actions} paletteFor={paletteFor} />;
  const ReasoningRow = (props: any) => <ActivityDetailsContext.Provider value={details}><ColorfulReasoning {...props} /></ActivityDetailsContext.Provider>;
  const ToolRow = (props: any) => <ActivityDetailsContext.Provider value={details}><ColorfulToolCall {...props} /></ActivityDetailsContext.Provider>;
  const removeFonts = installColorfulFonts();
  client.addSettingsScreen({
    id: "display",
    title: t("boot.name"),
    icon: "Palette",
    Component: ActivitySettings,
  });
  // 0.11.0：侧边栏与命令面板的第二个设置入口，指向同一份设置面。screen 只注册一次、标题用函数随语言变
  // （重挂会把正停在页面上的用户带走的坑，见 observatory 的 settings screen 注释）；侧边栏项和命令标题是
  // 注册时的字符串，语言切换时由 i18n.localized 重挂。
  const ScreenSettings = (props: PluginScreenProps) => (
    // 独立 screen：分栏布局自带左右滚动（client/settings.tsx DisplaySettings 的 scroll 分支），
    // 这里不再包外层 ScrollView——避免双层滚动。
    <LazySettings {...props} actions={actions} paletteFor={paletteFor} scroll />
  );
  const stopScreen = client.addScreen({ id: "settings", title: () => t("boot.name"), Component: ScreenSettings });
  // 0.11.0：侧边栏入口开关（settings.sidebar）。挂/摘走同一 handle：设置初读与任意设备的改动都触发
  // syncSidebarItem；语言切换时 remove-then-add 顺带刷新标题。命令面板入口不受此开关影响。
  let stopSidebarItem: (() => void) | null = null;
  let sidebarVisible = true;
  const removeSidebarItem = () => {
    if (!stopSidebarItem) return;
    stopSidebarItem();
    stopSidebarItem = null;
  };
  const syncSidebarItem = () => {
    removeSidebarItem();
    if (sidebarVisible) stopSidebarItem = client.addSidebarHeaderItem({ id: "settings", title: t("boot.name"), Component: SettingsSidebarItem });
  };
  const applySidebarValues = (values: unknown) => {
    const parsed = activitySettings.schema.safeParse(values ?? {});
    sidebarVisible = parsed.success ? parsed.data.sidebar : true;
    syncSidebarItem();
  };
  const stopSidebar = i18n.localized(() => {
    const stopCommand = client.addCommandCenterItem({
      id: "open-settings",
      title: t("boot.openSettings"),
      icon: "Palette",
      keywords: [t("boot.name")],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "settings" });
      },
    });
    syncSidebarItem();
    return () => {
      stopCommand();
      removeSidebarItem();
    };
  });
  const sidebarRead = settingsRpc(activitySettings.id).read;
  void client.rpc(sidebarRead, {}).then((result) => {
    if (result.status === "ready") applySidebarValues(result.values);
  }).catch(() => undefined);
  const stopSidebarWatch = watchSettings(client, () => {
    void client.rpc(sidebarRead, {}).then((result) => {
      if (result.status === "ready") applySidebarValues(result.values);
    }).catch(() => undefined);
  });
  // 计划（ExitPlanMode / plan_approval）和任务清单（TodoWrite）不注册转换器，始终由 Paseo 显示。
  client.addTimelineRenderer({
    kind: REASONING_RENDERER_KIND,
    version: REASONING_RENDERER_VERSION,
    schema: reasoningItemDataSchema,
    Component: ReasoningRow,
  });
  client.addTimelineRenderer({
    kind: TOOL_CALL_RENDERER_KIND,
    version: TOOL_CALL_RENDERER_VERSION,
    schema: toolCallItemDataSchema,
    Component: ToolRow,
  });
  client.addTimelineRenderer({ kind: TURN_TIME_RENDERER_KIND, version: TURN_TIME_RENDERER_VERSION, schema: turnTimeDataSchema, Component: TurnTimeRow });
  // 本地补丁：折叠摘要行。
  client.addTimelineRenderer({
    kind: FOLD_RENDERER_KIND,
    version: FOLD_RENDERER_VERSION,
    schema: foldItemDataSchema,
    Component: FoldRow,
  });

  // 本地补丁：折叠需要 Paseo 重新投影时，增删一个空渲染器——Paseo 会换一个新的组合转换函数，投影缓存随之失效
  // （与切换接管范围用的是同一个机制）。
  let nudgeRegistration: (() => void) | null = null;
  const nudge = () => {
    if (nudgeRegistration) {
      nudgeRegistration();
      nudgeRegistration = null;
    } else {
      nudgeRegistration = client.addTimelineRenderer({ kind: "vivid-nudge", version: 1, schema: z.null(), Component: NudgeRow });
    }
  };
  const stopText = i18n.subscribe(nudge);
  foldRuntime.configure({ rpc: (input) => client.rpc(foldIndexRpc, input), nudge });
  // 0.6.0-local.5: the Pi notice reader comes in its own small chunk, the first time a Pi notice row is drawn.
  const piChunk = createChunkLoader(client, { rpc: getClientChunk, manifest: PI_CHUNK, label: () => t("boot.piNotice"), text: i18n });
  configurePiNotices({ load: () => piChunk.load().then((surfaces) => surfaces.readPiNotice as unknown as PiNoticeReader), redraw: nudge });
  // 0.8.0: running animations other than the spinner and the change list of an expanded summary (client/fx.ts).
  configureFx(createChunkLoader(client, { rpc: getClientChunk, manifest: FX_CHUNK, label: () => t("boot.name"), text: i18n }));

  const readSettings = settingsRpc(activitySettings.id).read;
  const register = (part: TakeoverPart) => {
    if (part === "tool-calls") {
      return client.addTimelineTransformer({ id: "tool-calls", query: { itemType: "tool_call" }, transform: transformToolCall });
    }
    // Reasoning is drawn in every scope but 「关闭」, so the boundary observers live with it.
    const removals = [
      client.addTimelineTransformer({ id: "reasoning", query: { itemType: "reasoning" }, transform: transformReasoning }),
      ...BOUNDARY_ITEM_TYPES.map((itemType) =>
        client.addTimelineTransformer({ id: `fold-${itemType.replace(/_/g, "-")}`, query: { itemType }, transform: observeBoundary } as Parameters<typeof client.addTimelineTransformer>[0]),
      ),
    ];
    // Paseo 0.13 lets a transformer watch notifications too (getpaseo/paseo#7582), so a segment folds as soon as one
    // arrives. Paseo 0.12 rejects the item type before registering anything, which tells the two apart.
    try {
      removals.push(client.addTimelineTransformer({ id: "fold-notification", query: { itemType: "notification" }, transform: observeBoundary } as Parameters<typeof client.addTimelineTransformer>[0]));
    } catch {
      // Older host: the fold index still splits segments at notifications, just later.
    }
    return () => {
      for (const remove of removals) remove();
    };
  };
  const takeover = startTakeover({
    register,
    read: async () => {
      const [result] = await Promise.all([client.rpc(readSettings, {}), i18n.ready()]);
      if (result.status !== "ready") return null;
      const fold = foldFromValues(result.values);
      if (fold) foldRuntime.setSettings(fold);
      return fold?.scope ?? null;
    },
    watch: (changed) => watchSettings(client, changed),
    // Rows need their text: with a catalog already kept (reconnect, web reload) take over at once as before; otherwise
    // the first read waits for both settings and text, and the host's own rows show until then.
  }, i18n.isReady() ? DEFAULT_TAKEOVER : "off");
  setLiveTakeover(takeover);
  return () => {
    stopScreen();
    stopSidebar();
    stopSidebarWatch();
    removeSidebarItem();
    stopText();
    i18n.dispose();
    setLiveTakeover(null);
    takeover.stop();
    configurePiNotices(null);
    configureFx(null);
    setPiNoticeReader(null);
    foldRuntime.configure(null);
    nudgeRegistration = null;
    removeFonts();
  };
}
