import { useCallback, useEffect } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { useSettings } from "@getpaseo/plugin/client";
import { activitySettings } from "../shared/settings";

/**
 * 0.11.0:展开区域的设置读取钩子。放在中立模块：常驻行（activity.tsx）与懒加载详情
 * （activity-details.tsx）都要用，且不能让常驻侧静态引入详情块。
 */

/** 「长行折行」矩阵（shared/settings.ts wrapLines）。off（默认）= 单行横滚；on = 折到可用宽度。 */
export function useWrapLines(area: "diff" | "code" | "output"): boolean {
  const settings = useSettings(activitySettings);
  // 兜底旧形状 values（未经 migrate 的测试夹具等）：缺矩阵按默认。
  if (settings.status !== "ready") return false;
  return settings.values.wrapLines?.[area] ?? false;
}

/** 「跟随最新输出」矩阵（shared/settings.ts followOutput；思考行走 thoughtTail*，不在此）。 */
export function useFollowOutput(area: "shell" | "logs" | "todo" | "browser"): boolean {
  const settings = useSettings(activitySettings);
  if (settings.status !== "ready") return true;
  return settings.values.followOutput?.[area] ?? true;
}

/**
 * 0.11.0:「跟随最新输出」的共享回底机制（思考尾窗与工具明细同一实现）：内容键一变且用户
 * 停在底部附近就回底；onScroll 维护近底标记（上滚 32px 之外即暂停跟随）；尺寸增长由
 * onContentSizeChange（=回底）兜底。enabled=false 时整体停用：effect 和 onContentSizeChange 都不回底
 * （ScrollView 首次布局也会触发 onContentSizeChange，不拦就会把已完成的长明细一打开就滚到末尾）。
 */
export function useFollowBottom(
  scrollRef: { current: { scrollToEnd: (options?: { animated: boolean }) => void } | null },
  nearBottomRef: { current: boolean },
  contentKey: unknown,
  enabled: boolean,
): {
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onContentSizeChange: () => void;
} {
  const scrollToEnd = useCallback(() => {
    if (enabled && nearBottomRef.current) scrollRef.current?.scrollToEnd({ animated: false });
  }, [enabled, nearBottomRef, scrollRef]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    nearBottomRef.current = layoutMeasurement.height + contentOffset.y >= contentSize.height - 32;
  }, []);
  useEffect(() => {
    if (!enabled) return;
    // 延迟一帧：scrollToEnd 在 React 提交后立即调用时 Yoga 布局尚未落地，会读到旧尺寸而滚不到位。
    const timer = setTimeout(() => {
      if (nearBottomRef.current) scrollRef.current?.scrollToEnd({ animated: false });
    }, 0);
    return () => clearTimeout(timer);
  }, [contentKey, enabled, scrollToEnd]);
  return { onScroll, onContentSizeChange: scrollToEnd };
}
