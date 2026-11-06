import { z } from "zod";

export const TURN_END_KIND = "turn-end-time";
export const turnEndSchema = z.object({ at: z.number().finite().positive() });

/** Render in the viewer's local time zone. Invalid timestamps are omitted. */
export function formatActivityTime(date: Date): string {
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
