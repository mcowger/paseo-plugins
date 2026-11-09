export type InlineMarkdownPart =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string };

export type ReasoningMarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; text: string }
  | { type: "unordered"; text: string }
  | { type: "ordered"; marker: string; text: string }
  | { type: "quote"; text: string }
  | { type: "code"; language?: string; text: string }
  | { type: "spacer" };

const INLINE_TOKEN_PATTERN = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;

export function parseInlineMarkdown(text: string): InlineMarkdownPart[] {
  const parts: InlineMarkdownPart[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_TOKEN_PATTERN.exec(text)) !== null) {
    const start = match.index;
    const token = match[0];
    if (start > cursor) parts.push({ type: "text", text: text.slice(cursor, start) });

    if (token.startsWith("**") || token.startsWith("__")) {
      parts.push({ type: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("`") && token.endsWith("`")) {
      parts.push({ type: "code", text: token.slice(1, -1) });
    } else {
      parts.push({ type: "italic", text: token.slice(1, -1) });
    }
    cursor = start + token.length;
  }

  if (cursor < text.length) parts.push({ type: "text", text: text.slice(cursor) });
  return parts;
}

// 本地补丁（0.6.0-local.2，codex-vivid-F1）：标记后的文字原来是 `\s+(.+)$`。空白和 `.+` 都吃空格，行里夹着 \r 或 U+2028
// 时（`.` 不匹配它们，`$` 只认结尾）会从每个切分点重扫到行尾，一长串空格就平方级。现在文字要么以非空白开头，要么只是
// 最后一个空白字符（原来在这种情况下抓到的也是它），匹配结果不变。
const HEADING = /^\s{0,3}#{1,6}\s+(\S.*|[^\S\n\r\u2028\u2029])$/;
const UNORDERED = /^\s*[-*+]\s+(\S.*|[^\S\n\r\u2028\u2029])$/;
const ORDERED = /^\s*(\d+)[.)]\s+(\S.*|[^\S\n\r\u2028\u2029])$/;

export function parseReasoningMarkdown(text: string): ReasoningMarkdownBlock[] {
  const blocks: ReasoningMarkdownBlock[] = [];
  const lines = text.split("\n");
  let codeLines: string[] | null = null;
  let codeLanguage: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (codeLines !== null) {
      if (trimmed.startsWith("```")) {
        blocks.push({
          type: "code",
          ...(codeLanguage ? { language: codeLanguage } : {}),
          text: codeLines.join("\n"),
        });
        codeLines = null;
        codeLanguage = undefined;
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim();
      codeLines = [];
      codeLanguage = language || undefined;
      continue;
    }
    if (trimmed.length === 0) {
      blocks.push({ type: "spacer" });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: "heading", text: heading[1] ?? "" });
      continue;
    }

    const unordered = line.match(UNORDERED);
    if (unordered) {
      blocks.push({ type: "unordered", text: unordered[1] ?? "" });
      continue;
    }

    const ordered = line.match(ORDERED);
    if (ordered) {
      blocks.push({
        type: "ordered",
        marker: `${ordered[1]}.`,
        text: ordered[2] ?? "",
      });
      continue;
    }

    if (trimmed.startsWith(">")) {
      blocks.push({ type: "quote", text: trimmed.slice(1).trimStart() });
      continue;
    }

    blocks.push({ type: "paragraph", text: line });
  }

  if (codeLines !== null) {
    blocks.push({
      type: "code",
      ...(codeLanguage ? { language: codeLanguage } : {}),
      text: codeLines.join("\n"),
    });
  }

  return blocks;
}
