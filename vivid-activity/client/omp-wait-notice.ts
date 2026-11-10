export type WaitTextPart =
  | { kind: "text"; text: string }
  | { kind: "notice"; text: string };

const NOTICE = /<system-notice>([\s\S]*?)<\/system-notice>/g;

/** Extract complete system notices while retaining all surrounding and unrecognized text. */
export function splitWaitTextNotices(text: string): WaitTextPart[] {
  const parts: WaitTextPart[] = [];
  let cursor = 0;
  NOTICE.lastIndex = 0;
  for (let match; (match = NOTICE.exec(text)); ) {
    if (match.index > cursor) parts.push({ kind: "text", text: text.slice(cursor, match.index) });
    parts.push({ kind: "notice", text: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts;
}
