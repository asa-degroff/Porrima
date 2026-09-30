/**
 * Shared query-string parsing for the message-window routes.
 *
 * The window cap lives here rather than in a route so `/api/chats/:id`,
 * `/api/chats/:id/messages` and `/api/chat/status/:chatId?includeWindow=1`
 * cannot drift apart on how large a window a client may request.
 */

/** Upper bound on a single message-window request, matching getChatMessageWindow. */
export const MAX_MESSAGE_WINDOW_LIMIT = 1000;

/** Default window size used by the chat-load path. */
export const DEFAULT_MESSAGE_WINDOW_LIMIT = 200;

export function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parse a `messageLimit` query param, clamped to MAX_MESSAGE_WINDOW_LIMIT. */
export function parseMessageLimit(value: unknown): number | undefined {
  const parsed = parsePositiveInt(value);
  return parsed ? Math.min(parsed, MAX_MESSAGE_WINDOW_LIMIT) : undefined;
}

/**
 * Resolve a `messageLimit` query param, falling back to the default when it is
 * absent or unparseable.
 */
export function resolveMessageLimit(value: unknown): number {
  return parseMessageLimit(value) ?? DEFAULT_MESSAGE_WINDOW_LIMIT;
}
