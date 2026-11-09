import type { Density } from "./settings";

/**
 * 本地补丁：行密度与行距。
 *
 * 行距的来源（Paseo 0.11.1 `agent-stream/view.tsx`、`spacing.ts`）：每条时间线条目都包在 `StreamItemWrapper` 里，
 * 外边距 `marginBottom = getGapBetweenStreamItems(上, 下)`。Paseo 自己的工具行、思考行、任务行之间是 0，
 * 插件行（kind "plugin"）不算「工具序列」，与任何邻居之间一律 16px；最后一条、或下面挂着本轮页脚时是 0。
 * 这 16px 在插件之外，插件改不了；插件能做的是在自己的行上用负外边距把它吃掉一部分，再收紧行本身的高度和留白。
 */
export const STREAM_ROW_GAP = 16;

export interface DensityMetrics {
  dense: boolean;
  /** Pulls the row up into the host gap above it. */
  marginTop: number;
  /** Pulls the next row up; small enough to keep clear of the turn footer (13px below the last row → 7px). */
  marginBottom: number;
  /** Native inverted timeline: the live tail row gets no host gap, so it brings its own (same visual gap as between rows). */
  tailMarginTop: number;
  rowMinHeight: number;
  rowPaddingVertical: number;
  tile: number;
  gap: number;
  lineHeight: number;
  /** Header padding of the non-vivid palettes. */
  plainPaddingVertical: number;
}

const cache = new Map<string, DensityMetrics>();

/**
 * Visual gap between two plugin rows: 16 + marginTop + marginBottom → compact 4px, standard 10px. Stable objects per input.
 * `native`: the phone/tablet app, whose list cells may clip children at their bounds; rows there stay tall enough that the
 * negative margins only reach into their own empty edge.
 */
export function densityMetrics(density: Density, compactLayout: boolean, native = compactLayout): DensityMetrics {
  const id = `${density}|${compactLayout ? 1 : 0}|${native ? 1 : 0}`;
  const cached = cache.get(id);
  if (cached) return cached;
  const metrics = computeMetrics(density, compactLayout, native);
  cache.set(id, metrics);
  return metrics;
}

function computeMetrics(density: Density, compactLayout: boolean, native: boolean): DensityMetrics {
  const dense = density === "compact";
  // Symmetric, and no deeper than the row's own empty edge (tile/text slack), so a native list cell that clips its
  // children at the cell bounds cuts only whitespace.
  const marginTop = dense ? -6 : -3;
  const marginBottom = dense ? -6 : -3;
  return {
    dense,
    marginTop,
    marginBottom,
    tailMarginTop: STREAM_ROW_GAP + marginTop,
    rowMinHeight: dense ? (compactLayout || native ? 30 : 24) : compactLayout ? 32 : 30,
    rowPaddingVertical: dense ? 1 : 3,
    tile: dense ? 18 : 20,
    gap: compactLayout ? (dense ? 5 : 6) : dense ? 7 : 8,
    lineHeight: dense ? 16 : 18,
    plainPaddingVertical: dense ? 0 : 2,
  };
}

