import { useSettings } from "@getpaseo/plugin/client";
import { useEffect, useState, type ComponentType } from "react";
import { activitySettings, DEFAULT_LOADER, type LoaderKind } from "../shared/settings";

/**
 * 0.8.0：第三个懒加载块 `fx`（fx-chunk.client.tsx）：运行中动画（星芒、光球、点阵）和折叠摘要展开后的改动清单。
 * 常驻包只留这一层：默认的转圈不下载它；选了别的动画、或第一次展开带改动的摘要时才下载（约几十 KB，本次 App 运行期一次）。
 * 下载到之前，运行中的行照旧转圈，清单先不显示；下载失败时也一样，一分钟后有人要再试。
 */
type Surfaces = Record<string, ComponentType<any>>;
interface FxLoader {
  load(): Promise<Surfaces>;
  peek(): Surfaces | undefined;
}

const RETRY_MS = 60_000;
let loader: FxLoader | null = null;
let failedAt = -Infinity;

/** index.client.tsx hands over the chunk loader (kit `createChunkLoader`); null when the plugin stops. */
export function configureFx(next: FxLoader | null): void {
  loader = next;
  failedAt = -Infinity;
}

/** The fx chunk's views once loaded; the first caller asks for the chunk. `enabled=false` 只读已下载的，不触发下载。 */
export function useFx(enabled = true): Surfaces | null {
  const current = loader;
  const [ready, setReady] = useState<Surfaces | null>(() => current?.peek() ?? null);
  useEffect(() => {
    if (!enabled || ready || !current || Date.now() - failedAt < RETRY_MS) return;
    let live = true;
    current.load().then(
      (surfaces) => {
        if (live) setReady(surfaces);
      },
      () => {
        failedAt = Date.now();
      },
    );
    return () => {
      live = false;
    };
  }, [enabled, current, ready]);
  return ready ?? current?.peek() ?? null;
}

/** The chosen running animation (settings 「运行中动画」); the spinner until settings are read. */
export function useLoader(): LoaderKind {
  const settings = useSettings(activitySettings);
  return settings.status === "ready" ? settings.values.loader : DEFAULT_LOADER;
}
