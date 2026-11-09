import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Text } from "react-native";
import { emphasizeShellHead, highlightCodeSync, type HighlightToken } from "./highlight";
import { vividSyntaxColors } from "./kit";

/**
 * 0.11.0:「命令着色」：shell 行的行头命令按语法色渲染。只活在 fx 懒加载块里（Prism 不进常驻包）；
 * token 少于一色（普通词）或高亮不可用时返回纯文本。颜色 = 命令着色的 vivid 派生语法色
 * （vividSyntaxColors：builtin 橙/keyword 紫/变量青/字符串绿/constant 青柠/heredoc 鸭羽绿…随宿主主题明暗适配）；
 * 0.11.0 起首词加粗、注释斜体（fontStyle 位掩码）。
 */
export function CommandTokens({ text, theme }: { text: string; theme: PluginTheme }): ReactNode {
  const lines = highlightCodeSync(text, "shell", vividSyntaxColors(theme));
  const line = lines && emphasizeShellHead(lines)?.[0];
  if (!line || line.length <= 1) return text;
  return (
    <>
      {line.map((token, index) => (
        <Text key={index} style={shellTokenStyle(token)}>{token.content}</Text>
      ))}
    </>
  );
}

/** 0.11.0:token 的颜色 + 位掩码样式（1 斜体 / 2 粗体），与活动详情的代码行渲染同构。 */
function shellTokenStyle(token: HighlightToken) {
  if (!token.color && !token.fontStyle) return null;
  return {
    ...(token.color ? { color: token.color } : null),
    ...(token.fontStyle && token.fontStyle & 1 ? { fontStyle: "italic" as const } : null),
    ...(token.fontStyle && token.fontStyle & 2 ? { fontWeight: "700" as const } : null),
  };
}
