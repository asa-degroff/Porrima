import type { ChatMessage } from "../types.js";

/**
 * Pending "next user context" rows: hidden system rows that the wire merges
 * into the FOLLOWING user message (memory deltas, passive recalls) and that
 * replay reconstructs by merging the persisted system row into the persisted
 * user row. Keep the wire build and the row table in lockstep:
 *
 * - send/edit collect these rows via `splitNextUserContext`, exclude them from
 *   the replayed `persistedHistory`, and merge their contents into the user
 *   message they build for the wire.
 * - `chatMessagesToPiMessages` walks the same rows in order and merges every
 *   preceding system row into the next user message.
 * - the storage rebase uses `isPendingNextUserContextMessage` to avoid
 *   splicing an orphaned context row in front of a user row it was never
 *   attached to (see `rebaseMessageArray`).
 *
 * A row is NOT pending when it has no text content — an empty row cannot
 * contribute tokens to either side, so excluding it would only shift merge
 * boundaries.
 */
export function isPendingNextUserContextMessage(
  message: ChatMessage | undefined,
): message is ChatMessage {
  return (
    !!message &&
    message.role === "system" &&
    (message._mergeIntoNextUserMessage === true || message._isPassiveMemoryRecall === true) &&
    typeof message.content === "string" &&
    message.content.trim().length > 0
  );
}

/**
 * Split the tail of `messages` before the current user prompt into
 * (a) the persisted history prefix that the model re-prefixes, and (b) the
 * pending context strings that must be merged into the current user message on
 * the wire.
 *
 * The delta row this turn just persisted matches by content (`memoryDeltaContext`)
 * even for rows written before the structural marker existed; everything else
 * is recognized by `isPendingNextUserContextMessage`. Contexts are returned
 * oldest-first, matching the order in which `chatMessagesToPiMessages` merges
 * preceding system rows into the next user message.
 */
export function splitNextUserContext(opts: {
  messages: ChatMessage[];
  currentUserIndex: number;
  memoryDeltaContext: string;
}): { persistedHistoryEnd: number; systemContexts: string[] } {
  let persistedHistoryEnd = opts.currentUserIndex;
  const systemContexts: string[] = [];

  const takeContextRow = (row: ChatMessage) => {
    systemContexts.unshift(row.content);
    persistedHistoryEnd--;
  };

  const rowBeforeUser = opts.messages[persistedHistoryEnd - 1];
  if (
    opts.memoryDeltaContext &&
    rowBeforeUser?.role === "system" &&
    rowBeforeUser.content === opts.memoryDeltaContext
  ) {
    takeContextRow(rowBeforeUser);
  }

  while (persistedHistoryEnd > 0 && isPendingNextUserContextMessage(opts.messages[persistedHistoryEnd - 1])) {
    takeContextRow(opts.messages[persistedHistoryEnd - 1]);
  }

  return { persistedHistoryEnd, systemContexts };
}
