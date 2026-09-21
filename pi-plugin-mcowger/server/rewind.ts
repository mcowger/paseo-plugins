import { randomBytes } from "node:crypto";

export interface PiRewindNavigator {
  navigateTree(targetId: string): Promise<unknown>;
}

export async function revertPiConversation(input: {
  entryId: string;
  navigator: PiRewindNavigator;
}): Promise<void> {
  const targetId = input.entryId.trim();
  if (!targetId) {
    throw new Error("Pi rewind requires a user message id");
  }
  await input.navigator.navigateTree(targetId);
}

export const PI_REVERT_TOKEN_PREFIX = "pi-revert:";
const REVERT_TOKEN_ENTROPY_BYTES = 32;
const REVERT_TOKEN_BODY_PATTERN = "[A-Za-z0-9_-]{43}";
export const PI_REVERT_TOKEN_RE = new RegExp(`^${PI_REVERT_TOKEN_PREFIX}${REVERT_TOKEN_BODY_PATTERN}$`);
const MAX_REVERT_TOKENS = 200;

export function mintRevertToken(): string {
  return `${PI_REVERT_TOKEN_PREFIX}${randomBytes(REVERT_TOKEN_ENTROPY_BYTES).toString("base64url")}`;
}

export function isRevertToken(value: unknown): value is string {
  return typeof value === "string" && PI_REVERT_TOKEN_RE.test(value);
}

export class PiRevertTokens {
  // Keyed both ways so re-minting an already-known entry id is idempotent:
  // replay mints one token per historical user message (history budgets
  // allow far more messages than the FIFO cap), and without this the tokens
  // emitted for the earliest messages would be evicted while replay is
  // still running. The cap therefore bounds distinct entries, not mints.
  private readonly tokenToEntry = new Map<string, string>();
  private readonly entryToToken = new Map<string, string>();

  mint(entryId: string): string {
    const existing = this.entryToToken.get(entryId);
    if (existing) {
      return existing;
    }
    let token = mintRevertToken();
    while (this.tokenToEntry.has(token)) {
      token = mintRevertToken();
    }
    this.tokenToEntry.set(token, entryId);
    this.entryToToken.set(entryId, token);
    while (this.tokenToEntry.size > MAX_REVERT_TOKENS) {
      const oldest = this.tokenToEntry.keys().next();
      if (oldest.done) {
        break;
      }
      const evictedEntry = this.tokenToEntry.get(oldest.value);
      this.tokenToEntry.delete(oldest.value);
      if (evictedEntry !== undefined && this.entryToToken.get(evictedEntry) === oldest.value) {
        this.entryToToken.delete(evictedEntry);
      }
    }
    return token;
  }

  resolve(token: string): string | undefined {
    return this.tokenToEntry.get(token);
  }

  clear(): void {
    this.tokenToEntry.clear();
    this.entryToToken.clear();
  }

  get size(): number {
    return this.tokenToEntry.size;
  }
}

export interface PiCapturedEntry {
  id: string;
  parentId: string | null;
  text: string;
}

export function parseExtensionMarkerPayload(
  message: string,
  marker: string,
): Record<string, unknown> | null {
  const prefix = `${marker} `;
  if (!message.startsWith(prefix)) {
    return null;
  }
  try {
    const parsed = JSON.parse(message.slice(prefix.length)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseCapturedEntries(value: unknown): PiCapturedEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): PiCapturedEntry[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = optionalString(entry.id)?.trim();
    const text = optionalString(entry.text);
    if (!id || text === undefined) {
      return [];
    }
    const parentId = entry.parentId === null ? null : optionalString(entry.parentId)?.trim();
    return [
      {
        id,
        parentId: parentId || null,
        text,
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
