import type { ChatMessage, ImageAttachment } from "../types";

/** In-progress edit for one user message. Kept outside React state so an
 *  unexpected remount of the bubble cannot discard the user's typed text. */
export interface MessageEditDraft {
  text: string;
  images: ImageAttachment[];
  minWidth?: number;
}

const messageEditDrafts = new Map<string, MessageEditDraft>();

/**
 * Candidate draft keys for a row.
 *
 * Keys are anchored to what identity the row has at draft time, but the anchor
 * must stay valid while an edit is open. Row ids and sequences are the durable
 * targets for sending, but not for draft storage: a local row can gain an id
 * (done event), renumber (rebase), or be replaced by a server copy with a new
 * timestamp (poll reload) while the editor stays open — and any key built from
 * those changes would orphan the draft mid-typing.
 *
 * So the primary key is the weak anchor — absolute index + role. History is
 * append/truncate only, so a row's absolute index is stable while the row
 * exists, across identity changes and reloads alike. The timestamp key is the
 * fallback for rows without an index (pre-window data).
 */
export function getMessageEditDraftKeys(
  chatId: string | undefined,
  message: ChatMessage,
  messageIndex: number | null | undefined
): string[] {
  if (!chatId) return [];
  const keys: string[] = [];
  if (messageIndex != null) {
    keys.push(`${chatId}:pos:${messageIndex}:${message.role}`);
  }
  keys.push(`${chatId}:ts:${message.timestamp}:${message.role}`);
  return keys;
}

/**
 * Look up the draft for a row. Returns the storage key as well, which is also
 * where a fresh draft for this row must be written.
 */
export function pickMessageEditDraft(
  chatId: string | undefined,
  message: ChatMessage,
  messageIndex: number | null | undefined
): { key: string; draft?: MessageEditDraft } | null {
  const keys = getMessageEditDraftKeys(chatId, message, messageIndex);
  if (keys.length === 0) return null;
  for (const key of keys) {
    const draft = messageEditDrafts.get(key);
    if (draft) return { key, draft };
  }
  return { key: keys[0] };
}

/** Store a draft for a row under its stable key. */
export function stashMessageEditDraft(
  chatId: string | undefined,
  message: ChatMessage,
  messageIndex: number | null | undefined,
  draft: MessageEditDraft
): void {
  const keys = getMessageEditDraftKeys(chatId, message, messageIndex);
  if (keys.length === 0) return;
  messageEditDrafts.set(keys[0], draft);
}

export function getMessageEditDraft(key: string | null | undefined): MessageEditDraft | undefined {
  return key ? messageEditDrafts.get(key) : undefined;
}

export function setMessageEditDraft(key: string, draft: MessageEditDraft): void {
  messageEditDrafts.set(key, draft);
}

export function deleteMessageEditDraft(key: string | null | undefined): void {
  if (key) messageEditDrafts.delete(key);
}
