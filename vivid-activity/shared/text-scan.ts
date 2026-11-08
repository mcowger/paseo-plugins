/**
 * 本地补丁（0.6.0-local.2，codex-vivid-F1）：几处对宿主数据（工具输出、命令、工作目录）跑的正则会回溯成平方级，一长串
 * 空白、换行或斜杠就要算好几秒。这里换成线性的扫描，结果和原来的正则一样（shared/backtracking.test.ts 用随机输入逐一对照）。
 * 纯函数，不依赖 react-native。
 */

const SPACE = /\s/;

/** `value` without its trailing slashes, as `value.replace(/\/+$/, "")` gave. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

/** Spaces and tabs right before each line break removed, as `value.replace(/[ \t]+\n/g, "\n")` gave. */
export function trimSpacesBeforeLineBreaks(value: string): string {
  const rows = value.split("\n");
  for (let i = 0; i < rows.length - 1; i++) {
    const row = rows[i]!;
    let end = row.length;
    while (end > 0 && (row[end - 1] === " " || row[end - 1] === "\t")) end -= 1;
    rows[i] = row.slice(0, end);
  }
  return rows.join("\n");
}

/**
 * `text` split at `marker` standing alone on its line between line breaks, as a split at the regex
 * `\n\s*<marker>\s*\n` gave: a separator runs from the first line break of the spaces before `marker` to just past the last
 * line break of the spaces after it. `marker` starts and ends with a non-space. With `accept`, a separator counts only when
 * `accept(end, spacesEnd)` holds, `end` being just past it and `spacesEnd` where the spaces after `marker` end.
 */
export function splitAtLine(text: string, marker: string, accept?: (end: number, spacesEnd: number) => boolean): string[] {
  const parts: string[] = [];
  let from = 0;
  let search = 0;
  for (let at = text.indexOf(marker, search); at >= 0; at = text.indexOf(marker, search)) {
    search = at + 1;
    let first = -1;
    for (let i = at; i > from && SPACE.test(text[i - 1]!); i--) if (text[i - 1] === "\n") first = i - 1;
    if (first < 0) continue;
    let last = -1;
    let spacesEnd = at + marker.length;
    for (; spacesEnd < text.length && SPACE.test(text[spacesEnd]!); spacesEnd++) if (text[spacesEnd] === "\n") last = spacesEnd;
    if (last < 0 || (accept && !accept(last + 1, spacesEnd))) continue;
    parts.push(text.slice(from, first));
    from = last + 1;
    search = from;
  }
  parts.push(text.slice(from));
  return parts;
}
