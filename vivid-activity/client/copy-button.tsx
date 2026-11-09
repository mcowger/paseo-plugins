import { useI18n } from "./i18n-client";
import { t } from "../shared/text";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { toneColor } from "./kit";

type Theme = PluginTimelineItemProps["theme"];
type CopyStyles = { copyButton: ViewStyle; copyText: TextStyle & { color: string } };

/** Copy button with a short 「已复制」 confirmation. `text` is what the button says (「复制」 unless told otherwise). */
export function CopyButton({ value, label, text = t("ui.copy2"), theme, styles }: { value: string; label: string; text?: string; theme: Theme; styles: CopyStyles }) {
  useI18n();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);
  const handleCopy = useCallback(() => {
    void copyText(value).then(
      () => {
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => {
        toast.error(t("ui.copyFailed"));
      },
    );
  }, [toast, value]);
  return (
    <Pressable accessibilityLabel={copied ? t("ui.copied") : label} accessibilityRole="button" onPress={handleCopy} style={styles.copyButton}>
      <Icon name={copied ? "Check" : "Copy"} color={copied ? toneColor(theme, "success") : styles.copyText.color} size={11} />
      <Text style={styles.copyText}>{copied ? t("ui.copied") : text}</Text>
    </Pressable>
  );
}

/**
 * 0.5.0：输出的复制按钮。「复制」复制去掉终端转义序列后的纯文本（和框里显示的一样）；原文里确实有转义序列时，
 * 旁边再给一个「复制原文」，复制没动过的原文。
 */
export function OutputCopyButtons({ clean, raw, label, theme, styles }: { clean: string; raw: string; label: string; theme: Theme; styles: CopyStyles }) {
  useI18n();
  const copy = <CopyButton value={clean} label={label} theme={theme} styles={styles} />;
  if (clean === raw) return copy;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 0 }}>
      {copy}
      <CopyButton value={raw} label={t("ui.originalTextWithTerminalEscape", { label: label })} text={t("ui.copyOriginal")} theme={theme} styles={styles} />
    </View>
  );
}
