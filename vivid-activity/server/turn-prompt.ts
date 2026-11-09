import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { MAX_PROMPT_CHARS, type TurnPromptInput, type TurnPromptOutput } from "../shared/prompt-pin.js";

/** 0.6.0 (grok-B2): pages of the timeline searched back for the newest user message, when the client does not know where it is. */
export const PROMPT_SCAN_PAGES = 5;
const PAGE = 200;
/**
 * 0.6.0-local.2 (codex-vivid 待核实 2): the whole read gives up after this long and answers unavailable (empty text; the
 * client does not keep it and asks again next time). Paseo refuses the RPC after 30 s but does not stop the handler.
 */
export const PROMPT_DEADLINE_MS = 10_000;

type Page = { entries?: unknown; hasOlder?: unknown; startCursor?: unknown; error?: unknown };
type Entry = { seqStart?: unknown; turnId?: unknown; item?: { type?: unknown; text?: unknown } };

const NONE: TurnPromptOutput = { status: "none", text: "", seq: null, turnId: null, truncated: false };
const UNAVAILABLE: TurnPromptOutput = { ...NONE, status: "unavailable" };

function asPrompt(entry: Entry | undefined): TurnPromptOutput | null {
  if (entry?.item?.type !== "user_message" || typeof entry.item.text !== "string" || typeof entry.seqStart !== "number") return null;
  const text = entry.item.text;
  return {
    status: "ok",
    text: text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS) : text,
    seq: entry.seqStart,
    turnId: typeof entry.turnId === "string" && entry.turnId.length <= 200 ? entry.turnId : null,
    truncated: text.length > MAX_PROMPT_CHARS,
  };
}
const entriesOf = (page: Page): Entry[] => (Array.isArray(page.entries) ? (page.entries as Entry[]) : []);
function cursorOf(value: unknown): { epoch: string; seq: number } | null {
  const raw = value as { epoch?: unknown; seq?: unknown } | null;
  return raw && typeof raw.epoch === "string" && raw.epoch && typeof raw.seq === "number" && Number.isInteger(raw.seq) && raw.seq >= 0 ? { epoch: raw.epoch, seq: raw.seq } : null;
}

/**
 * The question the client pins (shared/prompt-pin.ts). Read inside the daemon like the fold index: only Agents a client is
 * showing ask for it, and showing an Agent already loads it.
 */
export async function handleTurnPrompt(
  input: TurnPromptInput,
  context: PluginHandlerContext,
  deadlineMs = PROMPT_DEADLINE_MS,
): Promise<TurnPromptOutput> {
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<TurnPromptOutput>((resolve) => {
    timer = setTimeout(() => {
      late = true;
      resolve(UNAVAILABLE);
    }, deadlineMs);
  });
  try {
    return await Promise.race([readPrompt(input, context, () => late), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** The read itself; `late()` turns true once the deadline passed, and no further page is read then. */
async function readPrompt(input: TurnPromptInput, context: PluginHandlerContext, late: () => boolean): Promise<TurnPromptOutput> {
  const timeline = context.paseo.agents.ref(input.agentId).timeline;
  try {
    const at = input.at;
    if (at) {
      // The entry just before seq + 1 is the one at seq; a history that changed since falls back to the search.
      const page = (await timeline.refetch({ direction: "before", cursor: { epoch: at.epoch, seq: at.seq + 1 }, limit: 1, projection: "projected" })) as Page;
      const found = asPrompt(entriesOf(page).find((entry) => entry.seqStart === at.seq));
      if (found) return found;
    }
    let cursor: { epoch: string; seq: number } | null = null;
    for (let pages = 0; pages < PROMPT_SCAN_PAGES; pages++) {
      if (late()) return UNAVAILABLE;
      const page = (await timeline.refetch(
        cursor ? { direction: "before", cursor, limit: PAGE, projection: "projected" } : { direction: "tail", limit: PAGE, projection: "projected" },
      )) as Page;
      if (typeof page.error === "string" && page.error) return UNAVAILABLE;
      const entries = entriesOf(page);
      for (let index = entries.length - 1; index >= 0; index--) {
        const found = asPrompt(entries[index]);
        if (found) return found;
      }
      cursor = page.hasOlder === true ? cursorOf(page.startCursor) : null;
      if (!cursor) break;
    }
    return NONE;
  } catch {
    return UNAVAILABLE;
  }
}
